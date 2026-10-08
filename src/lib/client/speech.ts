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
	return synth() !== null;
}

/** Reads `text` aloud in `lang`. Any speech still in progress is cut off first. */
export function speak(text: string, lang: string): void {
	try {
		const s = synth();
		if (!s || !text.trim()) return;
		s.cancel();
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = lang;
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
