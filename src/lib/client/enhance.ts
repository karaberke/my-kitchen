import type { SubmitFunction } from '@sveltejs/kit';

/**
 * `use:enhance` that keeps what the person typed. On success `update()` already
 * reloads every load, so nothing else needs to invalidate.
 */
export const keepForm: SubmitFunction =
	() =>
	async ({ update }) => {
		await update({ reset: false });
	};

/** A `use:enhance` factory for a page's mutations; see `mutate` in the grocery list page. */
export type MutateEnhance = (options?: {
	/** Runs after the shared after-effects when the action succeeded. */
	onSuccess?: () => void;
	/** Fetch the page data again when the server rejected the change. */
	reloadOnFailure?: boolean;
}) => SubmitFunction;
