#!/usr/bin/env node
/** Edit the genuine app recording using capture.mjs's timestamped keep segments. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PROMO_DURATION_SECONDS, PROMO_OUTPUT_DIR, PROMO_VIEWPORT } from './utils.mjs';

const DEFAULT_FRAME_RATE = 30;
const DEFAULT_MAX_SPEED = 1.75;
const LOUDNESS_FILTER = 'loudnorm=I=-23:TP=-3:LRA=7';
const MAX_DISSOLVE_SECONDS = 0.18;

function run(command, args, { captureStderr = false } = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`${command} failed: ${result.error?.message ?? result.stderr?.slice(-4000) ?? result.status}`
		);
	}
	return (captureStderr ? result.stderr : result.stdout).trim();
}

function loudnessReport(output) {
	return JSON.parse(output.slice(output.lastIndexOf('{'), output.lastIndexOf('}') + 1));
}

function probe(path) {
	return JSON.parse(
		run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])
	);
}

function finite(value, label) {
	assert(Number.isFinite(value), `${label} must be a finite number`);
	return value;
}

function keepIntervals(segment, cuts, offset) {
	let intervals = [{ start: segment.start, end: segment.end }];
	for (const cut of cuts) {
		intervals = intervals.flatMap((interval) => {
			if (cut.end <= interval.start || cut.start >= interval.end) return [interval];
			const remaining = [];
			if (cut.start > interval.start) remaining.push({ start: interval.start, end: cut.start });
			if (cut.end < interval.end) remaining.push({ start: cut.end, end: interval.end });
			return remaining;
		});
	}
	return intervals.map(({ start, end }) => ({ start: start + offset, end: end + offset }));
}

function buildEdit(timeline, duration, rawDuration) {
	assert.equal(timeline.version, 1, 'Expected capture timeline version 1');
	assert(timeline.segments?.length > 0, 'No real recording segments were supplied');
	const frameRate = finite(timeline.frameRate ?? DEFAULT_FRAME_RATE, 'frameRate');
	assert([24, 25, 30, 50, 60].includes(frameRate), 'Expected a supported native frame rate');
	const offset = finite(timeline.recordingOffsetSeconds ?? 0, 'recordingOffsetSeconds');
	const cuts = timeline.cuts ?? [];
	for (const cut of cuts) {
		assert(finite(cut.end, 'cut.end') > finite(cut.start, 'cut.start'), 'Cut must have length');
	}
	let outputStart = 0;
	const segments = timeline.segments.map((segment, index) => {
		const targetDuration = finite(segment.targetDuration, `${segment.name}.targetDuration`);
		const requestedTransition = finite(
			segment.transitionOutSeconds ?? 0,
			`${segment.name}.transitionOutSeconds`
		);
		assert(
			requestedTransition >= 0 && requestedTransition <= MAX_DISSOLVE_SECONDS,
			'Dissolves must be restrained and shorter than 180ms'
		);
		const transitionOutSeconds =
			index < timeline.segments.length - 1
				? Math.round(requestedTransition * frameRate) / frameRate
				: 0;
		const holdAtEnd = finite(segment.holdAtEnd ?? 0, `${segment.name}.holdAtEnd`);
		const holds = (segment.holds ?? []).map((hold) => ({
			at: finite(hold.at, `${segment.name}.hold.at`) + offset,
			duration: finite(hold.duration, `${segment.name}.hold.duration`)
		}));
		const heldDuration = holds.reduce((sum, hold) => sum + hold.duration, 0);
		assert(
			targetDuration > holdAtEnd + heldDuration && holdAtEnd >= 0,
			'Hold must fit in its segment'
		);
		assert(
			finite(segment.end, 'segment.end') > finite(segment.start, 'segment.start'),
			'Recorded segment must have length'
		);
		const intervals = keepIntervals(segment, cuts, offset).filter(
			(interval) => interval.end - interval.start >= 1 / frameRate
		);
		assert(intervals.length > 0, `${segment.name} was completely removed by cuts`);
		for (const interval of intervals) {
			assert(interval.start >= 0, 'Recording starts before the first real frame');
			assert(interval.end <= rawDuration + 0.05, 'Timeline extends past the raw recording');
		}
		for (const hold of holds) {
			assert(
				hold.duration > 0 &&
					intervals.some((interval) => hold.at > interval.start && hold.at <= interval.end),
				'Reading holds must use a real frame retained by the edit'
			);
		}
		const sourceDuration = intervals.reduce(
			(sum, interval) => sum + interval.end - interval.start,
			0
		);
		const speed = Math.max(1, sourceDuration / (targetDuration - holdAtEnd - heldDuration));
		assert(
			speed <= (segment.maxSpeed ?? DEFAULT_MAX_SPEED),
			`${segment.name} needs ${speed.toFixed(2)}x speed; review its cuts or target duration`
		);
		const result = {
			name: segment.name,
			outputStart,
			targetDuration,
			transitionOutSeconds,
			renderDuration: targetDuration + transitionOutSeconds,
			sourceDuration,
			speed,
			padDuration: targetDuration + transitionOutSeconds - sourceDuration / speed - heldDuration,
			holds,
			intervals
		};
		outputStart += targetDuration;
		return result;
	});
	assert(
		Math.abs(outputStart - duration) < 0.001,
		`Segment targets total ${outputStart}, not ${duration}`
	);
	const events = (timeline.events ?? []).flatMap((event) => {
		const at = event.at + offset;
		for (const segment of segments) {
			let elapsed = 0;
			for (const interval of segment.intervals) {
				if (at >= interval.start && at < interval.end) {
					return [
						{
							...event,
							at:
								segment.outputStart +
								(elapsed + at - interval.start) / segment.speed +
								segment.holds
									.filter((hold) => hold.at <= at)
									.reduce((sum, hold) => sum + hold.duration, 0)
						}
					];
				}
				elapsed += interval.end - interval.start;
			}
		}
		return [];
	});
	return { duration, frameRate, segments, events };
}

function videoFilters(edit, width, height, sourceContent) {
	const filters = [];
	const frameRate = edit.frameRate;
	for (const [segmentIndex, segment] of edit.segments.entries()) {
		const inputs = segment.intervals.flatMap((interval, intervalIndex) => {
			const holds = segment.holds
				.filter((hold) => hold.at > interval.start && hold.at <= interval.end)
				.sort((a, b) => a.at - b.at);
			const stops = [...holds, { at: interval.end, duration: 0 }];
			let start = interval.start;
			return stops.flatMap((stop, stopIndex) => {
				if (stop.at <= start) return [];
				const label = `part${segmentIndex}_${intervalIndex}_${stopIndex}`;
				filters.push(
					`[0:v]trim=start=${start}:end=${stop.at},setpts=(PTS-STARTPTS)/${segment.speed},fps=${frameRate},` +
						`tpad=stop_mode=clone:stop_duration=${stop.duration + 0.05},` +
						`trim=duration=${(stop.at - start) / segment.speed + stop.duration}[${label}]`
				);
				start = stop.at;
				return [`[${label}]`];
			});
		});
		filters.push(
			`${inputs.join('')}concat=n=${inputs.length}:v=1:a=0,` +
				`fps=${frameRate},` +
				`tpad=stop_mode=clone:stop_duration=${Math.max(0, segment.padDuration) + 0.1},` +
				`trim=duration=${segment.renderDuration},setpts=PTS-STARTPTS,settb=1/${frameRate},` +
				`crop=${sourceContent.width}:${sourceContent.height}:${sourceContent.x ?? 0}:${sourceContent.y ?? 0},` +
				`scale=${width}:${height}:flags=lanczos,setsar=1,format=yuv420p[segment${segmentIndex}]`
		);
	}
	let joined = 'segment0';
	for (let index = 1; index < edit.segments.length; index++) {
		const previous = edit.segments[index - 1];
		const label = index === edit.segments.length - 1 ? 'video' : `joined${index}`;
		filters.push(
			previous.transitionOutSeconds > 0
				? `[${joined}][segment${index}]xfade=transition=fade:duration=${previous.transitionOutSeconds}:offset=${edit.segments[index].outputStart}[${label}]`
				: `[${joined}][segment${index}]concat=n=2:v=1:a=0,fps=${frameRate},settb=1/${frameRate}[${label}]`
		);
		joined = label;
	}
	if (edit.segments.length === 1) filters.push('[segment0]null[video]');
	return filters.join(';\n');
}

function selfTest() {
	const edit = buildEdit(
		{
			version: 1,
			recordingOffsetSeconds: 0.2,
			segments: [
				{
					name: 'ask',
					start: 1,
					end: 13,
					targetDuration: 10,
					holdAtEnd: 2,
					transitionOutSeconds: 0.14
				},
				{ name: 'finish', start: 13, end: 17, targetDuration: 6 }
			],
			cuts: [{ start: 3, end: 7, reason: 'Model wait' }],
			events: [
				{ at: 2, kind: 'tap' },
				{ at: 5, kind: 'tap' },
				{ at: 15, kind: 'tap' }
			]
		},
		16,
		18
	);
	assert(Math.abs(edit.segments[0].sourceDuration - 8) < 0.001);
	assert(Math.abs(edit.segments[0].padDuration - (2 + 4 / DEFAULT_FRAME_RATE)) < 0.001);
	assert.equal(edit.segments[0].renderDuration, 10 + 4 / DEFAULT_FRAME_RATE);
	assert.equal(edit.segments[1].outputStart, 10);
	assert.equal(edit.segments[1].transitionOutSeconds, 0);
	assert.equal(edit.events.length, 2);
	assert(Math.abs(edit.events[0].at - 1) < 0.001);
	assert(Math.abs(edit.events[1].at - 12) < 0.001);
	assert(
		videoFilters(
			edit,
			PROMO_VIEWPORT.width * 2,
			PROMO_VIEWPORT.height * 2,
			PROMO_VIEWPORT
		).includes(`crop=${PROMO_VIEWPORT.width}:${PROMO_VIEWPORT.height}:0:0,scale=`)
	);
	assert.equal(loudnessReport('log\n{"input_i":"-23"}\ntrailing log').input_i, '-23');
	assert(videoFilters(edit, 780, 1688, PROMO_VIEWPORT).includes(':offset=10[video]'));
	const readingEdit = buildEdit(
		{
			version: 1,
			segments: [
				{ name: 'review', start: 0, end: 4, targetDuration: 6, holds: [{ at: 2, duration: 2 }] }
			],
			events: [{ kind: 'tap', at: 3 }]
		},
		6,
		4
	);
	assert.equal(readingEdit.events[0].at, 5);
	assert.equal(readingEdit.segments[0].padDuration, 0);
	assert.equal(readingEdit.segments[0].speed, 1);
	const nativeContent = { width: PROMO_VIEWPORT.width * 2, height: PROMO_VIEWPORT.height * 2 };
	const nativeEdit = buildEdit(
		{
			version: 1,
			frameRate: 60,
			segments: [{ name: 'native', start: 0, end: 1, targetDuration: 1 }]
		},
		1,
		1
	);
	const nativeFilters = videoFilters(
		nativeEdit,
		nativeContent.width,
		nativeContent.height,
		nativeContent
	);
	assert.equal(nativeEdit.frameRate, 60);
	assert(nativeFilters.includes(`crop=${nativeContent.width}:${nativeContent.height}:0:0`));
	assert(nativeFilters.includes('fps=60'));
	assert(!nativeFilters.includes(`crop=${PROMO_VIEWPORT.width}:${PROMO_VIEWPORT.height}`));
	console.log('Promo edit timing checks passed.');
}

async function main() {
	const { values } = parseArgs({
		options: {
			timeline: { type: 'string', default: resolve(PROMO_OUTPUT_DIR, 'timeline.json') },
			output: { type: 'string', default: PROMO_OUTPUT_DIR },
			duration: { type: 'string', default: String(PROMO_DURATION_SECONDS) },
			width: { type: 'string', default: String(PROMO_VIEWPORT.width * 2) },
			'validate-only': { type: 'boolean', default: false },
			'self-test': { type: 'boolean', default: false }
		}
	});
	if (values['self-test']) return selfTest();
	const duration = Number(values.duration);
	assert(duration >= 25 && duration <= 60, 'Promotional edit must be 25–60 seconds');
	const timelinePath = resolve(values.timeline);
	const timeline = JSON.parse(await readFile(timelinePath, 'utf8'));
	const rawPath = resolve(dirname(timelinePath), timeline.rawPath);
	const rawMetadata = probe(rawPath);
	const sourceVideo = rawMetadata.streams.find((stream) => stream.codec_type === 'video');
	assert(
		sourceVideo?.width > 0 && sourceVideo.height > sourceVideo.width,
		'Expected portrait footage'
	);
	const viewport = timeline.viewport;
	// Native CDP masters specify physical pixels separately from the CSS viewport.
	// Legacy Playwright recordings retain their CSS-sized content in the canvas corner.
	const sourceContent = timeline.sourceContent ?? viewport;
	assert(
		viewport?.width > 0 &&
			viewport.height > viewport.width &&
			sourceContent.width > 0 &&
			sourceContent.height > sourceContent.width &&
			sourceContent.width + (sourceContent.x ?? 0) <= sourceVideo.width &&
			sourceContent.height + (sourceContent.y ?? 0) <= sourceVideo.height,
		'Expected actual app content contained in the recording canvas'
	);
	const edit = buildEdit(timeline, duration, Number(rawMetadata.format.duration));
	const width = Number(values.width);
	assert(
		width >= sourceContent.width && width % 2 === 0,
		'Output width must be even and preserve detail'
	);
	const height = Math.round((width * sourceContent.height) / sourceContent.width / 2) * 2;
	if (values['validate-only']) {
		console.log(JSON.stringify({ ...edit, viewport, sourceContent, width, height }, null, 2));
		return;
	}
	const output = resolve(values.output);
	await mkdir(output, { recursive: true });
	const recipePhoto = JSON.parse(await readFile(resolve(output, 'photo-credit.json'), 'utf8'));
	const editPath = resolve(output, 'edit.json');
	const eventsPath = resolve(output, 'edit-events.json');
	const filtersPath = resolve(output, 'edit-filters.txt');
	const cleanPath = resolve(output, 'my-kitchen-clean.mp4');
	const musicPath = resolve(output, 'original-score.wav');
	const finalPath = resolve(output, 'my-kitchen-promo.mp4');
	const contactPath = resolve(output, 'contact-sheet.jpg');
	const posterPath = resolve(output, 'poster.png');
	await writeFile(editPath, JSON.stringify(edit, null, 2) + '\n');
	const scoreEvents = edit.events.filter(
		(event) => !timeline.soundAccents || timeline.soundAccents.includes(event.label)
	);
	await writeFile(eventsPath, JSON.stringify(scoreEvents, null, 2) + '\n');
	await writeFile(filtersPath, videoFilters(edit, width, height, sourceContent));
	console.log(`Editing ${edit.segments.length} genuine app segments to ${duration} seconds.`);
	run('ffmpeg', [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-i',
		rawPath,
		'-filter_complex_script',
		filtersPath,
		'-map',
		'[video]',
		'-an',
		'-c:v',
		'libx264',
		'-preset',
		'slow',
		'-crf',
		'18',
		'-profile:v',
		'high',
		'-pix_fmt',
		'yuv420p',
		'-r',
		String(edit.frameRate),
		'-t',
		String(duration),
		'-movflags',
		'+faststart',
		'-map_metadata',
		'-1',
		cleanPath
	]);
	console.log('Composing original instrumental and restrained interaction sounds.');
	const scoreReport = JSON.parse(
		run(process.env.PROMO_PYTHON ?? 'python', [
			resolve(import.meta.dirname, 'score.py'),
			'--output',
			musicPath,
			'--events',
			eventsPath,
			'--duration',
			String(duration),
			'--mood',
			timeline.musicMood ?? 'quiet'
		])
	);
	const measuredAudio = loudnessReport(
		run(
			'ffmpeg',
			[
				'-hide_banner',
				'-i',
				musicPath,
				'-af',
				`${LOUDNESS_FILTER}:print_format=json`,
				'-f',
				'null',
				'-'
			],
			{ captureStderr: true }
		)
	);
	const finalLoudness = loudnessReport(
		run(
			'ffmpeg',
			[
				'-hide_banner',
				'-y',
				'-i',
				cleanPath,
				'-i',
				musicPath,
				'-map',
				'0:v:0',
				'-map',
				'1:a:0',
				'-c:v',
				'copy',
				'-c:a',
				'aac',
				'-af',
				`${LOUDNESS_FILTER}:measured_I=${measuredAudio.input_i}:measured_LRA=${measuredAudio.input_lra}:measured_TP=${measuredAudio.input_tp}:measured_thresh=${measuredAudio.input_thresh}:offset=${measuredAudio.target_offset}:linear=true:print_format=json`,
				'-b:a',
				'160k',
				'-ar',
				'48000',
				'-t',
				String(duration),
				'-movflags',
				'+faststart',
				'-map_metadata',
				'-1',
				finalPath
			],
			{ captureStderr: true }
		)
	);
	run('ffmpeg', [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-i',
		finalPath,
		'-vf',
		`fps=12/${duration},scale=195:-2,tile=6x2:padding=8:margin=8:color=white`,
		'-frames:v',
		'1',
		'-q:v',
		'2',
		contactPath
	]);
	const photoEvent = edit.events.find((event) =>
		/recipe.?photo|photo.?settled/i.test(event.label ?? '')
	);
	const posterAt = photoEvent?.at ?? Math.min(1, duration / 4);
	run('ffmpeg', [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-ss',
		String(posterAt),
		'-i',
		finalPath,
		'-frames:v',
		'1',
		posterPath
	]);
	const finalMetadata = probe(finalPath);
	const video = finalMetadata.streams.find((stream) => stream.codec_type === 'video');
	const audio = finalMetadata.streams.find((stream) => stream.codec_type === 'audio');
	assert.equal(video.codec_name, 'h264');
	assert.equal(video.pix_fmt, 'yuv420p');
	assert.equal(audio?.codec_name, 'aac');
	assert.equal(video.width, width);
	assert.equal(video.height, height);
	assert(
		Math.abs(Number(finalMetadata.format.duration) - duration) < 0.1,
		'Export duration differs'
	);
	const metadata = {
		rawRecording: rawPath,
		cleanEdit: cleanPath,
		finalVideo: finalPath,
		contactSheet: contactPath,
		poster: posterPath,
		title: timeline.title ?? 'My Kitchen',
		variant: timeline.variant ?? null,
		duration: Number(finalMetadata.format.duration),
		width,
		height,
		viewport,
		sourceContent,
		sourceCanvas: { width: sourceVideo.width, height: sourceVideo.height },
		sourceFrameRate: sourceVideo.avg_frame_rate,
		capture: timeline.capture ?? null,
		editorialNotes: timeline.editorialNotes ?? null,
		resize: width === sourceContent.width ? 'None' : 'Lanczos upscale of the actual app recording',
		recipePhoto,
		frameRate: video.avg_frame_rate,
		videoCodec: video.codec_name,
		audioCodec: audio.codec_name,
		bytes: Number(finalMetadata.format.size),
		music: {
			...scoreReport,
			mood: timeline.musicMood ?? 'quiet',
			interactionAccents: scoreEvents.filter((event) => ['tap', 'type'].includes(event.kind))
				.length,
			finalLoudness,
			license: 'Original composition; no third-party samples or recording.'
		},
		visuals:
			'Real app recording with restrained tap indicators; no added captions, narration, or generated imagery.',
		cuts: timeline.cuts ?? []
	};
	await writeFile(resolve(output, 'export.json'), JSON.stringify(metadata, null, 2) + '\n');
	console.log(`${basename(finalPath)} exported: ${width} × ${height}, ${duration}s, H.264/AAC.`);
}

await main();
