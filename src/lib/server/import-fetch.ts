import { AppError } from '$lib/server/errors';
import { createImportTransport } from '$lib/server/import-transport';
import {
	discardBody,
	fetchWithRedirects,
	readCapped,
	type FetchImpl
} from '$lib/server/fetch-capped';

/**
 * Read a recipe page over the network.
 *
 * The browser cannot do this itself: a recipe site sends no CORS headers, so the
 * fetch must happen here. The bytes are treated exactly like a pasted page —
 * parsed for text only, kept as an attachment, never rendered and never run.
 *
 * Every production attempt, including the Chrome-profile retry, goes through
 * Smokescreen. The proxy checks and pins public destination addresses.
 */

const USER_AGENT = 'my-kitchen (recipe import)';
const ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1';
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_REDIRECTS = 3;

/** Save the page yourself: the answer to every refusal by a site. */
const FALLBACK = 'Save the page in your browser, then use Import an HTML page.';
const TIMEOUT_MESSAGE = 'That site took too long to answer. Try again, or: ' + FALLBACK;

export type { FetchImpl };

export interface FetchPageOptions {
	/** Largest page to read. The caller owns this number. */
	maxBytes: number;
	timeoutMs?: number;
	maxRedirects?: number;
	/** Test seam. Production uses its owned proxy transport. */
	fetchImpl?: FetchImpl;
	/** Test seam for the automatic browser-profile retry. */
	fallbackFetchImpl?: FetchImpl;
	/** Explicit proxy for isolated transport fixtures; production uses server configuration. */
	proxyUrl?: string;
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
function isPage(res: Response): boolean {
	const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	return !type || type.startsWith('text/') || type === 'application/xhtml+xml';
}

function statusError(status: number): AppError {
	if (status === 401 || status === 403 || status === 429)
		return new AppError(502, `The site refused the request. ${FALLBACK}`);
	if (status === 404 || status === 410)
		return new AppError(502, `The site could not find that page. Check the link, or: ${FALLBACK}`);
	return new AppError(502, `The site answered with ${status}. ${FALLBACK}`);
}

function hasChallengeHeader(res: Response): boolean {
	return res.headers.get('cf-mitigated')?.trim().toLowerCase() === 'challenge';
}

/** Match a provider's interstitial, not a recipe mentioning browsers or CAPTCHA. */
function isChallengeHtml(html: string): boolean {
	const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() ?? '';
	return (
		/^(?:just a moment(?:\.{0,3}|…)|attention required!?(?:\s*\|\s*cloudflare)?|checking your browser(?:\.{0,3}|…))$/i.test(
			title
		) && /(?:window\._cf_chl_opt\b|\/cdn-cgi\/challenge-platform\/)/i.test(html)
	);
}

export async function fetchRecipePage(
	raw: string,
	options: FetchPageOptions
): Promise<FetchedPage> {
	const { maxBytes } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchOptions = {
		accept: ACCEPT,
		userAgent: USER_AGENT,
		timeoutMs,
		maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
		timeoutMessage: TIMEOUT_MESSAGE,
		noLocationMessage: `That link redirects to nothing. ${FALLBACK}`
	};
	const transport = createImportTransport(timeoutMs, options.proxyUrl);
	const primaryFetch = options.fetchImpl ?? transport.fetch;
	const fallbackFetch = options.fallbackFetchImpl ?? transport.browserFetch;
	try {
		for (let retry = false; ; retry = true) {
			// Restart at the original address: the browser profile may redirect differently.
			const { response, url } = await fetchWithRedirects(raw, {
				...fetchOptions,
				fetchImpl: retry ? fallbackFetch : primaryFetch
			});

			try {
				const excludedStatus = [404, 410, 429].includes(response.status);
				const blocked =
					!excludedStatus &&
					isPage(response) &&
					(response.status === 401 || response.status === 403 || hasChallengeHeader(response));
				if (blocked) {
					const declared = Number(response.headers.get('content-length'));
					if (Number.isFinite(declared) && declared > maxBytes) tooLarge(maxBytes);
					if (retry) throw statusError(403);
					await discardBody(response);
					continue;
				}
				if (!response.ok) throw statusError(response.status);
				if (!isPage(response))
					throw new AppError(415, `That link is not a web page. If it is a PDF, use Import a PDF.`);
				const bytes = await readCapped(response, maxBytes, tooLarge, TIMEOUT_MESSAGE);
				const html = bytes.toString('utf8');
				if (isChallengeHtml(html)) {
					if (retry) throw statusError(403);
					continue;
				}
				return { html, finalUrl: url.toString(), filename: filenameFor(url) };
			} catch (err) {
				await discardBody(response);
				throw err;
			}
		}
	} finally {
		await transport.destroy();
	}
}
