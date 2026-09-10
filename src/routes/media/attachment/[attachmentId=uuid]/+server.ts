import { error } from '@sveltejs/kit';
import { guard, MEDIA_CACHE_CONTROL } from '$lib/server/http';
import type { RequestEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { loadReadableAttachment } from '$lib/server/media/attachments';
import { storage } from '$lib/server/media/storage';

/**
 * Private source files. Authorization runs before any bytes or a 304, as with
 * images.
 *
 * Both PDFs and saved HTML open in the viewer's tab, but a stored page is never
 * trusted: the CSP `sandbox` directive (with no allow-scripts and no
 * allow-same-origin) drops it into an opaque origin where no script runs and it
 * can reach neither this app's cookies nor its DOM. `default-src 'none'` also
 * stops it fetching anything, so opening one leaks no request to its origin
 * site. Inline styles are allowed so the page stays readable.
 */
const SANDBOX_CSP = [
	'sandbox',
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	'img-src data:',
	'font-src data:',
	"form-action 'none'",
	"base-uri 'none'"
].join('; ');
/**
 * `Content-Disposition` for a user-supplied filename.
 *
 * Header values are ByteStrings, so any code point above 255 makes `new
 * Headers()` throw — and browsers name a saved page after its <title>, which
 * routinely carries an emoji, a curly quote or a non-Latin script. RFC 6266
 * gives the plain `filename` an ASCII fallback and puts the real name in
 * `filename*`, which every current browser prefers.
 */
function contentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || 'source';
	return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const GETImpl = async (event: RequestEvent) => {
	const user = requireUserApi(event);
	if (!/^[0-9a-f-]{36}$/i.test(event.params.attachmentId)) throw error(404, 'Not found');
	const att = await loadReadableAttachment(db, user.id, event.params.attachmentId);
	if (!att) throw error(404, 'Not found');

	const etag = `"${att.id}"`;
	const isPdf = att.mime === 'application/pdf';
	const headers = new Headers({
		'cache-control': MEDIA_CACHE_CONTROL,
		etag,
		vary: 'Cookie',
		'x-cache-policy': 'media',
		'content-type': isPdf ? 'application/pdf' : 'text/html; charset=utf-8',
		'content-disposition': contentDisposition(att.filename),
		'content-security-policy': SANDBOX_CSP,
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer'
	});
	const inm = event.request.headers.get('if-none-match');
	if (inm && inm.split(',').some((t) => t.trim() === etag)) {
		return new Response(null, { status: 304, headers });
	}
	const obj = await storage().get(att.objectKey);
	if (!obj) throw error(404, 'Not found');
	if (obj.size !== null) headers.set('content-length', String(obj.size));
	return new Response(obj.stream, { status: 200, headers });
};

export const GET = guard(GETImpl);
