import { AppError } from '$lib/server/errors';
import { toHttpUrl } from '$lib/server/remote-url';

/**
 * The low-level core shared by every outbound fetch a user starts (a recipe
 * page, a picture): a manual redirect loop with per-hop URL validation, a
 * timeout, and a byte-capped read of the body. Each caller keeps its own
 * Accept header, error messages, status-code mapping and decoding — this
 * module only follows redirects and stops at a byte cap.
 */

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchWithRedirectsOptions {
	accept: string;
	userAgent: string;
	timeoutMs: number;
	maxRedirects: number;
	/** Message for a 504 when the request times out. Caller-specific wording. */
	timeoutMessage: string;
	/** Message for a 502 when a redirect has no Location header. Caller-specific wording. */
	noLocationMessage: string;
	/** Test seam. Production passes nothing and gets global fetch. */
	fetchImpl?: FetchImpl;
}

export interface FetchWithRedirectsResult {
	response: Response;
	/** The URL the final response came from, after any redirect. */
	url: URL;
}

/**
 * Fetch `raw`, following same-loop redirects up to `maxRedirects`, with a
 * timeout per hop and `toHttpUrl` validation of every hop's address. Returns
 * the final, non-redirect response unread — the caller checks status and
 * content-type before it decides whether to read the body at all.
 */
export async function fetchWithRedirects(
	raw: string,
	options: FetchWithRedirectsOptions
): Promise<FetchWithRedirectsResult> {
	const doFetch: FetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

	let url = toHttpUrl(raw);
	for (let hop = 0; ; hop++) {
		let res: Response;
		try {
			res = await doFetch(url.toString(), {
				method: 'GET',
				redirect: 'manual',
				signal: AbortSignal.timeout(options.timeoutMs),
				headers: { accept: options.accept, 'user-agent': options.userAgent }
			});
		} catch (err) {
			const name = (err as { name?: string } | null)?.name;
			if (name === 'TimeoutError' || name === 'AbortError')
				throw new AppError(504, options.timeoutMessage);
			throw new AppError(502, 'Could not reach that site. Check the link and your network.');
		}

		if (REDIRECT_STATUSES.has(res.status)) {
			const location = res.headers.get('location');
			if (!location) throw new AppError(502, options.noLocationMessage);
			if (hop >= options.maxRedirects) throw new AppError(502, 'That link has too many redirects.');
			url = toHttpUrl(location, url.toString());
			continue;
		}

		return { response: res, url };
	}
}

/**
 * Read the body, and stop at the cap.
 *
 * Content-length is checked first because it is cheap, and again while reading
 * because a header can understate the body. `onTooLarge` never returns: it is
 * the caller's own 413, worded for what was being fetched.
 */
export async function readCapped(
	res: Response,
	maxBytes: number,
	onTooLarge: (maxBytes: number) => never
): Promise<Buffer> {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) onTooLarge(maxBytes);
	if (!res.body) return Buffer.alloc(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) onTooLarge(maxBytes);
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks);
}
