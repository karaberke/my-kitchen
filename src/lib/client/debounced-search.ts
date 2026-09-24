const SEARCH_DEBOUNCE_MS = 300;

/**
 * A debounced submit for as-you-type search boxes: waits for a pause in
 * typing before resubmitting the enclosing GET form (kept-focus,
 * replace-state navigation comes from the form's own
 * `data-sveltekit-keepfocus`/`data-sveltekit-noscroll`/`data-sveltekit-replacestate`
 * attributes). Call the returned function with the form on every input
 * event; each instance keeps its own timer. `.cancel()` drops any pending
 * call — for the form's own submit (e.g. the Enter key), which navigates
 * right away instead.
 */
export function debouncedSubmit(delayMs = SEARCH_DEBOUNCE_MS) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	function run(form: HTMLFormElement) {
		clearTimeout(timer);
		timer = setTimeout(() => form.requestSubmit(), delayMs);
	}
	run.cancel = () => clearTimeout(timer);
	return run;
}
