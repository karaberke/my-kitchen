import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAKE_ANSWER_WINDOW_MS, bestVoice, listenForWakePhrase, wakeCommand } from './speech';

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

describe('wakeCommand', () => {
	it.each(["Pass me the chef's knife", 'hey there', 'check with the chef', 'chef', ''])(
		'%j is not the wake phrase',
		(text) => expect(wakeCommand(text)).toBeNull()
	);

	it.each([
		['Hey Chef how much flour', 'how much flour'],
		['hey chef, how much flour?', 'how much flour?'],
		['OK hey Chef. What is next', 'What is next'],
		['Hay chef how long', 'how long'],
		['hey chefs can I use oil', 'can I use oil'],
		['hey shef what temperature', 'what temperature']
	])('%j asks %j', (text, question) => expect(wakeCommand(text)).toBe(question));

	it('gives "" for the phrase alone', () => {
		expect(wakeCommand('Hey Chef')).toBe('');
		expect(wakeCommand('hey chef!')).toBe('');
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
	hear(...texts: string[]) {
		this.onresult?.({
			resultIndex: 0,
			results: texts.map((transcript) => ({ isFinal: true, 0: { transcript } }))
		});
	}
}
const latest = () => FakeRecognition.instances.at(-1)!;

describe('listenForWakePhrase', () => {
	let commands: string[];
	let states: string[];
	let errors: string[];
	const listen = () =>
		listenForWakePhrase({
			lang: 'en-US',
			onCommand: (t) => commands.push(t),
			onState: (s) => states.push(s),
			onError: (m) => errors.push(m)
		});

	beforeEach(() => {
		vi.useFakeTimers();
		FakeRecognition.instances = [];
		commands = [];
		states = [];
		errors = [];
		vi.stubGlobal('window', { SpeechRecognition: FakeRecognition });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('ignores speech without the phrase', () => {
		listen();
		latest().hear('add the flour', 'how much flour');
		expect(commands).toEqual([]);
		expect(latest().continuous).toBe(true);
		expect(states).toEqual(['listening']);
	});

	it('passes on a question said with the phrase', () => {
		listen();
		latest().hear('hey chef how much flour');
		expect(commands).toEqual(['how much flour']);
	});

	it('takes the next thing said after the phrase alone, within the window', () => {
		listen();
		latest().hear('hey chef');
		expect(commands).toEqual(['']);
		expect(states.at(-1)).toBe('awake');
		latest().hear('how much flour');
		expect(commands).toEqual(['', 'how much flour']);
		expect(states.at(-1)).toBe('listening');

		latest().hear('hey chef');
		vi.advanceTimersByTime(WAKE_ANSWER_WINDOW_MS + 1);
		expect(states.at(-1)).toBe('listening');
		latest().hear('talking to someone else');
		expect(commands).toEqual(['', 'how much flour', '']);
	});

	it('starts again after the browser ends a session', () => {
		listen();
		const first = latest();
		first.onend?.();
		vi.advanceTimersByTime(1_000);
		expect(FakeRecognition.instances).toHaveLength(2);
		expect(latest()).not.toBe(first);
	});

	it('releases the microphone while paused and takes it back on resume', () => {
		const wake = listen();
		wake.pause();
		expect(latest().aborted).toBe(true);
		vi.advanceTimersByTime(5_000);
		expect(FakeRecognition.instances).toHaveLength(1);
		expect(states.at(-1)).toBe('paused');
		wake.resume();
		expect(FakeRecognition.instances).toHaveLength(2);
		expect(states.at(-1)).toBe('listening');
	});

	it('stops with a message when the microphone is blocked', () => {
		listen();
		latest().onerror?.({ error: 'not-allowed' });
		vi.advanceTimersByTime(5_000);
		expect(errors).toHaveLength(1);
		expect(states.at(-1)).toBe('off');
		expect(FakeRecognition.instances).toHaveLength(1);
	});

	it('gives up after failing again and again, so it never loops', () => {
		listen();
		for (let i = 0; i < 10; i++) {
			latest().onerror?.({ error: 'network' });
			latest().onend?.();
			vi.advanceTimersByTime(10_000);
		}
		expect(errors).toHaveLength(1);
		expect(states.at(-1)).toBe('off');
		expect(FakeRecognition.instances.length).toBeLessThanOrEqual(5);
	});

	it('stops for good', () => {
		const wake = listen();
		wake.stop();
		vi.advanceTimersByTime(5_000);
		wake.resume();
		expect(FakeRecognition.instances).toHaveLength(1);
		expect(states.at(-1)).toBe('off');
	});
});
