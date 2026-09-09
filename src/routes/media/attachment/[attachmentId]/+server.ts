import { error } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { RequestEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { loadReadableAttachment } from '$lib/server/media/attachments';
import { storage } from '$lib/server/media/storage';

/**
 * Private source files. Authorization runs before any bytes or a 304, as with
 * images. A PDF opens inline; anything else — HTML above all — is sent as a
 * download with a neutralised content type, so a stored page can never run in
 * the app's origin.
 */
const GETImpl = async (event: RequestEvent) => {
	const user = requireUserApi(event);
	if (!/^[0-9a-f-]{36}$/i.test(event.params.attachmentId)) throw error(404, 'Not found');
	const att = await loadReadableAttachment(db, user.id, event.params.attachmentId);
	if (!att) throw error(404, 'Not found');

	const etag = `"${att.id}"`;
	const isPdf = att.mime === 'application/pdf';
	const headers = new Headers({
		'cache-control': 'private, no-cache',
		etag,
		vary: 'Cookie',
		'x-cache-policy': 'media',
		'content-type': isPdf ? 'application/pdf' : 'application/octet-stream',
		'content-disposition': `${isPdf ? 'inline' : 'attachment'}; filename="${att.filename.replace(/"/g, '')}"`,
		// Belt and braces: nothing served here may execute or embed anything.
		'content-security-policy': "default-src 'none'; sandbox",
		'x-content-type-options': 'nosniff'
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
