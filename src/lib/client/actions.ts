import { deserialize } from '$app/forms';
import type { ActionResult } from '@sveltejs/kit';

/**
 * POST a named form action (`/route?/action`) the way `use:enhance` would,
 * without a real `<form>` submit: build the `FormData`, mark the request so
 * SvelteKit answers with an action result instead of a redirect, and
 * deserialize the devalue-encoded response.
 */
export async function postAction<
	Success extends Record<string, unknown> | undefined = Record<string, unknown>,
	Failure extends Record<string, unknown> | undefined = Record<string, unknown>
>(url: string, fields: Record<string, string>): Promise<ActionResult<Success, Failure>> {
	const fd = new FormData();
	for (const [key, value] of Object.entries(fields)) fd.set(key, value);
	try {
		const res = await fetch(url, {
			method: 'POST',
			body: fd,
			headers: { 'x-sveltekit-action': 'true' }
		});
		return deserialize<Success, Failure>(await res.text());
	} catch (error) {
		// Network error or a response that isn't a serialized action result:
		// callers treat any non-"success" type as a failure to report.
		return { type: 'error', error };
	}
}
