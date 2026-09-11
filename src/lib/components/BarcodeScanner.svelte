<script lang="ts">
	import { onDestroy } from 'svelte';
	import { decodeFrame, loadDecoder } from '$lib/client/barcode-decoder';
	import type { Symbology } from '$lib/shared/gtin';

	/**
	 * The camera scanner.
	 *
	 * The camera is opened when this dialog opens and never before. Every path
	 * out — closing, a failed read, the phone going to the background, leaving
	 * the page — stops the track and cancels the frame loop, and a result that
	 * arrives from a loop that has already been stopped is thrown away.
	 *
	 * Typing the number is always available beside the viewfinder, so a refused
	 * camera, a dark aisle or a torn label is never a dead end.
	 */
	let {
		open = $bindable(false),
		busy = false,
		onclose,
		ondetected
	}: {
		open?: boolean;
		/** True while a lookup is running, so the loop stays paused. */
		busy?: boolean;
		onclose?: () => void;
		ondetected: (code: { raw: string; symbology: Symbology | null }) => void;
	} = $props();

	type Phase = 'off' | 'starting' | 'scanning' | 'paused' | 'failed';
	type Failure = 'insecure' | 'unsupported' | 'denied' | 'no_camera' | 'in_use' | 'decoder';

	const MESSAGES: Record<Failure, { title: string; detail: string }> = {
		insecure: {
			title: 'The camera needs a secure address',
			detail:
				'Browsers only give the camera to pages served over https, or to localhost. Open this app through its https address and scan again. Until then, type the number below.'
		},
		unsupported: {
			title: 'This browser has no camera access',
			detail: 'Type the number below instead.'
		},
		denied: {
			title: 'The camera was refused',
			detail:
				'Allow the camera for this site in your browser settings, then press Try again. Or type the number below.'
		},
		no_camera: {
			title: 'No camera was found',
			detail: 'This device has no camera the browser can use. Type the number below.'
		},
		in_use: {
			title: 'The camera is busy',
			detail:
				'Another app or tab is using it. Close that one, then press Try again. Or type the number below.'
		},
		decoder: {
			title: 'The reader did not load',
			detail: 'Check your connection to this server and press Try again, or type the number below.'
		}
	};

	let phase: Phase = $state('off');
	let failure: Failure | null = $state(null);
	let video: HTMLVideoElement | undefined = $state();
	let manual = $state('');
	let torchOn = $state(false);
	let torchAvailable = $state(false);

	let stream: MediaStream | null = null;
	let canvas: HTMLCanvasElement | null = null;
	let frameHandle: number | null = null;
	let timerHandle: ReturnType<typeof setTimeout> | null = null;
	let decoding = false;
	/**
	 * Every start gets a number. A decode that finishes after its loop was
	 * stopped belongs to an older number and is discarded, so a code read on the
	 * way out never lands on the next screen.
	 */
	let generation = 0;

	/** Widest frame handed to the decoder. Small codes still need real pixels. */
	const MAX_CAPTURE_WIDTH = 900;
	/** Fallback pace when the browser has no requestVideoFrameCallback. */
	const FALLBACK_INTERVAL_MS = 120;

	function stop() {
		generation++;
		if (frameHandle !== null && video && 'cancelVideoFrameCallback' in video) {
			video.cancelVideoFrameCallback(frameHandle);
		}
		frameHandle = null;
		if (timerHandle !== null) clearTimeout(timerHandle);
		timerHandle = null;
		decoding = false;
		torchOn = false;
		torchAvailable = false;
		for (const track of stream?.getTracks() ?? []) track.stop();
		stream = null;
		if (video) video.srcObject = null;
	}

	function fail(kind: Failure) {
		stop();
		failure = kind;
		phase = 'failed';
	}

	function classify(err: unknown): Failure {
		const name = (err as { name?: string } | null)?.name ?? '';
		if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
		if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_camera';
		if (name === 'NotReadableError' || name === 'AbortError') return 'in_use';
		return 'no_camera';
	}

	async function start() {
		if (phase === 'starting' || phase === 'scanning') return;
		failure = null;
		phase = 'starting';

		if (typeof window !== 'undefined' && !window.isSecureContext) return fail('insecure');
		if (!navigator.mediaDevices?.getUserMedia) return fail('unsupported');

		// The reader is fetched now, not when the page loaded.
		try {
			await loadDecoder();
		} catch {
			return fail('decoder');
		}

		const mine = ++generation;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: {
					facingMode: { ideal: 'environment' },
					width: { ideal: 1280 },
					height: { ideal: 720 }
				},
				audio: false
			});
		} catch (err) {
			return fail(classify(err));
		}
		// The dialog may have closed while the permission prompt was open.
		if (mine !== generation || !open) {
			for (const track of stream.getTracks()) track.stop();
			stream = null;
			return;
		}
		if (video) {
			video.srcObject = stream;
			await video.play().catch(() => {});
		}
		const track = stream.getVideoTracks()[0];
		const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
		torchAvailable = capabilities?.torch === true;
		phase = 'scanning';
		pump(mine);
	}

	function pump(mine: number) {
		if (mine !== generation || phase !== 'scanning' || !video) return;
		if ('requestVideoFrameCallback' in video) {
			frameHandle = video.requestVideoFrameCallback(() => void onFrame(mine));
		} else {
			timerHandle = setTimeout(() => void onFrame(mine), FALLBACK_INTERVAL_MS);
		}
	}

	/**
	 * Only the strip inside the guide is read, scaled down. Reading the whole
	 * frame at the camera's own size costs far more than it finds.
	 */
	function grab(): ImageData | null {
		if (!video || !video.videoWidth) return null;
		const cropWidth = Math.round(video.videoWidth * 0.86);
		const cropHeight = Math.round(video.videoHeight * 0.46);
		const scale = Math.min(1, MAX_CAPTURE_WIDTH / cropWidth);
		const width = Math.max(1, Math.round(cropWidth * scale));
		const height = Math.max(1, Math.round(cropHeight * scale));

		canvas ??= document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d', { willReadFrequently: true });
		if (!context) return null;
		context.drawImage(
			video,
			Math.round((video.videoWidth - cropWidth) / 2),
			Math.round((video.videoHeight - cropHeight) / 2),
			cropWidth,
			cropHeight,
			0,
			0,
			width,
			height
		);
		return context.getImageData(0, 0, width, height);
	}

	async function onFrame(mine: number) {
		frameHandle = null;
		timerHandle = null;
		// One frame at a time: a decode still running means this frame is skipped.
		if (mine !== generation || phase !== 'scanning' || decoding || busy) return pump(mine);
		decoding = true;
		let found: Awaited<ReturnType<typeof decodeFrame>> = null;
		try {
			const image = grab();
			if (image) found = await decodeFrame(image);
		} catch {
			// A single unreadable frame is not a failure of the scanner.
		} finally {
			decoding = false;
		}
		if (mine !== generation) return;
		if (found) {
			// Hold still while the result is looked up; the user resumes.
			phase = 'paused';
			stop();
			ondetected({ raw: found.raw, symbology: found.symbology });
			return;
		}
		pump(mine);
	}

	async function toggleTorch() {
		const track = stream?.getVideoTracks()[0];
		if (!track) return;
		try {
			await track.applyConstraints({
				advanced: [{ torch: !torchOn } as MediaTrackConstraintSet]
			});
			torchOn = !torchOn;
		} catch {
			torchAvailable = false;
		}
	}

	function submitManual(event: SubmitEvent) {
		event.preventDefault();
		const raw = manual.trim();
		if (!raw) return;
		phase = 'paused';
		stop();
		// A typed number has no format; the server decides what it can be.
		ondetected({ raw, symbology: null });
	}

	function close() {
		stop();
		phase = 'off';
		open = false;
		onclose?.();
	}

	function onVisibility() {
		// Backgrounding the page releases the camera; coming back is deliberate.
		if (document.visibilityState === 'hidden' && (phase === 'scanning' || phase === 'starting')) {
			stop();
			phase = 'paused';
		}
	}

	$effect(() => {
		if (open && phase === 'off') void start();
		if (!open && phase !== 'off') {
			stop();
			phase = 'off';
		}
	});

	$effect(() => {
		document.addEventListener('visibilitychange', onVisibility);
		return () => document.removeEventListener('visibilitychange', onVisibility);
	});

	onDestroy(stop);

	export function resume() {
		manual = '';
		if (phase !== 'scanning') void start();
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex flex-col bg-ink"
		role="dialog"
		aria-modal="true"
		aria-label="Scan a barcode"
	>
		<div class="flex items-center justify-between px-4 py-3 text-cream">
			<h2 class="text-[15px] font-bold">Scan a barcode</h2>
			<div class="flex items-center gap-2">
				{#if torchAvailable}
					<button
						type="button"
						class="rounded-[11px] bg-white/15 px-3 py-2 text-[12.5px] font-bold"
						aria-pressed={torchOn}
						onclick={toggleTorch}>{torchOn ? 'Light off' : 'Light on'}</button
					>
				{/if}
				<button
					type="button"
					class="rounded-[11px] bg-white/15 px-3 py-2 text-[12.5px] font-bold"
					onclick={close}>Close</button
				>
			</div>
		</div>

		<div class="relative flex-1 overflow-hidden bg-black">
			<video
				bind:this={video}
				class="h-full w-full object-cover"
				class:invisible={phase !== 'scanning'}
				playsinline
				muted
				autoplay
			></video>

			{#if phase === 'scanning'}
				<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div class="h-[46%] w-[86%] rounded-[18px] border-2 border-cream/80 shadow-sheet"></div>
				</div>
				<p class="absolute inset-x-0 bottom-3 text-center text-[12.5px] text-cream/85">
					Hold the barcode inside the frame.
				</p>
			{:else if phase === 'starting'}
				<p class="absolute inset-0 flex items-center justify-center text-[13px] text-cream/85">
					Starting the camera…
				</p>
			{:else if phase === 'paused'}
				<div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
					<p class="text-center text-[13px] text-cream/85">
						{busy ? 'Looking that up…' : 'The camera is stopped.'}
					</p>
					{#if !busy}
						<button type="button" class="btn btn-primary" onclick={() => void start()}
							>Scan again</button
						>
					{/if}
				</div>
			{:else if phase === 'failed' && failure}
				<div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
					<p class="text-center text-[14px] font-bold text-cream">{MESSAGES[failure].title}</p>
					<p class="max-w-sm text-center text-[12.5px] leading-relaxed text-cream/80">
						{MESSAGES[failure].detail}
					</p>
					{#if failure !== 'insecure' && failure !== 'unsupported' && failure !== 'no_camera'}
						<button type="button" class="btn btn-secondary" onclick={() => void start()}
							>Try again</button
						>
					{/if}
				</div>
			{/if}
		</div>

		<form
			class="bg-cream px-5 pt-4 pb-[calc(18px+env(safe-area-inset-bottom))]"
			onsubmit={submitManual}
		>
			<label class="label" for="manual-code">Or type the number under the barcode</label>
			<div class="flex gap-2">
				<input
					class="field"
					id="manual-code"
					name="manual-code"
					inputmode="numeric"
					autocomplete="off"
					placeholder="012345678905"
					bind:value={manual}
				/>
				<button class="btn btn-primary" type="submit" disabled={busy || !manual.trim()}
					>Look up</button
				>
			</div>
			<p class="hint">8, 12 or 13 digits. Spaces and hyphens are fine.</p>
		</form>
	</div>
{/if}
