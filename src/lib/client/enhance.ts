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
