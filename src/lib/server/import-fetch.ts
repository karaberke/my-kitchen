import { AppError } from '$lib/server/errors';
import { fetchWithRedirects, readCapped, type FetchImpl } from '$lib/server/fetch-capped';

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

/** Save the page yourself: the answer to every refusal by a site. */
const FALLBACK = 'Save the page in your browser, then use Import an HTML page.';

export type { FetchImpl };

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

function tooLarge(maxBytes: number): never {
	const mb = Math.round(maxBytes / 1_000_000);
	throw new AppError(413, `That page is larger than ${mb} MB.`);
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

export async function fetchRecipePage(
	raw: string,
	options: FetchPageOptions
): Promise<FetchedPage> {
	const { maxBytes } = options;
	const { response, url } = await fetchWithRedirects(raw, {
		accept: ACCEPT,
		userAgent: USER_AGENT,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
		timeoutMessage: 'That site took too long to answer. Try again, or: ' + FALLBACK,
		noLocationMessage: `That link redirects to nothing. ${FALLBACK}`,
		fetchImpl: options.fetchImpl
	});

	if (!response.ok) throw statusError(response.status);
	checkType(response);
	const bytes = await readCapped(response, maxBytes, tooLarge);
	return {
		html: bytes.toString('utf8'),
		finalUrl: url.toString(),
		filename: filenameFor(url)
	};
}
