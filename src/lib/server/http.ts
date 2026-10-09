import { error, fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { asAppError, ReviewConflict, type ReviewDetail } from '$lib/server/errors';
import { parseAmount } from '$lib/shared/amount-parse';
import type { Dec } from '$lib/shared/decimal';
import { match as isUuid } from '../../params/uuid';

/**
 * How long a viewer's own browser may reuse media it already fetched.
 *
 * Media URLs are content-addressed — images carry `?v={image.version}` and attachments are
 * write-once — so the bytes behind a given URL never change. This window is therefore not
 * about freshness but about authorisation: it bounds how long someone who has lost access
 * keeps seeing a file already in their cache. Short on purpose, for the same reason the
 * session cookie cache is disabled in auth.ts.
 */
export const MEDIA_CACHE_CONTROL = 'private, max-age=300';

/** The default for every dynamic response: HTML, data, auth, exports. */
export const NO_STORE = 'private, no-store';

/** The headers of a private media response: past the shared policy, varied by cookie. */
export function mediaHeaders(etag: string, extra: Record<string, string> = {}): Headers {
	return new Headers({
		'cache-control': MEDIA_CACHE_CONTROL,
		etag,
		vary: 'Cookie',
		'x-cache-policy': 'media',
		...extra
	});
}

/** A 304 when the request already holds `etag`, else null. Call it only after the access check. */
export function notModified(event: RequestEvent, etag: string, headers: Headers): Response | null {
	const inm = event.request.headers.get('if-none-match');
	if (inm && inm.split(',').some((t) => t.trim() === etag))
		return new Response(null, { status: 304, headers });
	return null;
}

/** An uncached text download; with `filename`, the browser saves it as an attachment. */
export function downloadResponse(body: string, contentType: string, filename?: string): Response {
	const headers: Record<string, string> = {
		'content-type': contentType,
		'cache-control': NO_STORE
	};
	if (filename) headers['content-disposition'] = `attachment; filename="${filename}"`;
	return new Response(body, { headers });
}

export function applyResponsePolicy(event: RequestEvent, response: Response): Response {
	const headers = response.headers;
	const path = event.url.pathname;

	if (path.startsWith('/_app/immutable/')) {
		return response;
	}

	const explicit = headers.get('x-cache-policy');
	if (explicit) {
		headers.delete('x-cache-policy');
	} else if (path.startsWith('/media/')) {
		// media route sets its own headers; make sure nothing shared sneaks through
		if (!headers.has('cache-control')) headers.set('cache-control', NO_STORE);
	} else if (isPublicStaticAsset(path)) {
		headers.set('cache-control', 'public, max-age=600, must-revalidate');
	} else {
		headers.set('cache-control', NO_STORE);
		headers.set('pragma', 'no-cache');
	}

	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	headers.set('x-frame-options', 'DENY');
	// The barcode scanner needs the camera, and only this origin gets it. The
	// microphone is for spoken questions in cook mode, so only that page gets it;
	// location is refused to everyone, this app included.
	const microphone = isCookPage(path) ? '(self)' : '()';
	headers.set('permissions-policy', `camera=(self), microphone=${microphone}, geolocation=()`);
	// Only over https: a plain-http LAN install would lock itself out of its own
	// hostname for a year. The Content-Security-Policy comes from kit.csp.
	if (event.url.protocol === 'https:')
		headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
	return response;
}

/** The cook-mode page `/recipes/<uuid>/cook`, with the same id check as its route. */
function isCookPage(path: string): boolean {
	const m = /^\/recipes\/([^/]+)\/cook$/.exec(path);
	return m !== null && isUuid(m[1]);
}

function isPublicStaticAsset(path: string): boolean {
	return /^\/(robots\.txt|favicon\.ico|favicon-\d+x\d+\.png|apple-touch-icon\.png)$/.test(path);
}

/** Rethrow an application error as the matching HTTP error; anything else unchanged. */
function rethrowAsHttp(err: unknown): never {
	const app = asAppError(err);
	if (app)
		error(app.status, {
			message: app.message,
			code: app.status === 401 ? 'unauthorized' : app.status === 403 ? 'forbidden' : undefined
		});
	throw err;
}

/**
 * Map application errors thrown inside loads and endpoints to HTTP statuses
 * (404 stays 404, 401/403 stay what they are) instead of generic 500s.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function guard<F extends (event: any) => any>(fn: F): F {
	return (async (event: Parameters<F>[0]) => {
		try {
			return await fn(event);
		} catch (err) {
			rethrowAsHttp(err);
		}
	}) as F;
}

/**
 * The remote-function twin of `guard`: hand the handler the current request
 * event (a remote function gets only its argument) and map application errors
 * the same way. Handlers take the event explicitly so tests can call them.
 */
export function remote<A, R>(fn: (event: RequestEvent, arg: A) => Promise<R>) {
	return async (arg: A): Promise<R> => {
		try {
			return await fn(getRequestEvent(), arg);
		} catch (err) {
			rethrowAsHttp(err);
		}
	};
}

/** The failure `actionError` returns: one shape, so a page's `ActionData` reads it without a cast. */
export interface ActionErrorData {
	message: string;
	/** the payload of a `ReviewConflict` */
	review?: ReviewDetail;
	/** which form on the page failed, when the action names it */
	form?: string;
}

/**
 * Map application errors thrown inside a form action to `fail()`, the action
 * twin of `guard`. A `ReviewConflict` keeps its review payload. `form` names
 * the form on the page, as the action's own `fail()` calls do, so the page
 * shows the message beside it. Call sites with another extra field on the
 * failure keep their own inlined mapping instead of this helper.
 */
export function actionError(err: unknown, form?: string): ActionFailure<ActionErrorData> {
	const tag = form === undefined ? {} : { form };
	if (err instanceof ReviewConflict)
		return fail(409, { message: err.message, review: err.review, ...tag });
	const app = asAppError(err);
	if (app) return fail(app.status, { message: app.message, ...tag });
	throw err;
}

/** A form field as text, '' when it is missing. */
export function formText(fd: FormData, name: string): string {
	return String(fd.get(name) ?? '');
}

/** A form field as text, null when it is missing or blank. */
export function formTextOrNull(fd: FormData, name: string): string | null {
	return formText(fd, name) || null;
}

/** The `expectedRevision` field; -1, which no row has, when it is missing. */
export function expectedRevision(fd: FormData): number {
	return Number(fd.get('expectedRevision') ?? -1);
}

/** The location, use-by date and note fields of a pantry lot form. */
export function lotFields(fd: FormData) {
	return {
		location: formText(fd, 'location'),
		expiresOn: formTextOrNull(fd, 'expiresOn'),
		note: formText(fd, 'note')
	};
}

/**
 * A required amount field: the amount, or the 400 failure to return, with
 * `emptyMessage` for a blank field and the parser's message for a bad one.
 */
export function requiredAmount(
	fd: FormData,
	name: string,
	emptyMessage: string,
	form?: string
): { ok: true; value: Dec } | { ok: false; failure: ActionFailure<ActionErrorData> } {
	const parsed = parseAmount(formText(fd, name));
	if (parsed.ok && parsed.value) return { ok: true, value: parsed.value };
	const message = parsed.ok ? emptyMessage : parsed.error;
	return { ok: false, failure: fail(400, form === undefined ? { message } : { message, form }) };
}

/** Throwaway origin `safeNext` resolves against; any other origin means `raw` escaped the site. */
const NEXT_BASE = 'http://next.invalid';

/**
 * A same-origin path safe to redirect to after sign-in, or `fallback`.
 *
 * `raw.startsWith('/')` alone still passes a browser-relative URL like
 * `/\evil.com` or `/\t/evil.com`, which browsers normalise to `//evil.com`
 * (protocol-relative) before they navigate — so resolving against a fixed
 * base and checking the parsed origin is the only safe test.
 */
export function safeNext(raw: string | null | undefined, fallback = '/recipes'): string {
	if (!raw || !raw.startsWith('/')) return fallback;
	try {
		const url = new URL(raw, NEXT_BASE);
		return url.origin === NEXT_BASE ? url.pathname + url.search + url.hash : fallback;
	} catch {
		return fallback;
	}
}
