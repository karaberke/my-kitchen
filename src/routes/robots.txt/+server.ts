import type { RequestHandler } from './$types';

/** Served by the app (not the static handler) so its cache policy is explicit: short, revalidating. */
export const GET: RequestHandler = () =>
	new Response('User-agent: *\nDisallow: /\n', {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'public, max-age=86400, must-revalidate',
			'x-cache-policy': 'static'
		}
	});
