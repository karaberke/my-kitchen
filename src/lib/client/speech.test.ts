import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LISTEN_STOP_GRACE_MS, bestVoice, listen, primeSpeech } from './speech';

const voice = (name: string, lang: string, localService = true) => ({ name, lang, localService });

describe('bestVoice', () => {
	it('leaves the choice to the browser when no Premium or Enhanced voice fits', () => {
		expect(bestVoice([], 'en-US')).toBeNull();
		expect(bestVoice([voice('Samantha', 'en-US'), voice('Fred', 'en-US')], 'en-US')).toBeNull();
		// A Premium voice in another language is no use.
		expect(bestVoice([voice('Anna (Premium)', 'de-DE')], 'en-US')).toBeNull();
	});

	it('prefers Premium to Enhanced', () => {
		const voices = [voice('Evan (Enhanced)', 'en-US'), voice('Ava (Premium)', 'en-US')];
		expect(bestVoice(voices, 'en-US')?.name).toBe('Ava (Premium)');
	});

	it('prefers the exact language, then any region of it', () => {
		const voices = [voice('Serena (Premium)', 'en-GB'), voice('Zoe (Premium)', 'en-US')];
		expect(bestVoice(voices, 'en-US')?.name).toBe('Zoe (Premium)');
		expect(bestVoice([voice('Serena (Premium)', 'en-GB')], 'en-US')?.name).toBe('Serena (Premium)');
		expect(bestVoice([voice('Zoe (Premium)', 'en_US')], 'en')?.name).toBe('Zoe (Premium)');
	});

	it('prefers a voice on the device', () => {
		const voices = [voice('Ava (Premium)', 'en-US', false), voice('Zoe (Premium)', 'en-US')];
		expect(bestVoice(voices, 'en-US')?.name).toBe('Zoe (Premium)');
	});
});

/** A stand-in for the browser's recognizer; `instances` holds every one started. */
class FakeRecognition {
	static instances: FakeRecognition[] = [];
	lang = '';
	continuous = false;
	interimResults = true;
	maxAlternatives = 0;
	started = false;
	aborted = false;
	onresult: ((e: unknown) => void) | null = null;
	onerror: ((e: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	start() {
		this.started = true;
		FakeRecognition.instances.push(this);
	}
	stop() {
		this.onend?.();
	}
	abort() {
		this.aborted = true;
		this.onend?.();
	}
	/** A result that is never final, as iOS often gives. */
	hearInterim(transcript: string) {
		this.onresult?.({ results: [{ isFinal: false, 0: { transcript } }] });
	}
}
const latest = () => FakeRecognition.instances.at(-1)!;

describe('listen', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeRecognition.instances = [];
		vi.stubGlobal('window', { SpeechRecognition: FakeRecognition });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('keeps an interim result, which is all iOS may give', async () => {
		const session = listen({ lang: 'en-US' });
		expect(latest().interimResults).toBe(true);
		latest().hearInterim('how much flour');
		latest().onend?.();
		await expect(session.result).resolves.toBe('how much flour');
	});

	it('settles after stop() even when the browser never ends the session', async () => {
		const session = listen({ lang: 'en-US' });
		const r = latest();
		r.stop = () => {}; // iOS: no end event
		r.abort = () => {};
		r.hearInterim('can I use oil');
		session.stop();
		vi.advanceTimersByTime(LISTEN_STOP_GRACE_MS);
		await expect(session.result).resolves.toBe('can I use oil');
	});

	it('says no speech was heard when stopped in silence', async () => {
		const session = listen({ lang: 'en-US' });
		latest().stop = () => {};
		session.stop();
		vi.advanceTimersByTime(LISTEN_STOP_GRACE_MS);
		await expect(session.result).rejects.toThrow('No speech heard');
	});
});

describe('primeSpeech', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('speaks one silent utterance, once, so iOS lets later answers speak', () => {
		const spoken: { text: string; volume: number }[] = [];
		vi.stubGlobal(
			'SpeechSynthesisUtterance',
			class {
				volume = 1;
				constructor(public text: string) {}
			}
		);
		vi.stubGlobal('window', {
			speechSynthesis: { speak: (u: { text: string; volume: number }) => spoken.push(u) }
		});
		primeSpeech();
		primeSpeech();
		expect(spoken).toHaveLength(1);
		expect(spoken[0].volume).toBe(0);
	});
});
