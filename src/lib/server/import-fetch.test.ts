import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Impit, ReadTimeout, type ImpitResponse } from 'impit';
import { describe, expect, it, vi } from 'vitest';
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

const opts = (extra: Record<string, unknown> = {}) => ({
	maxBytes: 1000,
	fallbackFetchImpl: queue(new Response('no', { status: 403 })).impl,
	...extra
});

const CHALLENGE_PAGE = `<html><head><title>Just a moment...</title></head>
<body><script>window._cf_chl_opt = {};</script>
<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></body></html>`;

/** An open response body records when the importer releases it. */
function watchedBody(name: string, cancelled: string[], init: ResponseInit = {}): Response {
	return new Response(
		new ReadableStream({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode('x'));
			},
			cancel() {
				cancelled.push(name);
			}
		}),
		init
	);
}

async function servePage(handler: RequestListener) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}

/** Only the network-facing fields are needed from a mocked native response. */
function nativePage(body: ReadableStream<Uint8Array>): ImpitResponse {
	return {
		status: 200,
		statusText: 'OK',
		headers: new Headers({ 'content-type': 'text/html' }),
		body
	} as ImpitResponse;
}

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

	it('releases the body of every response it does not read', async () => {
		const cancelled: string[] = [];
		const { impl } = queue(
			watchedBody('redirect', cancelled, {
				status: 302,
				headers: { location: 'https://example.com/b' }
			}),
			watchedBody('missing', cancelled, { status: 404, headers: { 'content-type': 'text/html' } })
		);
		const err = await failure(fetchRecipePage('https://example.com/a', opts({ fetchImpl: impl })));
		expect(err.status).toBe(502);
		expect(cancelled).toEqual(['redirect', 'missing']);
	});

	it('uses the ordinary response without trying the browser fallback', async () => {
		const primary = queue(html('<html>Dal</html>'));
		const fallback = queue(html('<html>unused</html>'));
		const page = await fetchRecipePage(
			'https://example.com/dal',
			opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
		);
		expect(page.html).toBe('<html>Dal</html>');
		expect(fallback.asked).toEqual([]);
	});

	it.each([401, 403])('retries a %i refusal once through the browser fallback', async (status) => {
		const primary = queue(new Response('blocked', { status }));
		const fallback = queue(html('<html>Dal</html>'));
		const page = await fetchRecipePage(
			'https://example.com/dal',
			opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
		);
		expect(page.html).toBe('<html>Dal</html>');
		expect(primary.asked).toEqual(['https://example.com/dal']);
		expect(fallback.asked).toEqual(['https://example.com/dal']);
	});

	it('retries a challenge header and releases the original body first', async () => {
		const cancelled: string[] = [];
		const primary = queue(
			watchedBody('challenge', cancelled, {
				headers: { 'content-type': 'text/html', 'cf-mitigated': ' Challenge ' }
			})
		);
		const fallback = queue(html('<html>Dal</html>'));
		const fallbackFetchImpl = async (url: string) => {
			expect(cancelled).toEqual(['challenge']);
			return fallback.impl(url);
		};
		const page = await fetchRecipePage(
			'https://example.com/dal',
			opts({ fetchImpl: primary.impl, fallbackFetchImpl })
		);
		expect(page.html).toBe('<html>Dal</html>');
		expect(fallback.asked).toEqual(['https://example.com/dal']);
	});

	it('retries recognizable challenge HTML even when its status is successful', async () => {
		const primary = queue(html(CHALLENGE_PAGE));
		const fallback = queue(html('<html>Dal</html>'));
		const page = await fetchRecipePage(
			'https://example.com/dal',
			opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
		);
		expect(page.html).toBe('<html>Dal</html>');
		expect(fallback.asked).toEqual(['https://example.com/dal']);
	});

	it('restarts from the original link and reports the fallback final URL and attachment name', async () => {
		const primary = queue(redirect('/blocked'), new Response('blocked', { status: 403 }));
		const fallback = queue(redirect('/recipes/dal?utm=1'), html('<html>Dal</html>'));
		const page = await fetchRecipePage(
			'https://example.com/original',
			opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
		);
		expect(fallback.asked).toEqual([
			'https://example.com/original',
			'https://example.com/recipes/dal?utm=1'
		]);
		expect(page.finalUrl).toBe('https://example.com/recipes/dal?utm=1');
		expect(page.filename).toBe('example.com-recipes-dal.html');
	});

	it.each([
		['another refusal', () => new Response('blocked', { status: 403 })],
		['challenge header', () => html('blocked', { 'cf-mitigated': 'challenge' })],
		['challenge HTML', () => html(CHALLENGE_PAGE)]
	])('stops when the browser fallback returns %s', async (_name, response) => {
		const primary = queue(new Response('blocked', { status: 403 }));
		const fallback = queue(response());
		const err = await failure(
			fetchRecipePage(
				'https://example.com/dal',
				opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
			)
		);
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/refused/i);
		expect(err.message).toMatch(/save the page/i);
		expect(primary.asked).toHaveLength(1);
		expect(fallback.asked).toHaveLength(1);
	});

	it.each([
		'<html><head><title>Just a moment...</title></head><body>A recipe story.</body></html>',
		'<html><head><title>Cloudflare cake</title></head><body><code>window._cf_chl_opt</code></body></html>',
		'<html><head><title>Dal</title></head><body>Please verify you are human before cooking.</body></html>',
		''
	])('does not mistake ordinary or empty HTML for a challenge: %s', async (body) => {
		const primary = queue(html(body));
		const fallback = queue(html('<html>unused</html>'));
		const page = await fetchRecipePage(
			'https://example.com/dal',
			opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
		);
		expect(page.html).toBe(body);
		expect(fallback.asked).toEqual([]);
	});

	it.each([404, 410, 429])(
		'does not retry HTTP %i even with a challenge header',
		async (status) => {
			const primary = queue(
				new Response(CHALLENGE_PAGE, { status, headers: { 'cf-mitigated': 'challenge' } })
			);
			const fallback = queue(html('<html>unused</html>'));
			await failure(
				fetchRecipePage(
					'https://example.com/dal',
					opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
				)
			);
			expect(fallback.asked).toEqual([]);
		}
	);

	it.each([
		['an unsupported scheme', 'file:///etc/passwd', () => html('unused'), 400],
		['invalid URL text', 'not a url', () => html('unused'), 400],
		[
			'a PDF',
			'https://example.com/dal',
			() =>
				new Response('%PDF-1.7', {
					headers: { 'content-type': 'application/pdf', 'cf-mitigated': 'challenge' }
				}),
			415
		],
		[
			'an oversized page',
			'https://example.com/dal',
			() => html(CHALLENGE_PAGE, { 'content-length': '2000' }),
			413
		],
		[
			'a redirect without a location',
			'https://example.com/dal',
			() => new Response(null, { status: 302 }),
			502
		],
		['a redirect to a file', 'https://example.com/dal', () => redirect('file:///etc/passwd'), 400]
	])('does not retry %s', async (_name, url, response, status) => {
		const primary = queue(response());
		const fallback = queue(html('<html>unused</html>'));
		const err = await failure(
			fetchRecipePage(url, opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl }))
		);
		expect(err.status).toBe(status);
		expect(fallback.asked).toEqual([]);
	});

	it.each([
		['a connection failure', () => new TypeError('fetch failed'), 502],
		['a timeout', () => new DOMException('aborted', 'TimeoutError'), 504]
	])('does not retry %s before headers', async (_name, error, status) => {
		const fallback = queue(html('<html>unused</html>'));
		const err = await failure(
			fetchRecipePage(
				'https://example.com/dal',
				opts({
					fetchImpl: async () => {
						throw error();
					},
					fallbackFetchImpl: fallback.impl
				})
			)
		);
		expect(err.status).toBe(status);
		expect(fallback.asked).toEqual([]);
	});

	it('cancels a rejected browser response and every browser redirect before following it', async () => {
		const cancelled: string[] = [];
		const primary = queue(watchedBody('refusal', cancelled, { status: 403 }));
		const fallback = queue(
			watchedBody('redirect', cancelled, { status: 302, headers: { location: '/dal.pdf' } }),
			watchedBody('pdf', cancelled, { headers: { 'content-type': 'application/pdf' } })
		);
		const err = await failure(
			fetchRecipePage(
				'https://example.com/dal',
				opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
			)
		);
		expect(err.status).toBe(415);
		expect(cancelled).toEqual(['refusal', 'redirect', 'pdf']);
	});

	it.each(['declared', 'streamed'])(
		'enforces the byte cap on a %s browser response and cancels it',
		async (mode) => {
			const cancelled: string[] = [];
			const primary = queue(new Response('blocked', { status: 403 }));
			const fallback = queue(
				watchedBody('oversized', cancelled, {
					headers: {
						'content-type': 'text/html',
						'content-length': mode === 'declared' ? '2000' : '1'
					}
				})
			);
			const err = await failure(
				fetchRecipePage(
					'https://example.com/dal',
					opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
				)
			);
			expect(err.status).toBe(413);
			expect(cancelled).toEqual(['oversized']);
		}
	);

	it('applies the redirect ceiling to the browser fallback', async () => {
		const primary = queue(new Response('blocked', { status: 403 }));
		const fallback = queue(redirect('/1'), redirect('/2'), redirect('/3'), redirect('/4'));
		const err = await failure(
			fetchRecipePage(
				'https://example.com/dal',
				opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
			)
		);
		expect(err.status).toBe(502);
		expect(err.message).toMatch(/too many redirects/i);
		expect(fallback.asked).toHaveLength(4);
	});

	it('reports a browser timeout while streaming without another retry', async () => {
		const primary = queue(new Response('blocked', { status: 403 }));
		const fallback = queue(
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.error(new DOMException('aborted', 'TimeoutError'));
					}
				}),
				{ headers: { 'content-type': 'text/html' } }
			)
		);
		const err = await failure(
			fetchRecipePage(
				'https://example.com/dal',
				opts({ fetchImpl: primary.impl, fallbackFetchImpl: fallback.impl })
			)
		);
		expect(err.status).toBe(504);
		expect(err.message).toMatch(/too long/i);
		expect(fallback.asked).toHaveLength(1);
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

	it('reports a timeout while streaming the page as a timeout', async () => {
		const { impl } = queue(
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.error(new DOMException('aborted', 'TimeoutError'));
					}
				}),
				{ headers: { 'content-type': 'text/html' } }
			)
		);
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

