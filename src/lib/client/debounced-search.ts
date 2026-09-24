import { goto } from '$app/navigation';

const SEARCH_DEBOUNCE_MS = 300;

/**
 * A debounced `goto` for as-you-type search boxes: waits for a pause in
 * typing before updating the URL, replacing history and keeping focus and
 * scroll where they are. Call the returned function on every input event;
 * each instance keeps its own timer. `.cancel()` drops any pending call —
 * for a form's own submit (e.g. the Enter key), which navigates right away
 * instead.
 */
export function debouncedSearchGoto(delayMs = SEARCH_DEBOUNCE_MS) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	function run(href: string) {
		clearTimeout(timer);
		timer = setTimeout(
			() => goto(href, { keepFocus: true, replaceState: true, noScroll: true }),
			delayMs
		);
	}
	run.cancel = () => clearTimeout(timer);
	return run;
}
