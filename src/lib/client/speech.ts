/**
 * Browser speech: recognition (microphone to text) and synthesis (text to
 * speaker). Both belong to the browser, so every call can fail or be missing;
 * callers check the `...Available()` function and hide the feature when false.
 */

// lib.dom does not type SpeechRecognition in every TypeScript version, so declare the part used here.
interface RecognitionAlternative {
	transcript: string;
}
interface RecognitionResult {
	isFinal: boolean;
	0: RecognitionAlternative;
}
interface RecognitionResultEvent {
	/** the first result that is new in this event */
	resultIndex?: number;
	results: ArrayLike<RecognitionResult>;
}
interface RecognitionErrorEvent {
	error: string;
}
interface Recognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	onresult: ((e: RecognitionResultEvent) => void) | null;
	onerror: ((e: RecognitionErrorEvent) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
type RecognitionConstructor = new () => Recognition;
interface SpeechWindow {
	SpeechRecognition?: RecognitionConstructor;
	webkitSpeechRecognition?: RecognitionConstructor;
}

const RECOGNITION_ERRORS: Record<string, string> = {
	'no-speech': 'No speech heard. Try again.',
	'audio-capture': 'No microphone found.',
	'not-allowed': 'Microphone access is blocked. Allow it in your browser settings.',
	'service-not-allowed': 'Speech recognition is not allowed in this browser.',
	network: 'Speech recognition needs a network connection.',
	'language-not-supported': 'Speech recognition does not support this language.'
};
const RECOGNITION_FALLBACK = 'Could not understand the speech. Try again.';

function recognitionConstructor(): RecognitionConstructor | null {
	if (typeof window === 'undefined') return null;
	try {
		const w = window as unknown as SpeechWindow;
		return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
	} catch {
		return null;
	}
}

/** The language to listen and speak in: the browser's. */
export function speechLang(): string {
	return typeof navigator === 'undefined' ? 'en' : navigator.language || 'en';
}

export function speechInputAvailable(): boolean {
	return recognitionConstructor() !== null;
}

/**
 * Listens for one utterance. `result` resolves with the text, or rejects with
 * an `Error` whose message is fit to show. `stop()` ends the listening early:
 * a partial result still resolves, and silence rejects as no speech.
 */
export function listen({ lang }: { lang: string }): { result: Promise<string>; stop(): void } {
	let recognition: Recognition | null = null;
	const result = new Promise<string>((resolve, reject) => {
		const Ctor = recognitionConstructor();
		if (!Ctor) {
			reject(new Error('Speech input is not available in this browser.'));
			return;
		}
		let text = '';
		let failure = '';
		try {
			recognition = new Ctor();
			recognition.lang = lang;
			recognition.continuous = false;
			recognition.interimResults = false;
			recognition.maxAlternatives = 1;
			recognition.onresult = (e) => {
				text = Array.from(e.results)
					.map((r) => r[0]?.transcript ?? '')
					.join(' ')
					.trim();
			};
			recognition.onerror = (e) => {
				failure = RECOGNITION_ERRORS[e.error] ?? RECOGNITION_FALLBACK;
			};
			recognition.onend = () => {
				if (text) resolve(text);
				else reject(new Error(failure || RECOGNITION_ERRORS['no-speech']));
			};
			recognition.start();
		} catch {
			reject(new Error(RECOGNITION_FALLBACK));
		}
	});
	return {
		result,
		stop() {
			try {
				recognition?.stop();
			} catch {
				// already stopped
			}
		}
	};
}

function synth(): SpeechSynthesis | null {
	if (typeof window === 'undefined') return null;
	try {
		return 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
			? window.speechSynthesis
			: null;
	} catch {
		return null;
	}
}

export function speechOutputAvailable(): boolean {
	const s = synth();
	// Chrome fills the voice list some time after the page loads; asking early starts that.
	try {
		s?.getVoices();
	} catch {
		// the default voice still works
	}
	return s !== null;
}

/** The parts of a `SpeechSynthesisVoice` that choose one. */
export type VoiceInfo = Pick<SpeechSynthesisVoice, 'name' | 'lang' | 'localService'>;

/** Higher is more natural. iOS and macOS name their large voices "Ava (Premium)", "Evan (Enhanced)". */
function voiceQuality(name: string): number {
	if (/\bpremium\b/i.test(name)) return 2;
	if (/\benhanced\b/i.test(name)) return 1;
	return 0;
}

/**
 * The most natural installed voice for `lang`, or null to leave the choice to
 * the browser. Only a Premium or Enhanced voice is picked: the browser's own
 * default is better than a small voice chosen at random. A voice for the exact
 * language ("en-US") beats one for the same language elsewhere ("en-GB"), and
 * a voice on the device beats a network one.
 */
export function bestVoice<V extends VoiceInfo>(voices: readonly V[], lang: string): V | null {
	const want = lang.toLowerCase().replace('_', '-');
	const primary = want.split('-')[0];
	let best: V | null = null;
	let bestScore = 0;
	for (const v of voices) {
		const quality = voiceQuality(v.name);
		const vlang = v.lang.toLowerCase().replace('_', '-');
		if (!quality || vlang.split('-')[0] !== primary) continue;
		const score = quality * 4 + (vlang === want ? 2 : 0) + (v.localService ? 1 : 0);
		if (score > bestScore) {
			best = v;
			bestScore = score;
		}
	}
	return best;
}

/**
 * Reads `text` aloud in `lang`, in the most natural voice installed. Any speech
 * still in progress is cut off first. `onEnd` runs once when the speech ends,
 * is cut off or cannot start.
 */
export function speak(text: string, lang: string, onEnd?: () => void): void {
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		onEnd?.();
	};
	try {
		const s = synth();
		if (!s || !text.trim()) return end();
		s.cancel();
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = lang;
		const voice = bestVoice(s.getVoices(), lang);
		if (voice) {
			utterance.voice = voice;
			utterance.lang = voice.lang;
		}
		utterance.onend = end;
		utterance.onerror = end;
		s.speak(utterance);
	} catch {
		// speech is optional; the text stays on screen
		end();
	}
}

