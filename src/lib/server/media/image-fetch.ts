import { AppError } from '$lib/server/errors';
import { createImportTransport } from '$lib/server/import-transport';
import {
	discardBody,
	fetchWithRedirects,
	readCapped,
	type FetchImpl
} from '$lib/server/fetch-capped';

/**
 * Read a picture over the network.
 *
 * The browser cannot do this itself: an image host sends no CORS headers, so the
 * fetch must happen here. The bytes go straight into the usual image pipeline,
 * which decodes them, checks the real format and writes bounded WebP variants.
 * Nothing here trusts the content-type header beyond a first refusal.
 *
 * Production downloads go through Smokescreen, which rejects private and
 * special-use destinations and connects to the address it checked.
 */

const USER_AGENT = 'my-kitchen (recipe image)';
const ACCEPT = 'image/*;q=0.9,*/*;q=0.1';
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_REDIRECTS = 3;
const TIMEOUT_MESSAGE = 'That site took too long to send the picture.';

export type { FetchImpl };

export interface FetchImageOptions {
	/** Largest picture to read. The caller owns this number. */
	maxBytes: number;
	timeoutMs?: number;
	maxRedirects?: number;
	/** Test seam. Production uses its owned proxy transport. */
	fetchImpl?: FetchImpl;
	/** Explicit proxy for isolated transport fixtures; production uses server configuration. */
	proxyUrl?: string;
}

function tooLarge(maxBytes: number): never {
	const mb = Math.round(maxBytes / 1024 / 1024);
	throw new AppError(413, `That picture is larger than ${mb} MB.`);
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

export async function fetchImageBytes(raw: string, options: FetchImageOptions): Promise<Buffer> {
	const { maxBytes } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const transport = createImportTransport(timeoutMs, options.proxyUrl);
	try {
		const { response } = await fetchWithRedirects(raw, {
			accept: ACCEPT,
			userAgent: USER_AGENT,
			timeoutMs,
			maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
			timeoutMessage: TIMEOUT_MESSAGE,
			noLocationMessage: 'That link redirects to nothing.',
			fetchImpl: options.fetchImpl ?? transport.fetch
		});

		try {
			if (!response.ok) throw statusError(response.status);
			checkType(response);
		} catch (err) {
			await discardBody(response);
			throw err;
		}
		const bytes = await readCapped(response, maxBytes, tooLarge, TIMEOUT_MESSAGE);
		// Only emptiness is judged here. Whether the bytes decode as a picture is
		// the storage pipeline's question, and it asks sharp rather than a header.
		if (bytes.length === 0) throw new AppError(400, 'That link did not give back a picture.');
		return bytes;
	} finally {
		await transport.destroy();
	}
}