describe('fetchRecipePage with the native browser transport', () => {
	it('fetches a local page with the Chrome profile and follows redirects itself', async () => {
		const requests: { url: string | undefined; agent: string | undefined }[] = [];
		const fixture = await servePage((req, res) => {
			requests.push({ url: req.url, agent: req.headers['user-agent'] });
			if (req.url === '/old') {
				res.writeHead(302, { location: '/recipes/dal' });
				res.end();
				return;
			}
			res.writeHead(200, { 'content-type': 'text/html' });
			res.write('<html>');
			res.write('Dal');
			res.end('</html>');
		});
		try {
			const primary = queue(new Response('blocked', { status: 403 }));
			const page = await fetchRecipePage(`${fixture.origin}/old`, {
				maxBytes: 1000,
				fetchImpl: primary.impl
			});
			expect(page.html).toBe('<html>Dal</html>');
			expect(page.finalUrl).toBe(`${fixture.origin}/recipes/dal`);
			expect(page.filename).toMatch(/^127\.0\.0\.1-\d+-recipes-dal\.html$/);
			expect(requests.map((req) => req.url)).toEqual(['/old', '/recipes/dal']);
			for (const req of requests) expect(req.agent).toMatch(/Chrome\//);
		} finally {
			await fixture.close();
		}
	});

	it('closes a native connection when a streaming page exceeds the cap', async () => {
		const closed = Promise.withResolvers<void>();
		const fixture = await servePage((_req, res) => {
			res.once('close', () => closed.resolve());
			res.writeHead(200, { 'content-type': 'text/html' });
			res.write('x'.repeat(1001));
			// Keep the response open: cancellation must end it before the test closes the fixture.
		});
		try {
			const primary = queue(new Response('blocked', { status: 403 }));
			const err = await failure(
				fetchRecipePage(`${fixture.origin}/dal`, { maxBytes: 1000, fetchImpl: primary.impl })
			);
			expect(err.status).toBe(413);
			await closed.promise;
		} finally {
			await fixture.close();
		}
	});

	it('reports a native timeout subclass before headers as a timeout', async () => {
		const network = vi.spyOn(Impit.prototype, 'fetch').mockRejectedValue(new ReadTimeout('slow'));
		try {
			const primary = queue(new Response('blocked', { status: 403 }));
			const err = await failure(
				fetchRecipePage('https://example.com/dal', { maxBytes: 1000, fetchImpl: primary.impl })
			);
			expect(err.status).toBe(504);
			expect(err.message).toMatch(/too long/i);
			expect(network).toHaveBeenCalledOnce();
		} finally {
			network.mockRestore();
		}
	});

	it('aborts the native request before cancelling its stream when the cap is exceeded', async () => {
		const cancelled = Promise.withResolvers<void>();
		let requestSignal: AbortSignal | undefined;
		let abortedWhenCancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1001));
			},
			cancel() {
				abortedWhenCancelled = requestSignal?.aborted ?? false;
				cancelled.resolve();
			}
		});
		const network = vi.spyOn(Impit.prototype, 'fetch').mockImplementation(async (_url, init) => {
			requestSignal = init?.signal;
			return nativePage(body);
		});
		try {
			const primary = queue(new Response('blocked', { status: 403 }));
			const err = await failure(
				fetchRecipePage('https://example.com/dal', { maxBytes: 1000, fetchImpl: primary.impl })
			);
			expect(err.status).toBe(413);
			await cancelled.promise;
			expect(abortedWhenCancelled).toBe(true);
		} finally {
			network.mockRestore();
		}
	});

	it('reports a stalled native body as a timeout and cancels the underlying request', async () => {
		const clock = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(clock.signal);
		const reading = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		let requestSignal: AbortSignal | undefined;
		let abortedWhenCancelled = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					reading.resolve();
				},
				cancel() {
					abortedWhenCancelled = requestSignal?.aborted ?? false;
					cancelled.resolve();
				}
			},
			{ highWaterMark: 0 }
		);
		const network = vi.spyOn(Impit.prototype, 'fetch').mockImplementation(async (_url, init) => {
			requestSignal = init?.signal;
			return nativePage(body);
		});
		try {
			const primary = queue(new Response('blocked', { status: 403 }));
			const result = failure(
				fetchRecipePage('https://example.com/dal', { maxBytes: 1000, fetchImpl: primary.impl })
			);
			await reading.promise;
			clock.abort(new DOMException('clock advanced', 'TimeoutError'));
			const err = await result;
			expect(err.status).toBe(504);
			expect(err.message).toMatch(/too long/i);
			await cancelled.promise;
			expect(abortedWhenCancelled).toBe(true);
			expect(network).toHaveBeenCalledOnce();
		} finally {
			timeout.mockRestore();
			network.mockRestore();
		}
	});
});
