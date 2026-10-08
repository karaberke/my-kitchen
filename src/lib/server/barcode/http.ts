/**
 * The one way this feature reaches a provider.
 *
 * Unlike the recipe-link import, which fetches an address the user chose, these
 * requests only ever go to the two fixed origins configured for the feature.
 * Redirects are refused rather than followed, the body is capped while it
 * streams, and every call carries its own timeout.
 */

import { discardBody, readCappedOrNull, type FetchImpl } from '$lib/server/fetch-capped';
import type { ProviderResult } from './types';

export interface JsonFetchOptions {
	timeoutMs: number;
	maxBytes: number;
	headers: Record<string, string>;
	/** Cancels the request when the whole lookup budget runs out. */
	signal?: AbortSignal;
	/** Test seam. Production passes nothing and gets global fetch. */
	fetchImpl?: FetchImpl;
}

export type JsonFetch =
	| { ok: true; status: number; body: unknown }
	| { ok: false; kind: 'rate_limited'; retryAfterSeconds: number }
	| { ok: false; kind: 'status'; status: number }
	| { ok: false; kind: 'network' | 'timeout' | 'redirect' | 'too_large' | 'not_json' };

/** Both providers answer 429, and sometimes 403, when this address asked too often. */
const RATE_LIMIT_STATUSES = new Set([429, 403]);

function retryAfterOf(res: Response): number {
	const raw = res.headers.get('retry-after');
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds > 0) return Math.min(3600, Math.ceil(seconds));
	return 60;
}

export async function fetchJson(url: string, options: JsonFetchOptions): Promise<JsonFetch> {
	const doFetch: FetchImpl = options.fetchImpl ?? ((u, init) => fetch(u, init));
	const timeout = AbortSignal.timeout(options.timeoutMs);
	const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

	let res: Response;
	try {
		res = await doFetch(url, {
			method: 'GET',
			redirect: 'manual',
			signal,
			headers: { accept: 'application/json', ...options.headers }
		});
	} catch (err) {
		const name = (err as { name?: string } | null)?.name;
		return {
			ok: false,
			kind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network'
		};
	}

	// A provider that redirects is not answering the question that was asked.
	if (res.status >= 300 && res.status < 400) {
		await discardBody(res);
		return { ok: false, kind: 'redirect' };
	}

	if (RATE_LIMIT_STATUSES.has(res.status)) {
		await discardBody(res);
		return { ok: false, kind: 'rate_limited', retryAfterSeconds: retryAfterOf(res) };
	}

	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	// A 404 is an answer, so it is read; anything else that is not JSON is not.
	if (type && type !== 'application/json' && res.status !== 404) {
		await discardBody(res);
		return { ok: false, kind: 'not_json' };
	}

	const bytes = await readCappedOrNull(res, options.maxBytes);
	if (bytes === null) return { ok: false, kind: 'too_large' };

	if (!res.ok && res.status !== 404) return { ok: false, kind: 'status', status: res.status };

	const text = bytes.toString('utf8');
	let body: unknown;
	try {
		body = text === '' ? null : JSON.parse(text);
	} catch {
		return { ok: false, kind: 'not_json' };
	}
	return { ok: true, status: res.status, body };
}

/**
 * What a failed fetch means to the lookup. `label` names the provider in the
 * reason; nothing about the request itself is reported, because the USDA key
 * travels in the query string.
 */
export function failedLookup(res: Exclude<JsonFetch, { ok: true }>, label: string): ProviderResult {
	if (res.kind === 'rate_limited')
		return { status: 'rate_limited', retryAfterSeconds: res.retryAfterSeconds };
	return { status: 'unavailable', reason: `${label} ${res.kind}` };
}
