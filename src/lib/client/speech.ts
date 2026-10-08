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

/** One spoken question being heard; the chat's Speak button uses it. */
export interface Dictation {
	/** The text heard, or an `Error` whose message is fit to show. */
	result: Promise<string>;
	/** End early: what was heard so far still resolves, silence rejects. */
	stop(): void;
}

/** How long `stop()` waits for the browser to end before it gives up on it. */
export const LISTEN_STOP_GRACE_MS = 1_500;

/**
 * Listens for one utterance. Interim results are kept too, because iOS often
 * gives nothing else, and `stop()` never hangs: when the browser does not end
 * the session after `LISTEN_STOP_GRACE_MS`, it is aborted and settled here.
 */
export function listen({ lang }: { lang: string }): Dictation {
	let recognition: Recognition | null = null;
	let finish: () => void = () => {};
	const result = new Promise<string>((resolve, reject) => {
		const Ctor = recognitionConstructor();
		if (!Ctor) {
			reject(new Error('Speech input is not available in this browser.'));
			return;
		}
		let text = '';
		let failure = '';
		let done = false;
		finish = () => {
			if (done) return;
			done = true;
			if (text) resolve(text);
			else reject(new Error(failure || RECOGNITION_ERRORS['no-speech']));
		};
		try {
			recognition = new Ctor();
			recognition.lang = lang;
			recognition.continuous = false;
			recognition.interimResults = true;
			recognition.maxAlternatives = 1;
			recognition.onresult = (e) => {
				text = Array.from(e.results)
					.map((r) => r[0]?.transcript ?? '')
					.join(' ')
					.trim();
			};
			recognition.onerror = (e) => {
				if (e.error !== 'aborted') failure = RECOGNITION_ERRORS[e.error] ?? RECOGNITION_FALLBACK;
			};
			recognition.onend = finish;
			recognition.start();
		} catch {
			done = true;
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
			setTimeout(() => {
				try {
					recognition?.abort();
				} catch {
					// already ended
				}
				finish();
			}, LISTEN_STOP_GRACE_MS);
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

let primed = false;

/**
 * iOS speaks only when the first `speak()` happens during a tap; an answer
 * arrives seconds later, outside it. Call this from a tap handler: a silent
 * utterance there lets the later answers speak.
 */
export function primeSpeech(): void {
	if (primed) return;
	try {
		const s = synth();
		if (!s) return;
		const utterance = new SpeechSynthesisUtterance(' ');
		utterance.volume = 0;
		s.speak(utterance);
		primed = true;
	} catch {
		// read-aloud stays off until a later tap
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

/** Reads `text` aloud in `lang`, in the most natural voice installed. Any speech still in progress is cut off first. */
export function speak(text: string, lang: string): void {
	try {
		const s = synth();
		if (!s || !text.trim()) return;
		s.cancel();
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = lang;
		const voice = bestVoice(s.getVoices(), lang);
		if (voice) {
			utterance.voice = voice;
			utterance.lang = voice.lang;
		}
		s.speak(utterance);
	} catch {
		// speech is optional; the text stays on screen
	}
}

export function stopSpeaking(): void {
	try {
		synth()?.cancel();
	} catch {
		// nothing to stop
	}
}
