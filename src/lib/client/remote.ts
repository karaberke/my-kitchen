import { isHttpError, type RemoteQuery } from '@sveltejs/kit';

/**
 * One round trip for a remote query called from an event handler or a timer
 * rather than from markup. The client caches a query by its argument for as
 * long as anything still holds it, so awaiting the query itself can hand back
 * an earlier answer; `refresh()` always asks the server. Rejects with the
 * server's `HttpError`, or with a network error.
 */
export async function fetchFresh<T>(query: RemoteQuery<T>): Promise<T> {
	await query.refresh();
	return query.current as T;
}

/** The message a failed remote call carries from the server, or `fallback` (network errors, 500s). */
export function remoteErrorMessage(err: unknown, fallback: string): string {
	return isHttpError(err) && err.status < 500 && err.body.message ? err.body.message : fallback;
}
