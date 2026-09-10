import { describe, expect, it } from 'vitest';
import { AppError } from './errors';
import { fetchRecipePage } from './import-fetch';

function html(body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8', ...headers }
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

describe('fetchRecipePage', () => {
	it('returns the page text and the URL it came from', async () => {
		const { impl, asked } = queue(html('<html><body>Dal</body></html>'));
		const page = await fetchRecipePage(
			'https://example.com/recipes/dal',
			opts({ fetchImpl: impl })
		);
		expect(page.html).toBe('<html><body>Dal</body></html>');
		expect(page.finalUrl).toBe('https://example.com/recipes/dal');
		expect(asked).toEqual(['https://example.com/recipes/dal']);
	});

	it('names the attachment after the host and path', async () => {
		const { impl } = queue(html('<html></html>'));
		const page = await fetchRecipePage(
			'https://example.com/recipes/red-lentil-dal?utm=1',
			opts({ fetchImpl: impl })
		);
		expect(page.filename).toBe('example.com-recipes-red-lentil-dal.html');
	});

	it('names the attachment after the host alone when the path is empty', async () => {
		const { impl } = queue(html('<html></html>'));
		const page = await fetchRecipePage('https://example.com/', opts({ fetchImpl: impl }));
		expect(page.filename).toBe('example.com.html');
	});

	it('accepts a URL with no scheme by assuming https', async () => {
		const { impl, asked } = queue(html('<html></html>'));
		await fetchRecipePage('example.com/dal', opts({ fetchImpl: impl }));
		expect(asked).toEqual(['https://example.com/dal']);
	});

	it('refuses a scheme that is not http or https', async () => {
		const { impl } = queue(html('<html></html>'));
		const err = await failure(fetchRecipePage('file:///etc/passwd', opts({ fetchImpl: impl })));
		expect(err.status).toBe(400);
		expect(err.message).toMatch(/web address/i);
	});

	it('refuses text that is not a URL', async () => {
		const { impl } = queue(html('<html></html>'));
		const err = await failure(fetchRecipePage('not a url', opts({ fetchImpl: impl })));
		expect(err.status).toBe(400);
	});

	it('follows a redirect and reports the final URL', async () => {
		const { impl, asked } = queue(redirect('https://example.com/new'), html('<html>moved</html>'));
		const page = await fetchRecipePage('https://example.com/old', opts({ fetchImpl: impl }));
		expect(page.html).toBe('<html>moved</html>');
		expect(page.finalUrl).toBe('https://example.com/new');
		expect(asked).toEqual(['https://example.com/old', 'https://example.com/new']);
	});

	it('resolves a relative redirect against the current URL', async () => {
		const { impl, asked } = queue(redirect('/recipes/dal'), html('<html></html>'));
		await fetchRecipePage('https://example.com/old/page', opts({ fetchImpl: impl }));
		expect(asked[1]).toBe('https://example.com/recipes/dal');
	});

	it('stops after the redirect ceiling', async () => {
		const { impl, asked } = queue(
			redirect('https://example.com/1'),
			redirect('https://example.com/2'),
			redirect('https://example.com/3'),
			redirect('https://example.com/4')
		);
		const err = await failure(
			fetchRecipePage('https://example.com/0', opts({ fetchImpl: impl, maxRedirects: 3 }))
		);
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/too many redirects/i);
		expect(asked).toHaveLength(4);
	});

	it('refuses a redirect to a scheme that is not http or https', async () => {
		const { impl } = queue(redirect('file:///etc/passwd'));
		const err = await failure(fetchRecipePage('https://example.com', opts({ fetchImpl: impl })));
		expect(err.status).toBe(400);
	});

	it('refuses a redirect with no location', async () => {
		const { impl } = queue(new Response(null, { status: 302 }));
		const err = await failure(fetchRecipePage('https://example.com', opts({ fetchImpl: impl })));
		expect(err.status).toBe(502);
	});

	it('refuses a page that declares more than the byte cap', async () => {
		const { impl } = queue(html('<html></html>', { 'content-length': '2000' }));
		const err = await failure(
			fetchRecipePage('https://example.com', opts({ fetchImpl: impl, maxBytes: 1000 }))
		);
		expect(err.status).toBe(413);
	});

	it('stops reading a body that passes the byte cap while it streams', async () => {
		// The header understates the body, so only the read itself can catch this.
		const { impl } = queue(html('x'.repeat(5000), { 'content-length': '10' }));
		const err = await failure(
			fetchRecipePage('https://example.com', opts({ fetchImpl: impl, maxBytes: 1000 }))
		);
		expect(err.status).toBe(413);
		expect(err.message).toMatch(/larger than/i);
	});

	it('refuses a response that is not HTML', async () => {
		const { impl } = queue(
			new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } })
		);
		const err = await failure(
			fetchRecipePage('https://example.com/x.pdf', opts({ fetchImpl: impl }))
		);
		expect(err.status).toBe(415);
		expect(err.message).toMatch(/Import a PDF/);
	});

	it('accepts a response with no content type at all', async () => {
		const { impl } = queue(new Response('<html></html>', { status: 200 }));
		const page = await fetchRecipePage('https://example.com', opts({ fetchImpl: impl }));
		expect(page.html).toBe('<html></html>');
	});

	it('reports a refusal by the site and names the fallback', async () => {
		const { impl } = queue(new Response('no', { status: 403 }));
		const err = await failure(fetchRecipePage('https://example.com', opts({ fetchImpl: impl })));
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/refused/i);
		expect(err.message).toMatch(/save the page/i);
	});

	it('reports a page that is not there', async () => {
		const { impl } = queue(new Response('gone', { status: 404 }));
		const err = await failure(fetchRecipePage('https://example.com', opts({ fetchImpl: impl })));
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/not find/i);
	});

	it('reports any other status with the number', async () => {
		const { impl } = queue(new Response('boom', { status: 503 }));
		const err = await failure(fetchRecipePage('https://example.com', opts({ fetchImpl: impl })));
		expect(err.message).toMatch(/503/);
	});

	it('reports a connection failure', async () => {
		const impl = async () => {
			throw new TypeError('fetch failed');
		};
		const err = await failure(fetchRecipePage('https://nope.invalid', opts({ fetchImpl: impl })));
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/could not reach/i);
	});

	it('reports a timeout as a timeout', async () => {
		const impl = async () => {
			throw new DOMException('aborted', 'TimeoutError');
		};
		const err = await failure(fetchRecipePage('https://slow.example', opts({ fetchImpl: impl })));
		expect(err.status).toBe(504);
		expect(err.message).toMatch(/too long/i);
	});

	it('asks for HTML and identifies itself', async () => {
		let init: RequestInit | undefined;
		const impl = async (_url: string, got: RequestInit) => {
			init = got;
			return html('<html></html>');
		};
		await fetchRecipePage('https://example.com', opts({ fetchImpl: impl }));
		const headers = new Headers(init?.headers);
		expect(headers.get('accept')).toMatch(/text\/html/);
		expect(headers.get('user-agent')).toMatch(/my-kitchen/i);
		expect(init?.redirect).toBe('manual');
	});
});
