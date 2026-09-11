/**
 * The one way this feature reaches a provider.
 *
 * Unlike the recipe-link import, which fetches an address the user chose, these
 * requests only ever go to the two fixed origins configured for the feature.
 * Redirects are refused rather than followed, the body is capped while it
 * streams, and every call carries its own timeout.
 */

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

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
	| { ok: false; kind: 'status'; status: number; retryAfterSeconds: number }
	| { ok: false; kind: 'network' | 'timeout' | 'redirect' | 'too_large' | 'not_json' };

function retryAfterOf(res: Response): number {
	const raw = res.headers.get('retry-after');
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds > 0) return Math.min(3600, Math.ceil(seconds));
	return 60;
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) return null;
	if (!res.body) return '';
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) return null;
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks).toString('utf8');
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
	if (res.status >= 300 && res.status < 400) return { ok: false, kind: 'redirect' };

	if (res.status === 429 || res.status === 403)
		return { ok: false, kind: 'status', status: res.status, retryAfterSeconds: retryAfterOf(res) };

	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	// A 404 is an answer, so it is read; anything else that is not JSON is not.
	if (type && type !== 'application/json' && res.status !== 404)
		return { ok: false, kind: 'not_json' };

	const text = await readCapped(res, options.maxBytes);
	if (text === null) return { ok: false, kind: 'too_large' };

	if (!res.ok && res.status !== 404)
		return { ok: false, kind: 'status', status: res.status, retryAfterSeconds: 0 };

	let body: unknown;
	try {
		body = text === '' ? null : JSON.parse(text);
	} catch {
		return { ok: false, kind: 'not_json' };
	}
	return { ok: true, status: res.status, body };
}
