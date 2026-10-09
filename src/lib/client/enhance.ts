import { invalidate } from '$app/navigation';
import type { SubmitFunction } from '@sveltejs/kit';
import { pushToast } from './toast.svelte';

/**
 * `use:enhance` that keeps what the person typed. On success `update()` already
 * reloads every load, so nothing else needs to invalidate.
 */
export const keepForm: SubmitFunction =
	() =>
	async ({ update }) => {
		await update({ reset: false });
	};

/**
 * `use:enhance` that runs `update()` and then, only when the action succeeded,
 * the follow-ups: `then` (close a sheet, clear a field), a success toast, and an
 * `invalidate` of one key. The form keeps what was typed unless `reset` is true.
 */
export function onSuccess(
	message: string | undefined,
	options: {
		reset?: boolean;
		then?: () => void;
		invalidate?: string;
		/** Reload this key when the server rejected the change. */
		invalidateOnFailure?: string;
	} = {}
): SubmitFunction {
	return () =>
		async ({ result, update }) => {
			await update(options.reset ? undefined : { reset: false });
			if (result.type === 'success') {
				options.then?.();
				if (message) pushToast(message, { kind: 'success' });
				if (options.invalidate) await invalidate(options.invalidate);
			} else if (result.type === 'failure' && options.invalidateOnFailure) {
				await invalidate(options.invalidateOnFailure);
			}
		};
}

/** A `use:enhance` factory for a page's mutations; see `mutate` in the grocery list page. */
export type MutateEnhance = (options?: {
	/** Runs after the shared after-effects when the action succeeded. */
	onSuccess?: () => void;
	/** Fetch the page data again when the server rejected the change. */
	reloadOnFailure?: boolean;
}) => SubmitFunction;
