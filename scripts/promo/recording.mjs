/** Native CDP PNG capture with timestamped source frames and a lossless 60 fps master. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const NATIVE_CAPTURE_SCALE = 2;
export const NATIVE_CAPTURE_FPS = 60;
export const NATIVE_BROWSER_ARGS = [`--force-device-scale-factor=${NATIVE_CAPTURE_SCALE}`];

/** Capture the real compositor output; static frames retain their actual screen duration. */
export async function startNativeRecording(page, viewport) {
	const session = await page.context().newCDPSession(page);
	const frames = [];
	const pendingAcks = new Set();
	const errors = [];
	const physical = {
		width: viewport.width * NATIVE_CAPTURE_SCALE,
		height: viewport.height * NATIVE_CAPTURE_SCALE
	};
	await session.send('Page.enable');
	await session.send('Emulation.setDeviceMetricsOverride', {
		...viewport,
		deviceScaleFactor: NATIVE_CAPTURE_SCALE,
		mobile: true,
		scale: 1,
		screenWidth: viewport.width,
		screenHeight: viewport.height
	});
	// Match the compositor's UTC timestamps to the host's monotonic performance clock.
	const samples = [];
	for (let index = 0; index < 5; index++) {
		const before = performance.now();
		const result = await session.send('Runtime.evaluate', {
			expression: '(performance.timeOrigin + performance.now()) / 1000',
			returnByValue: true
		});
		const after = performance.now();
		samples.push({
			roundTripMs: after - before,
			epochAtHostZero: result.result.value - (before + after) / 2000
		});
	}
	const calibration = samples.sort((a, b) => a.roundTripMs - b.roundTripMs)[0];
	const epochNow = () => calibration.epochAtHostZero + performance.now() / 1000;
	let origin;
	let stoppedAt;
	let ready;
	const firstFrame = new Promise((resolve) => (ready = resolve));
	session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
		const acknowledgement = session.send('Page.screencastFrameAck', { sessionId });
		pendingAcks.add(acknowledgement);
		acknowledgement
			.catch((error) => errors.push(error.message))
			.finally(() => pendingAcks.delete(acknowledgement));
		const buffer = Buffer.from(data, 'base64');
		const timestamp = metadata.timestamp;
		if (!Number.isFinite(timestamp)) {
			errors.push('A compositor frame lacked its source timestamp.');
			return;
		}
		if (buffer.readUInt32BE(16) !== physical.width || buffer.readUInt32BE(20) !== physical.height) {
			errors.push('A compositor frame did not match the native physical viewport.');
			return;
		}
		if (origin === undefined) origin = timestamp;
		if (frames.length && timestamp <= frames.at(-1).timestamp) return;
		frames.push({ buffer, timestamp, metadata });
		ready();
	});
	await session.send('Page.startScreencast', {
		format: 'png',
		maxWidth: physical.width,
		maxHeight: physical.height,
		everyNthFrame: 1
	});
	let timeout;
	try {
		await Promise.race([
			firstFrame,
			new Promise((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error('No native compositor frame arrived.')),
					10_000
				);
			})
		]);
	} finally {
		clearTimeout(timeout);
	}
	return {
		now: () => Number((epochNow() - origin).toFixed(6)),
		physical,
		async stop() {
			stoppedAt = epochNow();
			await session.send('Page.stopScreencast');
			await Promise.allSettled([...pendingAcks]);
			await session.detach();
		},
		async save(outputDir) {
			if (!stoppedAt) throw new Error('Stop the recording before flushing source frames.');
			if (errors.length) throw new Error([...new Set(errors)].join('\n'));
			const rawDir = path.join(outputDir, 'raw');
			const framesDir = path.join(rawDir, 'frames');
			await mkdir(framesDir, { recursive: true });
			const sourceFrames = [];
			for (const [index, frame] of frames.entries()) {
				const file = `${String(index).padStart(6, '0')}.png`;
				await writeFile(path.join(framesDir, file), frame.buffer);
				sourceFrames.push({
					file: `frames/${file}`,
					at: frame.timestamp - origin,
					timestamp: frame.timestamp,
					metadata: frame.metadata
				});
			}
			const duration = stoppedAt - origin;
			const intervals = sourceFrames
				.slice(1)
				.map((frame, index) => frame.at - sourceFrames[index].at);
			const motionIntervals = intervals
				.filter((delta) => delta > 0.001 && delta < 0.1)
				.sort((a, b) => a - b);
			const report = {
				method: 'Chrome DevTools Protocol Page.startScreencast PNG',
				cssViewport: viewport,
				physicalViewport: physical,
				deviceScaleFactor: NATIVE_CAPTURE_SCALE,
				frameRate: NATIVE_CAPTURE_FPS,
				originTimestamp: origin,
				duration,
				frameCount: frames.length,
				motionMedianFramesPerSecond: motionIntervals.length
					? 1 / motionIntervals[Math.floor(motionIntervals.length / 2)]
					: null,
				clock: {
					method: 'CDP renderer epoch paired with host monotonic clock; lowest round-trip sample',
					...calibration
				},
				frames: sourceFrames,
				sources: [
					'https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast',
					'https://chromedevtools.github.io/devtools-protocol/tot/Page/#type-ScreencastFrameMetadata',
					'https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setDeviceMetricsOverride'
				]
			};
			await writeFile(
				path.join(rawDir, 'source-frames.json'),
				`${JSON.stringify(report, null, 2)}\n`
			);
			const rawPath = path.join(rawDir, 'master-native-lossless.mkv');
			await encodeLossless(frames, origin, duration, rawPath);
			return { rawPath, ...report, frames: undefined };
		}
	};
}

async function encodeLossless(frames, origin, duration, outputPath) {
	const executable = process.env.PROMO_FFMPEG_PATH ?? 'ffmpeg';
	const encoder = spawn(
		executable,
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-y',
			'-f',
			'image2pipe',
			'-framerate',
			String(NATIVE_CAPTURE_FPS),
			'-vcodec',
			'png',
			'-i',
			'pipe:0',
			'-an',
			'-c:v',
			'ffv1',
			'-level',
			'3',
			'-g',
			'1',
			'-pix_fmt',
			'bgr0',
			outputPath
		],
		{ windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }
	);
	let errors = '';
	encoder.stderr.on('data', (buffer) => (errors += buffer.toString()));
	const completion = new Promise((resolve, reject) => {
		encoder.once('error', reject);
		encoder.once('close', (code) =>
			code === 0
				? resolve()
				: reject(new Error(`Lossless master encoding failed (${code}): ${errors}`))
		);
	});
	let sourceIndex = 0;
	const frameCount = Math.ceil(duration * NATIVE_CAPTURE_FPS);
	for (let index = 0; index < frameCount; index++) {
		const timestamp = origin + index / NATIVE_CAPTURE_FPS;
		while (sourceIndex + 1 < frames.length && frames[sourceIndex + 1].timestamp <= timestamp)
			sourceIndex++;
		if (!encoder.stdin.write(frames[sourceIndex].buffer)) await once(encoder.stdin, 'drain');
	}
	encoder.stdin.end();
	await completion;
}
