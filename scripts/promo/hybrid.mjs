#!/usr/bin/env node
/** Approved generated food scenes plus the exact real app; disclose the actual source type. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PROMO_OUTPUT_DIR, PROMO_VIEWPORT } from './utils.mjs';

const AI_ROOT = resolve(PROMO_OUTPUT_DIR, 'ai-version');
const OUTPUT_ROOT = resolve(AI_ROOT, 'render');
const MOTION_OUTPUT_ROOT = resolve(AI_ROOT, 'flow-render');
const MASTER_ROOT = resolve(AI_ROOT, 'meatballs-master');
const FRAME_RATE = 60;
const WIDTH = PROMO_VIEWPORT.width * 2;
const HEIGHT = PROMO_VIEWPORT.height * 2;
const ANSWER_SECONDS = 8;
const METHOD = 'ai_stills_with_editorial_camera_motion_and_real_app';
const DISCLOSURE = 'Animated-still review draft with real app footage; no generated video motion.';
const MOTION_METHOD = 'ai_generated_motion_clips_with_real_app';
const MOTION_DISCLOSURE = 'AI-generated cinematic food clips intercut with the real app recording.';

function run(program, args, stderr = false) {
	const result = spawnSync(program, args, {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true
	});
	assert(
		!result.error && result.status === 0,
		`${program} failed: ${result.error?.message ?? result.stderr?.slice(-3000)}`
	);
	return (stderr ? result.stderr : result.stdout).trim();
}

function jsonReport(output) {
	return JSON.parse(output.slice(output.lastIndexOf('{'), output.lastIndexOf('}') + 1));
}

function serialize(value) {
	return (
		JSON.stringify(value, (_key, item) => (item instanceof RegExp ? String(item) : item), 2) + '\n'
	);
}

function within(parent, path) {
	const child = relative(parent, path);
	return !child.startsWith('..') && !isAbsolute(child);
}

function marker(master, label) {
	const event = master.events.find((item) => item.label === label);
	assert(event && Number.isFinite(event.at), `Missing genuine capture marker: ${label}`);
	return event.at;
}

function tap(master, pattern) {
	const event = master.events.find((item) => item.kind === 'tap' && pattern.test(item.label));
	assert(event && Number.isFinite(event.at), `Missing genuine app action: ${pattern}`);
	return event.at;
}

function frames(seconds) {
	return Math.round(seconds * FRAME_RATE);
}

function realShot(name, seconds, windows, accentLabels = []) {
	let previousEndFrame = 0;
	const parts = windows.map(([start, end]) => {
		const startFrame = Math.max(frames(start), previousEndFrame);
		const endFrame = frames(end);
		assert(startFrame >= 0 && endFrame > startFrame, `${name} needs actual recorded frames`);
		previousEndFrame = endFrame;
		return { startFrame, endFrame, durationFrames: endFrame - startFrame };
	});
	const sourceFrames = parts.reduce((sum, part) => sum + part.durationFrames, 0);
	// Extend a scene if its honest action needs more time; never speed up the UI.
	const targetFrames = Math.max(frames(seconds), sourceFrames);
	return {
		name,
		kind: 'real_app_recording',
		durationFrames: targetFrames,
		readingHoldFrames: targetFrames - sourceFrames,
		parts,
		accentLabels
	};
}

function stillShot(name, seconds, asset, push) {
	assert(push >= 0.01 && push <= 0.03);
	return { name, kind: 'ai_generated_still', durationFrames: frames(seconds), asset, push };
}

function foodShot(name, seconds, asset, push, motionMode) {
	return motionMode
		? {
				name,
				kind: 'ai_generated_video',
				durationFrames: frames(seconds),
				asset,
				sourceStartSeconds: 0
			}
		: stillShot(name, seconds, asset, push);
}

function makePlan(master, assets, motionMode = false) {
	const today = marker(master, 'todaySettled');
	const photo = marker(master, 'photoSettled');
	const missing = marker(master, 'missingSettled');
	const groceryProof = marker(master, 'groceryProof');
	const questionSent = marker(master, 'questionSent');
	const answer = marker(master, 'answerReadable');
	const review = marker(master, 'substitutionReviewed');
	const success = marker(master, 'successReadable');
	const save = tap(master, /Save .*for the next shop/i);
	const chooseSubstitute = tap(master, /Choose .*instead/i);
	const finish = tap(master, /^Finish cooking$/i);
	const confirm = tap(master, /Confirm the pantry update/i);
	const returnToCooking = tap(master, /Return to cooking/i);
	assert(
		returnToCooking >= answer + ANSWER_SECONDS,
		'Master must show the full answer for eight seconds'
	);
	const planEnd = Math.min(today + 2, tap(master, /Open today/i) - 0.04);
	const shots = [
		foodShot('ingredients', 3, assets.ingredients, 0.015, motionMode),
		realShot('tonights-plan', 2, [[Math.max(today - 0.15, 0), planEnd]]),
		realShot('recipe-and-shortage', 2.5, [
			[photo, photo + 1],
			[missing, missing + 1.5]
		]),
		foodShot('tonights-substitute', 2, assets.substitute, 0.02, motionMode),
		realShot(
			'manual-grocery-item',
			3,
			[
				[save - 1.6, save + 0.3],
				[groceryProof, groceryProof + 1.1]
			],
			[/Save .*for the next shop/i]
		),
		realShot(
			'genuine-question-and-answer',
			10,
			[
				[questionSent - 1.35, questionSent + 0.65],
				[answer, answer + ANSWER_SECONDS]
			],
			[/Send the question/i]
		),
		realShot(
			'actual-substitution-and-confirmation',
			5.5,
			[
				[finish - 0.25, finish + 0.25],
				[chooseSubstitute - 0.1, review + 2],
				[confirm - 0.1, confirm + 0.3]
			],
			[/Confirm the pantry update/i]
		),
		realShot('pantry-update-succeeded', 2, [[success, success + 2]]),
		foodShot('dinner-ready', 3, assets.dinner, 0.025, motionMode)
	];
	let elapsedFrames = 0;
	for (const shot of shots) {
		shot.outputStartFrame = elapsedFrames;
		shot.outputStart = elapsedFrames / FRAME_RATE;
		shot.duration = shot.durationFrames / FRAME_RATE;
		elapsedFrames += shot.durationFrames;
	}
	const duration = elapsedFrames / FRAME_RATE;
	assert(
		duration >= 32 && duration <= 35,
		`Honest hybrid duration ${duration}s needs editorial review`
	);
	return {
		method: motionMode ? MOTION_METHOD : METHOD,
		disclosure: motionMode ? MOTION_DISCLOSURE : DISCLOSURE,
		frameRate: FRAME_RATE,
		width: WIDTH,
		height: HEIGHT,
		duration,
		shots
	};
}

function filtersFor(plan) {
	const filters = [];
	let imageInput = 1;
	for (const [index, shot] of plan.shots.entries()) {
		if (shot.kind === 'ai_generated_video') {
			filters.push(
				`[${imageInput}:v]trim=start=${shot.sourceStartSeconds}:duration=${shot.duration},setpts=PTS-STARTPTS,` +
					`scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,` +
					`crop=${WIDTH}:${HEIGHT},fps=${FRAME_RATE},trim=end_frame=${shot.durationFrames},` +
					`setpts=PTS-STARTPTS,setsar=1,format=yuv420p[shot${index}]`
			);
			imageInput++;
			continue;
		}
		if (shot.kind === 'ai_generated_still') {
			const progress = `(0.5-0.5*cos(PI*on/${shot.durationFrames - 1}))`;
			filters.push(
				`[${imageInput}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
					`crop=${WIDTH}:${HEIGHT},scale=${WIDTH * 2}:${HEIGHT * 2}:flags=lanczos,` +
					`zoompan=z='1+${shot.push}*${progress}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':` +
					`d=${shot.durationFrames}:s=${WIDTH}x${HEIGHT}:fps=${FRAME_RATE},` +
					`trim=end_frame=${shot.durationFrames},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[shot${index}]`
			);
			imageInput++;
			continue;
		}
		const inputs = shot.parts.map((part, partIndex) => {
			const label = `app${index}_${partIndex}`;
			filters.push(
				`[0:v]trim=start_frame=${part.startFrame}:end_frame=${part.endFrame},setpts=PTS-STARTPTS[${label}]`
			);
			return `[${label}]`;
		});
		filters.push(
			`${inputs.join('')}concat=n=${inputs.length}:v=1:a=0,fps=${FRAME_RATE},` +
				`tpad=stop_mode=clone:stop_duration=${shot.readingHoldFrames / FRAME_RATE + 0.05},` +
				`trim=end_frame=${shot.durationFrames},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[shot${index}]`
		);
	}
	filters.push(
		`${plan.shots.map((_, index) => `[shot${index}]`).join('')}concat=n=${plan.shots.length}:v=1:a=0[video]`
	);
	return filters.join(';\n');
}

function accentsFor(master, plan) {
	const accents = [];
	for (const shot of plan.shots.filter((item) => item.kind === 'real_app_recording')) {
		for (const event of master.events) {
			if (event.kind !== 'tap' || !shot.accentLabels.some((pattern) => pattern.test(event.label)))
				continue;
			const sourceFrame = frames(event.at);
			let elapsed = 0;
			for (const part of shot.parts) {
				if (sourceFrame >= part.startFrame && sourceFrame < part.endFrame) {
					accents.push({
						kind: 'tap',
						label: event.label,
						at: (shot.outputStartFrame + elapsed + sourceFrame - part.startFrame) / FRAME_RATE
					});
					break;
				}
				elapsed += part.durationFrames;
			}
		}
	}
	return accents;
}

function selfTest() {
	const shot = realShot('unchanged-ui', 1, [[2, 3.25]]);
	assert.equal(shot.durationFrames, 75);
	assert.equal(shot.readingHoldFrames, 0);
	const testPlan = { shots: [stillShot('image', 3, 'image.png', 0.02), shot] };
	const graph = filtersFor(testPlan);
	assert(graph.includes('zoompan='));
	assert(graph.includes('trim=start_frame=120:end_frame=195'));
	assert(!graph.includes('setpts=PTS/'));
	assert(within(OUTPUT_ROOT, resolve(OUTPUT_ROOT, 'review')));
	assert(!within(OUTPUT_ROOT, resolve(OUTPUT_ROOT, '..')));
	const motion = foodShot('actual-motion', 3, 'clip.mp4', 0.02, true);
	motion.duration = 3;
	const motionGraph = filtersFor({ shots: [motion] });
	assert.equal(motion.kind, 'ai_generated_video');
	assert(!motionGraph.includes('zoompan='));
	assert(!motionGraph.includes('tpad='));
	assert(motionGraph.includes('trim=start=0:duration=3'));
	assert(motionGraph.includes(`crop=${WIDTH}:${HEIGHT},fps=60`));
	console.log('Hybrid native-frame, timing, disclosure and camera checks passed.');
}

async function main() {
	const { values } = parseArgs({
		options: {
			master: { type: 'string', default: resolve(MASTER_ROOT, 'timeline.json') },
			assets: { type: 'string', default: resolve(AI_ROOT, 'assets') },
			'motion-assets': { type: 'string' },
			output: { type: 'string' },
			'approved-assets': { type: 'boolean', default: false },
			'prepare-only': { type: 'boolean', default: false },
			'self-test': { type: 'boolean', default: false }
		}
	});
	if (values['self-test']) return selfTest();
	assert(
		values['prepare-only'] || values['approved-assets'],
		'All three generated food scenes require root review before final rendering'
	);
	const masterPath = resolve(values.master);
	assert(
		within(MASTER_ROOT, masterPath),
		'Use the fresh meatballs master, preserving previous finished app cuts'
	);
	const master = JSON.parse(await readFile(masterPath, 'utf8'));
	assert.equal(master.status, 'complete');
	assert.equal(master.frameRate, FRAME_RATE);
	assert.equal(master.sourceContent.width, WIDTH);
	assert.equal(master.sourceContent.height, HEIGHT);
	assert.equal(master.recordingOffsetSeconds, 0, 'Fresh master uses the measured CDP time origin');
	const motionMode = Boolean(values['motion-assets']);
	const assetDirectory = resolve(values['motion-assets'] ?? values.assets);
	const assets = Object.fromEntries(
		['ingredients', 'substitute', 'dinner'].map((name) => [
			name,
			resolve(assetDirectory, `${name}.${motionMode ? 'mp4' : 'png'}`)
		])
	);
	const plan = makePlan(master, assets, motionMode);
	let motionGeneration = null;
	const motionSources = {};
	if (motionMode) {
		await Promise.all(Object.values(assets).map((path) => access(path)));
		motionGeneration = JSON.parse(
			await readFile(resolve(assetDirectory, 'provenance.json'), 'utf8')
		);
		assert(
			motionGeneration && Object.keys(motionGeneration).length > 0,
			'Generated motion needs provenance'
		);
		for (const [name, path] of Object.entries(assets)) {
			const info = JSON.parse(
				run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path])
			);
			const video = info.streams.find((stream) => stream.codec_type === 'video');
			assert(
				video?.width >= 720 && video.height >= 1280 && video.height > video.width,
				'Expected complete portrait food clips at 720p or better'
			);
			const shot = plan.shots.find((item) => item.asset === path);
			const start = Number(motionGeneration.editorialStarts?.[name] ?? 0);
			assert(
				Number.isFinite(start) && start >= 0,
				'Selected motion start must be a nonnegative timestamp'
			);
			shot.sourceStartSeconds = start;
			assert(
				Number(info.format.duration) >= shot.sourceStartSeconds + shot.duration,
				`${name} motion clip is shorter than its selected shot`
			);
			motionSources[name] = {
				path,
				width: video.width,
				height: video.height,
				frameRate: video.avg_frame_rate,
				duration: Number(info.format.duration),
				codec: video.codec_name
			};
		}
	}
	const outputRoot = motionMode ? MOTION_OUTPUT_ROOT : OUTPUT_ROOT;
	const output = resolve(values.output ?? outputRoot);
	assert(within(outputRoot, output), `Keep this mode's exports inside ${outputRoot}`);
	await mkdir(output, { recursive: true });
	await writeFile(resolve(output, 'edit-plan.json'), serialize(plan));
	if (values['prepare-only']) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}
	await Promise.all(Object.values(assets).map((path) => access(path)));
	const imageGeneration = JSON.parse(
		await readFile(resolve(AI_ROOT, 'image-generation.json'), 'utf8')
	);
	const rawPath = master.rawPath;
	const sourceInfo = JSON.parse(
		run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', rawPath])
	);
	const sourceVideo = sourceInfo.streams.find((stream) => stream.codec_type === 'video');
	assert.equal(sourceVideo.width, WIDTH);
	assert.equal(sourceVideo.height, HEIGHT);
	for (const shot of plan.shots.filter((item) => item.parts)) {
		assert(
			shot.parts.every((part) => part.endFrame / FRAME_RATE <= Number(sourceInfo.format.duration)),
			'A shot extends past the actual recording'
		);
	}
	const clean = resolve(output, 'my-kitchen-hybrid-clean.mp4');
	const scored = resolve(output, 'my-kitchen-hybrid-review.mp4');
	const score = resolve(output, 'original-score.wav');
	const graphPath = resolve(output, 'filters.txt');
	const accentsPath = resolve(output, 'audio-accents.json');
	const accents = accentsFor(master, plan);
	await writeFile(graphPath, filtersFor(plan));
	await writeFile(accentsPath, serialize(accents));
	console.log(
		`Rendering ${plan.duration}s ${motionMode ? 'generated-motion hybrid' : 'animated-still review draft'} with exact real UI.`
	);
	run('ffmpeg', [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-i',
		rawPath,
		'-i',
		assets.ingredients,
		'-i',
		assets.substitute,
		'-i',
		assets.dinner,
		'-filter_complex_threads',
		'2',
		'-filter_complex_script',
		graphPath,
		'-map',
		'[video]',
		'-an',
		'-c:v',
		'libx264',
		'-preset',
		'slow',
		'-crf',
		'18',
		'-pix_fmt',
		'yuv420p',
		'-r',
		String(FRAME_RATE),
		'-t',
		String(plan.duration),
		'-movflags',
		'+faststart',
		'-map_metadata',
		'-1',
		clean
	]);
	const composition = JSON.parse(
		run(process.env.PROMO_PYTHON ?? 'python', [
			resolve(import.meta.dirname, 'score.py'),
			'--output',
			score,
			'--duration',
			String(plan.duration),
			'--events',
			accentsPath,
			'--mood',
			'quiet'
		])
	);
	const normalization = 'loudnorm=I=-23:TP=-3:LRA=7';
	const measured = jsonReport(
		run(
			'ffmpeg',
			['-hide_banner', '-i', score, '-af', `${normalization}:print_format=json`, '-f', 'null', '-'],
			true
		)
	);
	const mix = jsonReport(
		run(
			'ffmpeg',
			[
				'-hide_banner',
				'-y',
				'-i',
				clean,
				'-i',
				score,
				'-map',
				'0:v:0',
				'-map',
				'1:a:0',
				'-c:v',
				'copy',
				'-c:a',
				'aac',
				'-b:a',
				'160k',
				'-ar',
				'48000',
				'-af',
				`${normalization}:measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}:measured_TP=${measured.input_tp}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=json`,
				'-t',
				String(plan.duration),
				'-movflags',
				'+faststart',
				'-map_metadata',
				'-1',
				scored
			],
			true
		)
	);
	const stillFrames = [];
	for (const shot of plan.shots) {
		const at = shot.outputStart + Math.min(1, shot.duration / 2);
		const frame = resolve(output, `frame-${shot.name}.png`);
		run('ffmpeg', [
			'-hide_banner',
			'-loglevel',
			'error',
			'-y',
			'-ss',
			String(at),
			'-i',
			scored,
			'-frames:v',
			'1',
			frame
		]);
		stillFrames.push({ shot: shot.name, sourceType: shot.kind, at, path: frame });
	}
	const poster = resolve(output, 'poster.png');
	const ending = plan.shots.at(-1);
	run('ffmpeg', [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-ss',
		String(ending.outputStart + 1),
		'-i',
		scored,
		'-frames:v',
		'1',
		poster
	]);
	const contact = resolve(output, 'contact-sheet.jpg');
	run('ffmpeg', [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-i',
		scored,
		'-vf',
		`fps=12/${plan.duration},scale=195:-2,tile=6x2:padding=8:margin=8:color=white`,
		'-frames:v',
		'1',
		'-q:v',
		'2',
		contact
	]);
	const finalInfo = JSON.parse(
		run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', scored])
	);
	const video = finalInfo.streams.find((stream) => stream.codec_type === 'video');
	assert.equal(video.width, WIDTH);
	assert.equal(video.height, HEIGHT);
	assert.equal(video.avg_frame_rate, `${FRAME_RATE}/1`);
	assert(Math.abs(Number(finalInfo.format.duration) - plan.duration) < 0.05);
	const metadata = {
		status: motionMode ? 'generated-motion-review' : 'animated-stills-review-draft',
		method: plan.method,
		disclosure: plan.disclosure,
		generatedVideoMotion: motionMode,
		generatedStillCamera: motionMode
			? null
			: 'Centered 1.5–2.5% eased editorial push only; no object animation.',
		generatedMotionFit: motionMode
			? 'Centered aspect fill; generated clips play at their actual speed, with no optical-flow interpolation or extra editorial camera motion.'
			: null,
		width: WIDTH,
		height: HEIGHT,
		frameRate: FRAME_RATE,
		duration: Number(finalInfo.format.duration),
		bytes: Number(finalInfo.format.size),
		video: scored,
		silent: clean,
		poster,
		contactSheet: contact,
		masterTimeline: masterPath,
		rawMaster: rawPath,
		nativeCapture: master.capture,
		facts: {
			assistant: master.assistant,
			verification: master.verification,
			cookSelectedOilGrams: master.verification.substituteAmount,
			quantityDisclosure: `The recorded ${master.verification.substituteAmount} g is the cook's weighed choice. Preserve the assistant's quoted answer independently; no volume-to-mass conversion or AI-recommended gram amount is claimed.`
		},
		imageGeneration,
		motionGeneration,
		motionSources,
		assets,
		originalAssetsRetained: true,
		realAppSpeed: 1,
		realAppResized: false,
		answerReadingSeconds: ANSWER_SECONDS,
		stillFrames,
		shots: plan.shots,
		music: {
			...composition,
			mix,
			accents,
			license: 'Original composition; no third-party samples.'
		},
		noAddedCaptionsOrNarration: true
	};
	await writeFile(resolve(output, 'export.json'), serialize(metadata));
	await writeFile(
		resolve(output, 'manifest.json'),
		serialize({
			title: 'My Kitchen — spaghetti and meatballs',
			status: metadata.status,
			disclosure: plan.disclosure,
			video: scored,
			silent: clean,
			poster,
			contactSheet: contact,
			metadata: resolve(output, 'export.json'),
			editPlan: resolve(output, 'edit-plan.json')
		})
	);
	console.log(
		`${motionMode ? 'Generated-motion hybrid' : 'Animated-still review draft'} exported: ${plan.duration}s, ${WIDTH}×${HEIGHT}.`
	);
}

await main();
