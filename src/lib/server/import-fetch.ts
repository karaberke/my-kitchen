import { AppError } from '$lib/server/errors';
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
const TIMEOUT_MESSAGE = 'That site took too long to answer. Try again, or: ' + FALLBACK;

export type { FetchImpl };

export interface FetchPageOptions {
	/** Largest page to read. The caller owns this number. */
	maxBytes: number;
	timeoutMs?: number;
	maxRedirects?: number;
	/** Test seam. Production passes nothing and gets global fetch. */
	fetchImpl?: FetchImpl;
	/** Test seam for the automatic browser-profile retry. */
	fallbackFetchImpl?: FetchImpl;
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

/**
 * Impit has its own response class. Adapt its stream so the shared redirect,
 * timeout and byte-cap handling stays authoritative for both transports.
 */
async function createBrowserFetch(timeoutMs: number): Promise<FetchImpl> {
	const { Impit, TimeoutError } = await import('impit');
	// A client belongs to this import only; no cookies or user state are shared.
	const client = new Impit({
		browser: 'chrome',
		followRedirects: false,
		ignoreTlsErrors: false,
		timeout: timeoutMs
	});

	return async (url, init) => {
		const abort = new AbortController();
		const signal = init.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal;
		const normalizeError = (err: unknown): unknown => {
			if (signal.aborted) return signal.reason;
			return err instanceof TimeoutError ? new DOMException('Timed out', 'TimeoutError') : err;
		};
		const headers = new Headers(init.headers);
		// Overriding this would undo part of the Chrome impersonation.
		headers.delete('user-agent');
		let onAbort = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		const pending = client.fetch(url, {
			method: 'GET',
			redirect: 'manual',
			headers,
			signal,
			// Native connection setup also needs a timeout before a body exists.
			timeout: timeoutMs
		});
		let response: Awaited<typeof pending>;
		try {
			response = await Promise.race([pending, aborted]);
		} catch (err) {
			const reason = normalizeError(err);
			abort.abort(reason);
			// If native connection setup outlives the signal, discard its later answer.
			void pending.then((late) => late.body.cancel()).catch(() => {});
			throw reason;
		} finally {
			signal.removeEventListener('abort', onAbort);
		}

		const reader = response.body.getReader();
		const responseInit = {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		};
		// The standard Response constructor forbids bodies on these statuses.
		if ([204, 205, 304].includes(response.status)) {
			abort.abort();
			await reader.cancel().catch(() => {});
			return new Response(null, responseInit);
		}

		let finished = false;
		const finish = () => {
			finished = true;
			signal.removeEventListener('abort', onAbort);
		};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				onAbort = () => {
					finish();
					controller.error(normalizeError(signal.reason));
					void reader.cancel(signal.reason).catch(() => {});
				};
				signal.addEventListener('abort', onAbort, { once: true });
				if (signal.aborted) onAbort();
			},
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (finished) return;
					if (done) {
						finish();
						controller.close();
					} else controller.enqueue(value);
				} catch (err) {
					if (finished) return;
					const reason = normalizeError(err);
					finish();
					controller.error(reason);
					abort.abort(reason);
					void reader.cancel(reason).catch(() => {});
				}
			},
			async cancel(reason) {
				finish();
				// Abort first: cancelling a native reader alone can leave a stalled read open.
				abort.abort(reason);
				await reader.cancel(reason).catch(() => {});
			}
		});
		return new Response(body, responseInit);
	};
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
	let browserFetch: Promise<FetchImpl> | undefined;
	const fallbackFetch: FetchImpl =
		options.fallbackFetchImpl ??
		(async (url, init) => {
			browserFetch ??= createBrowserFetch(timeoutMs);
			return (await browserFetch)(url, init);
		});
	for (let retry = false; ; retry = true) {
		// Restart at the original address: the browser profile may redirect differently.
		const { response, url } = await fetchWithRedirects(raw, {
			...fetchOptions,
			fetchImpl: retry ? fallbackFetch : options.fetchImpl
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
}
