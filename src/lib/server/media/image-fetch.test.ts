import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { fetchImageBytes } from './image-fetch';

/** A 1x1 GIF is the smallest thing that is genuinely an image. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function image(bytes: Buffer = PIXEL, headers: Record<string, string> = {}): Response {
	return new Response(new Uint8Array(bytes), {
		status: 200,
		headers: { 'content-type': 'image/gif', ...headers }
	});
}

function redirect(location: string, status = 301): Response {
	return new Response(null, { status, headers: { location } });
}

/** A fetch that answers from a queue and records the URLs it was asked for. */
function queue(...responses: Response[]) {
	const asked: string[] = [];
	const impl = async (url: string) => {
		asked.push(url);
		const next = responses.shift();
		if (!next) throw new Error(`no queued response for ${url}`);
		return next;
	};
	return { impl, asked };
}

const opts = (extra: Record<string, unknown> = {}) => ({ maxBytes: 1000, ...extra });

async function failure(run: Promise<unknown>): Promise<AppError> {
	try {
		await run;
	} catch (err) {
		if (err instanceof AppError) return err;
		throw err;
	}
	throw new Error('expected a failure');
}

describe('fetchImageBytes', () => {
	it('returns the bytes of the picture', async () => {
		const { impl, asked } = queue(image());
		const bytes = await fetchImageBytes('https://example.com/dal.gif', opts({ fetchImpl: impl }));
		expect(bytes.equals(PIXEL)).toBe(true);
		expect(asked).toEqual(['https://example.com/dal.gif']);
	});

	it('accepts a URL with no scheme by assuming https', async () => {
		const { impl, asked } = queue(image());
		await fetchImageBytes('example.com/dal.gif', opts({ fetchImpl: impl }));
		expect(asked).toEqual(['https://example.com/dal.gif']);
	});

	it('refuses a scheme that is not http or https', async () => {
		const { impl } = queue(image());
		const err = await failure(fetchImageBytes('file:///etc/passwd', opts({ fetchImpl: impl })));
		expect(err.status).toBe(400);
		expect(err.message).toMatch(/web address/i);
	});

	it('refuses text that is not a URL', async () => {
		const { impl } = queue(image());
		const err = await failure(fetchImageBytes('not a url', opts({ fetchImpl: impl })));
		expect(err.status).toBe(400);
	});

	it('follows a redirect to the picture', async () => {
		const { impl, asked } = queue(redirect('https://cdn.example.com/dal.gif'), image());
		const bytes = await fetchImageBytes('https://example.com/dal.gif', opts({ fetchImpl: impl }));
		expect(bytes.equals(PIXEL)).toBe(true);
		expect(asked).toEqual(['https://example.com/dal.gif', 'https://cdn.example.com/dal.gif']);
	});

	it('stops after the redirect ceiling', async () => {
		const { impl, asked } = queue(
			redirect('https://example.com/1'),
			redirect('https://example.com/2'),
			redirect('https://example.com/3'),
			redirect('https://example.com/4')
		);
		const err = await failure(
			fetchImageBytes('https://example.com/0', opts({ fetchImpl: impl, maxRedirects: 3 }))
		);
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/too many redirects/i);
		expect(asked).toHaveLength(4);
	});

	it('refuses a link that is a page and not a picture', async () => {
		const { impl } = queue(
			new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
		);
		const err = await failure(
			fetchImageBytes('https://example.com/dal', opts({ fetchImpl: impl }))
		);
		expect(err.status).toBe(415);
		expect(err.message).toMatch(/not a picture/i);
	});

	it('accepts a picture served with no content type', async () => {
		const { impl } = queue(new Response(new Uint8Array(PIXEL), { status: 200 }));
		const bytes = await fetchImageBytes('https://example.com/dal.gif', opts({ fetchImpl: impl }));
		expect(bytes.equals(PIXEL)).toBe(true);
	});

	it('refuses a picture that declares more than the byte cap', async () => {
		const { impl } = queue(image(PIXEL, { 'content-length': '2000' }));
		const err = await failure(
			fetchImageBytes('https://example.com/dal.gif', opts({ fetchImpl: impl, maxBytes: 1000 }))
		);
		expect(err.status).toBe(413);
	});

	it('stops reading a body that passes the byte cap while it streams', async () => {
		// The header understates the body, so only the read itself can catch this.
		const { impl } = queue(image(Buffer.alloc(5000, 1), { 'content-length': '10' }));
		const err = await failure(
			fetchImageBytes('https://example.com/dal.gif', opts({ fetchImpl: impl, maxBytes: 1000 }))
		);
		expect(err.status).toBe(413);
		expect(err.message).toMatch(/larger than/i);
	});

	it('refuses an empty body', async () => {
		const { impl } = queue(
			new Response(null, { status: 200, headers: { 'content-type': 'image/gif' } })
		);
		const err = await failure(
			fetchImageBytes('https://example.com/dal.gif', opts({ fetchImpl: impl }))
		);
		expect(err.status).toBe(400);
	});

	it('reports a refusal by the site', async () => {
		const { impl } = queue(new Response('no', { status: 403 }));
		const err = await failure(
			fetchImageBytes('https://example.com/dal.gif', opts({ fetchImpl: impl }))
		);
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/refused/i);
	});

	it('reports any other status with the number', async () => {
		const { impl } = queue(new Response('boom', { status: 503 }));
		const err = await failure(
			fetchImageBytes('https://example.com/dal.gif', opts({ fetchImpl: impl }))
		);
		expect(err.message).toMatch(/503/);
	});

	it('reports a connection failure', async () => {
		const impl = async () => {
			throw new TypeError('fetch failed');
		};
		const err = await failure(
			fetchImageBytes('https://nope.invalid/x.gif', opts({ fetchImpl: impl }))
		);
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/could not reach/i);
	});

	it('reports a timeout as a timeout', async () => {
		const impl = async () => {
			throw new DOMException('aborted', 'TimeoutError');
		};
		const err = await failure(
			fetchImageBytes('https://slow.example/x.gif', opts({ fetchImpl: impl }))
		);
		expect(err.status).toBe(504);
		expect(err.message).toMatch(/too long/i);
	});
});
