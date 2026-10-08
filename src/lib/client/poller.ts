/**
 * A nudge (tab shown, window focused, back online) within this time of the
 * last check does nothing: returning to a tab fires several events at once and
 * one request answers them all.
 */
export const POLL_NUDGE_COOLDOWN_MS = 1000;
/** The wait grows by one interval per failure, up to this many extra intervals. */
export const POLL_MAX_BACKOFF = 5;

type PollerOptions<T> = {
	/** The base wait between checks; read on every schedule, so it may change. */
	intervalMs: () => number;
	/** One round trip. Its answer is dropped when a newer check or `stop()` overtook it. */
	poll: () => Promise<T>;
	/** Uses an answer that is still current. A throw counts as a failure. */
	apply: (answer: T) => void | Promise<void>;
	/** When this returns false a check does nothing and is not rescheduled. */
	enabled?: () => boolean;
	/** True for an error that ends polling (not authorized any more). */
	fatal?: (err: unknown) => boolean;
};

/**
 * A timer-driven poll that pauses while the page is hidden or offline and
 * resumes, with one check, when it is shown again. Failures back off. `start()`
 * begins (or restarts) the loop and listens for visibility, focus and
 * connection events; `stop()` ends it and drops any answer still on its way.
 */
export function createPoller<T>(options: PollerOptions<T>) {
	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** Bumped by each check and by `stop()`, so a late answer is dropped. */
	let latest = 0;
	let inFlight = false;
	let lastStarted = Number.NEGATIVE_INFINITY;
	let attached = false;

	function schedule() {
		clearTimeout(timer);
		const backoff = Math.min(POLL_MAX_BACKOFF, failures);
		timer = setTimeout(() => void check(), options.intervalMs() * (1 + backoff));
	}

	async function check() {
		clearTimeout(timer);
		if (options.enabled && !options.enabled()) return;
		if (document.hidden || !navigator.onLine) return schedule();
		const mine = ++latest;
		inFlight = true;
		lastStarted = Date.now();
		try {
			const answer = await options.poll();
			if (mine !== latest) return;
			await options.apply(answer);
			if (mine !== latest) return;
			failures = 0;
		} catch (err) {
			if (mine !== latest) return;
			if (options.fatal?.(err)) return;
			failures++;
		} finally {
			if (mine === latest) inFlight = false;
		}
		schedule();
	}

	/** The page came back: check now, once, however many events said so. */
	function nudge() {
		if (document.hidden || inFlight) return;
		if (Date.now() - lastStarted < POLL_NUDGE_COOLDOWN_MS) return;
		void check();
	}

	function start() {
		if (!attached) {
			document.addEventListener('visibilitychange', nudge);
			window.addEventListener('focus', nudge);
			window.addEventListener('online', nudge);
			attached = true;
		}
		schedule();
	}

	function stop() {
		if (attached) {
			document.removeEventListener('visibilitychange', nudge);
			window.removeEventListener('focus', nudge);
			window.removeEventListener('online', nudge);
			attached = false;
		}
		clearTimeout(timer);
		latest++;
		inFlight = false;
	}

	return { start, stop };
}