export function stopSpeaking(): void {
	try {
		synth()?.cancel();
	} catch {
		// nothing to stop
	}
}

/* -------------------------------------------------------------------- */
/* Wake phrase                                                           */
/* -------------------------------------------------------------------- */

export const WAKE_PHRASE = 'Hey Chef';
/** How long after the wake phrase alone the next thing said counts as the question. */
export const WAKE_ANSWER_WINDOW_MS = 8_000;
/** Failed sessions in a row before listening gives up, so it never loops. */
const WAKE_MAX_FAILURES = 5;
const WAKE_RESTART_MS = 300;
/** Errors that a restart cannot fix. */
const WAKE_FATAL = new Set([
	'not-allowed',
	'service-not-allowed',
	'audio-capture',
	'language-not-supported'
]);

/** "Hey Chef" and the forms recognition hears for it, with what follows. */
const WAKE_RE = /\b(?:hey|hay)[\s,.!]+(?:chefs|chef|shef)\b[\s,.!:;-]*/i;

/**
 * The question after the wake phrase in one thing heard: the text after it,
 * "" when the phrase was said alone, or null when it was not said.
 */
export function wakeCommand(transcript: string): string | null {
	const m = WAKE_RE.exec(transcript);
	return m ? transcript.slice(m.index + m[0].length).trim() : null;
}

export type WakeState = 'listening' | 'awake' | 'paused' | 'off';

export interface WakeListener {
	/** Stop for good; a new listener is needed to listen again. */
	stop(): void;
	/** Release the microphone for a while, for example while an answer is read aloud. */
	pause(): void;
	resume(): void;
}

/**
 * Listen all the time for "Hey Chef". `onCommand` gets the question said with
 * it, or "" for the phrase alone; then the next thing said within
 * `WAKE_ANSWER_WINDOW_MS` comes as the question. Browsers end a session after
 * silence or a minute, so it starts again by itself. An error that a restart
 * cannot fix stops it and goes to `onError` with a message fit to show.
 */
export function listenForWakePhrase(handlers: {
	lang: string;
	onCommand: (text: string) => void;
	onState: (state: WakeState) => void;
	onError: (message: string) => void;
}): WakeListener {
	const Ctor = recognitionConstructor();
	let stopped = false;
	let paused = false;
	let failures = 0;
	let awake = false;
	let recognition: Recognition | null = null;
	let restartTimer: ReturnType<typeof setTimeout> | undefined;
	let awakeTimer: ReturnType<typeof setTimeout> | undefined;
	let state: WakeState = 'off';

	const show = () => {
		const next: WakeState = stopped ? 'off' : paused ? 'paused' : awake ? 'awake' : 'listening';
		if (next !== state) handlers.onState((state = next));
	};
	const setAwake = (on: boolean) => {
		clearTimeout(awakeTimer);
		awake = on;
		if (on) awakeTimer = setTimeout(() => setAwake(false), WAKE_ANSWER_WINDOW_MS);
		show();
	};
	const end = () => {
		clearTimeout(restartTimer);
		const r = recognition;
		recognition = null;
		try {
			r?.abort();
		} catch {
			// already ended
		}
	};
	const fail = (message: string) => {
		listener.stop();
		handlers.onError(message);
	};

	function start() {
		if (stopped || paused || recognition) return;
		if (!Ctor) return fail('Speech input is not available in this browser.');
		let r: Recognition;
		try {
			r = new Ctor();
			r.lang = handlers.lang;
			r.continuous = true;
			r.interimResults = false;
			r.maxAlternatives = 1;
		} catch {
			return fail(RECOGNITION_FALLBACK);
		}
		r.onresult = (e) => {
			failures = 0;
			for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
				const result = e.results[i];
				const heard = result.isFinal ? (result[0]?.transcript ?? '').trim() : '';
				if (!heard) continue;
				const command = wakeCommand(heard);
				if (command === '') {
					setAwake(true);
					handlers.onCommand('');
				} else if (command !== null || awake) {
					setAwake(false);
					handlers.onCommand(command ?? heard);
				}
			}
		};
		r.onerror = (e) => {
			if (WAKE_FATAL.has(e.error)) fail(RECOGNITION_ERRORS[e.error] ?? RECOGNITION_FALLBACK);
			else if (e.error !== 'no-speech' && e.error !== 'aborted') failures++;
		};
		r.onend = () => {
			if (recognition !== r) return;
			recognition = null;
			if (stopped || paused) return;
			if (failures >= WAKE_MAX_FAILURES)
				return fail(`Listening for "${WAKE_PHRASE}" stopped. Turn it on again to retry.`);
			restartTimer = setTimeout(start, WAKE_RESTART_MS * (failures + 1));
		};
		try {
			r.start();
			recognition = r;
		} catch {
			failures++;
			restartTimer = setTimeout(start, WAKE_RESTART_MS * (failures + 1));
		}
		show();
	}

	const listener: WakeListener = {
		stop() {
			stopped = true;
			clearTimeout(awakeTimer);
			awake = false;
			end();
			show();
		},
		pause() {
			if (stopped || paused) return;
			paused = true;
			end();
			show();
		},
		resume() {
			if (stopped || !paused) return;
			paused = false;
			start();
			show();
		}
	};
	start();
	return listener;
}
