import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLL_NUDGE_COOLDOWN_MS, createPoller } from './poller';

const INTERVAL_MS = 1000;

let doc: EventTarget & { hidden: boolean };
let win: EventTarget;

beforeEach(() => {
	vi.useFakeTimers();
	doc = Object.assign(new EventTarget(), { hidden: false });
	win = new EventTarget();
	vi.stubGlobal('document', doc);
	vi.stubGlobal('window', win);
	vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function make(
	poll: () => Promise<string> = vi.fn(async () => 'answer'),
	extra: { enabled?: () => boolean; fatal?: (err: unknown) => boolean } = {}
) {
	const apply = vi.fn();
	const poller = createPoller<string>({ intervalMs: () => INTERVAL_MS, poll, apply, ...extra });
	return { poller, apply };
}

describe('createPoller', () => {
	it('checks once per interval', async () => {
		const poll = vi.fn(async () => 'answer');
		const { poller, apply } = make(poll);
		poller.start();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(poll).toHaveBeenCalledTimes(1);
		expect(apply).toHaveBeenCalledWith('answer');
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(poll).toHaveBeenCalledTimes(2);
		poller.stop();
	});

	it('sends one request when the tab becomes visible and the window gets focus', async () => {
		const poll = vi.fn(async () => 'answer');
		const { poller } = make(poll);
		poller.start();
		doc.hidden = true;
		doc.dispatchEvent(new Event('visibilitychange'));
		doc.hidden = false;
		doc.dispatchEvent(new Event('visibilitychange'));
		win.dispatchEvent(new Event('focus'));
		await vi.advanceTimersByTimeAsync(0);
		expect(poll).toHaveBeenCalledTimes(1);
		// The answer is in, but the cooldown still swallows a late focus event.
		win.dispatchEvent(new Event('focus'));
		await vi.advanceTimersByTimeAsync(POLL_NUDGE_COOLDOWN_MS - 1);
		expect(poll).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it('does not ask while the page is hidden', async () => {
		const poll = vi.fn(async () => 'answer');
		const { poller } = make(poll);
		poller.start();
		doc.hidden = true;
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
		expect(poll).not.toHaveBeenCalled();
		doc.hidden = false;
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(poll).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it('waits longer after a failure', async () => {
		const poll = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('down'))
			.mockResolvedValue('answer');
		const { poller } = make(poll);
		poller.start();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(poll).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(poll).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(poll).toHaveBeenCalledTimes(2);
		// The answer reset the backoff.
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(poll).toHaveBeenCalledTimes(3);
		poller.stop();
	});

	it('ends on a fatal error', async () => {
		const poll = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('forbidden'));
		const { poller } = make(poll, { fatal: () => true });
		poller.start();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);
		expect(poll).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it('drops an answer that arrives after stop()', async () => {
		let release: (value: string) => void = () => {};
		const poll = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
		const { poller, apply } = make(poll);
		poller.start();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		poller.stop();
		release('late');
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
		expect(apply).not.toHaveBeenCalled();
		expect(poll).toHaveBeenCalledTimes(1);
	});

	it('does nothing while disabled', async () => {
		const poll = vi.fn(async () => 'answer');
		const { poller } = make(poll, { enabled: () => false });
		poller.start();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
		expect(poll).not.toHaveBeenCalled();
		poller.stop();
	});

	it('stops listening after stop()', async () => {
		const poll = vi.fn(async () => 'answer');
		const { poller } = make(poll);
		poller.start();
		poller.stop();
		win.dispatchEvent(new Event('focus'));
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
		expect(poll).not.toHaveBeenCalled();
	});
});
