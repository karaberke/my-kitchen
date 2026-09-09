import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import {
	IMAGE_VARIANTS,
	loadReadableImage,
	variantKey,
	type ImageVariant
} from '$lib/server/media/images';
import { storage } from '$lib/server/media/storage';

/**
 * Private media endpoint. Authorization happens before any bytes or a 304 are
 * returned; the ETag is never a substitute for it. Browser may cache privately
 * but must revalidate every time; Cloudflare must bypass.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireUserApi(event);
	const variant = event.params.variant as ImageVariant;
	if (!(variant in IMAGE_VARIANTS)) throw error(404, 'Not found');
	if (!/^[0-9a-f-]{36}$/i.test(event.params.imageId)) throw error(404, 'Not found');
	const image = await loadReadableImage(db, user.id, event.params.imageId);
	if (!image) throw error(404, 'Not found');

	const etag = `"${image.id}:${image.version}:${variant}"`;
	const headers = new Headers({
		'cache-control': 'private, no-cache',
		etag,
		vary: 'Cookie',
		'x-cache-policy': 'media'
	});
	const inm = event.request.headers.get('if-none-match');
	if (inm && inm.split(',').some((t) => t.trim() === etag)) {
		return new Response(null, { status: 304, headers });
	}
	const obj = await storage().get(variantKey(image.objectKey, variant));
	if (!obj) throw error(404, 'Not found');
	const meta = image.variants[variant];
	headers.set('content-type', meta?.mime ?? obj.contentType ?? 'image/webp');
	if (obj.size !== null) headers.set('content-length', String(obj.size));
	headers.set('content-disposition', 'inline');
	return new Response(obj.stream, { status: 200, headers });
};
