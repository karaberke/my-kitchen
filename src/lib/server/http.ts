import { error, type RequestEvent } from '@sveltejs/kit';
import { asAppError } from '$lib/server/errors';

/**
 * Explicit caching policy per response type.
 *
 * - Hashed immutable assets under /_app/immutable/ are emitted by SvelteKit with
 *   `public, max-age=31536000, immutable`; we leave them untouched.
 * - Everything dynamic (HTML, data, auth, API, exports) is `private, no-store`.
 * - The private media endpoint sets its own `private, max-age=300` + ETag policy.
 * - Unversioned public static files get a short revalidating policy.
 */
/**
 * How long a viewer's own browser may reuse media it already fetched.
 *
 * Media URLs are content-addressed — images carry `?v={image.version}` and attachments are
 * write-once — so the bytes behind a given URL never change. This window is therefore not
 * about freshness but about authorisation: it bounds how long someone who has lost access
 * keeps seeing a file already in their cache. Short on purpose, for the same reason the
 * session cookie cache is disabled in auth.ts.
 *
 * Previously `no-cache`, which forced a revalidation — and a full auth preamble plus a
 * correlated EXISTS — for every image on every page view.
 */
export const MEDIA_CACHE_CONTROL = 'private, max-age=300';

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
		if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store');
	} else if (isPublicStaticAsset(path)) {
		headers.set('cache-control', 'public, max-age=600, must-revalidate');
	} else {
		headers.set('cache-control', 'private, no-store');
		headers.set('pragma', 'no-cache');
	}

	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	headers.set('x-frame-options', 'DENY');
	// The barcode scanner needs the camera, and only this origin gets it. The
	// microphone and location are still refused to everyone, this app included.
	headers.set('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
	// Only over https: a plain-http LAN install would lock itself out of its own
	// hostname for a year. The Content-Security-Policy comes from kit.csp.
	if (event.url.protocol === 'https:')
		headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
	return response;
}

function isPublicStaticAsset(path: string): boolean {
	return /^\/(robots\.txt|favicon\.ico|favicon-\d+x\d+\.png|apple-touch-icon\.png|android-chrome-\d+x\d+\.png|site\.webmanifest)$/.test(
		path
	);
}

export function noStoreJson(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	headers.set('cache-control', 'private, no-store');
	return new Response(JSON.stringify(data), { ...init, headers });
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
			const app = asAppError(err);
			if (app)
				error(app.status, {
					message: app.message,
					code: app.status === 401 ? 'unauthorized' : app.status === 403 ? 'forbidden' : undefined
				});
			throw err;
		}
	}) as F;
}
