import { AppError } from '$lib/server/errors';
import { toHttpUrl } from '$lib/server/remote-url';

/**
 * Read a picture over the network.
 *
 * The browser cannot do this itself: an image host sends no CORS headers, so the
 * fetch must happen here. The bytes go straight into the usual image pipeline,
 * which decodes them, checks the real format and writes bounded WebP variants.
 * Nothing here trusts the content-type header beyond a first refusal.
 *
 * There is no restriction on which address this reaches, by decision, exactly as
 * in import-fetch.ts: a private or loopback URL is fetched like any other. The
 * caller rate-limits instead. Put the address check in this module if that
 * decision changes.
 */

const USER_AGENT = 'my-kitchen (recipe image)';
const ACCEPT = 'image/*;q=0.9,*/*;q=0.1';
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchImageOptions {
	/** Largest picture to read. The caller owns this number. */
	maxBytes: number;
	timeoutMs?: number;
	maxRedirects?: number;
	/** Test seam. Production passes nothing and gets global fetch. */
	fetchImpl?: FetchImpl;
}

function tooLarge(maxBytes: number): AppError {
	const mb = Math.round(maxBytes / 1024 / 1024);
	return new AppError(413, `That picture is larger than ${mb} MB.`);
}

/** Only a picture is useful here. A page link is a common paste mistake. */
function checkType(res: Response): void {
	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!type) return;
	if (type.startsWith('image/')) return;
	throw new AppError(
		415,
		'That link is not a picture. Open the image itself, then copy its address.'
	);
}

function statusError(status: number): AppError {
	if (status === 401 || status === 403 || status === 429)
		return new AppError(502, 'The site refused the request for that picture.');
	if (status === 404 || status === 410)
		return new AppError(502, 'The site could not find that picture. Check the link.');
	return new AppError(502, `The site answered with ${status}.`);
}

/**
 * Read the body, and stop at the cap.
 *
 * Content-length is checked first because it is cheap, and again while reading
 * because a header can understate the body.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
	if (!res.body) return Buffer.alloc(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw tooLarge(maxBytes);
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks);
}

export async function fetchImageBytes(raw: string, options: FetchImageOptions): Promise<Buffer> {
	const { maxBytes } = options;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const doFetch: FetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

	let url = toHttpUrl(raw);
	for (let hop = 0; ; hop++) {
		let res: Response;
		try {
			res = await doFetch(url.toString(), {
				method: 'GET',
				redirect: 'manual',
				signal: AbortSignal.timeout(timeoutMs),
				headers: { accept: ACCEPT, 'user-agent': USER_AGENT }
			});
		} catch (err) {
			const name = (err as { name?: string } | null)?.name;
			if (name === 'TimeoutError' || name === 'AbortError')
				throw new AppError(504, 'That site took too long to send the picture.');
			throw new AppError(502, 'Could not reach that site. Check the link and your network.');
		}

		if (REDIRECT_STATUSES.has(res.status)) {
			const location = res.headers.get('location');
			if (!location) throw new AppError(502, 'That link redirects to nothing.');
			if (hop >= maxRedirects) throw new AppError(502, 'That link has too many redirects.');
			url = toHttpUrl(location, url.toString());
			continue;
		}

		if (!res.ok) throw statusError(res.status);
		checkType(res);
		const bytes = await readCapped(res, maxBytes);
		// Only emptiness is judged here. Whether the bytes decode as a picture is
		// the storage pipeline's question, and it asks sharp rather than a header.
		if (bytes.length === 0) throw new AppError(400, 'That link did not give back a picture.');
		return bytes;
	}
}
