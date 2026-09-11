import { AppError } from '$lib/server/errors';
import { toHttpUrl } from '$lib/server/remote-url';

/**
 * Read a recipe page over the network.
 *
 * The browser cannot do this itself: a recipe site sends no CORS headers, so the
 * fetch must happen here. The bytes are treated exactly like a pasted page —
 * parsed for text only, kept as an attachment, never rendered and never run.
 *
 * There is no restriction on which address this reaches, by decision: a private
 * or loopback URL is fetched like any other. The caller rate-limits instead.
 * Put the address check in this module if that decision changes.
 */

const USER_AGENT = 'my-kitchen (recipe import)';
const ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1';
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Save the page yourself: the answer to every refusal by a site. */
const FALLBACK = 'Save the page in your browser, then use Import an HTML page.';

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchPageOptions {
	/** Largest page to read. The caller owns this number. */
	maxBytes: number;
	timeoutMs?: number;
	maxRedirects?: number;
	/** Test seam. Production passes nothing and gets global fetch. */
	fetchImpl?: FetchImpl;
}

export interface FetchedPage {
	html: string;
	/** The URL the page came from, after any redirect. */
	finalUrl: string;
	/** A name for the source attachment, taken from the URL. */
	filename: string;
}

function tooLarge(maxBytes: number): AppError {
	const mb = Math.round(maxBytes / 1_000_000);
	return new AppError(413, `That page is larger than ${mb} MB.`);
}

/** "example.com-recipes-dal.html" — readable in the attachment list. */
function filenameFor(url: URL): string {
	const stem = `${url.host}${url.pathname}`
		.replace(/[^a-z0-9.-]+/gi, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 100);
	return `${stem || 'page'}.html`;
}

/** Only a page is useful here. A PDF link goes through the PDF import instead. */
function checkType(res: Response): void {
	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!type) return;
	if (type.startsWith('text/') || type === 'application/xhtml+xml') return;
	throw new AppError(415, `That link is not a web page. If it is a PDF, use Import a PDF.`);
}

function statusError(status: number): AppError {
	if (status === 401 || status === 403 || status === 429)
		return new AppError(502, `The site refused the request. ${FALLBACK}`);
	if (status === 404 || status === 410)
		return new AppError(502, `The site could not find that page. Check the link, or: ${FALLBACK}`);
	return new AppError(502, `The site answered with ${status}. ${FALLBACK}`);
}

/**
 * Read the body, and stop at the cap.
 *
 * Content-length is checked first because it is cheap, and again while reading
 * because a header can understate the body.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
	if (!res.body) return '';
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
	return Buffer.concat(chunks).toString('utf8');
}

export async function fetchRecipePage(
	raw: string,
	options: FetchPageOptions
): Promise<FetchedPage> {
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
				throw new AppError(504, 'That site took too long to answer. Try again, or: ' + FALLBACK);
			throw new AppError(502, 'Could not reach that site. Check the link and your network.');
		}

		if (REDIRECT_STATUSES.has(res.status)) {
			const location = res.headers.get('location');
			if (!location) throw new AppError(502, `That link redirects to nothing. ${FALLBACK}`);
			if (hop >= maxRedirects) throw new AppError(502, `That link has too many redirects.`);
			url = toHttpUrl(location, url.toString());
			continue;
		}

		if (!res.ok) throw statusError(res.status);
		checkType(res);
		return {
			html: await readCapped(res, maxBytes),
			finalUrl: url.toString(),
			filename: filenameFor(url)
		};
	}
}
