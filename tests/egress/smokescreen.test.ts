import { request } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchRecipePage } from '$lib/server/import-fetch';
import { fetchImageBytes } from '$lib/server/media/image-fetch';
import { AppError } from '$lib/server/errors';
import { startOrigins, PAGE, PIXEL } from './fixtures';
import { FIXTURE_HOST, HTTP_PORT, HTTPS_PORT, UNTRUSTED_HTTPS_PORT } from './settings.mjs';

const proxyUrl = process.env.EGRESS_PROXY_URL;
const certDir = process.env.EGRESS_CERT_DIR;
if (!proxyUrl || !certDir)
	throw new Error('Run pnpm test:egress to provision the isolated proxy fixtures.');
const options = { proxyUrl, maxBytes: 4096 };
let origins: Awaited<ReturnType<typeof startOrigins>>;
const address = (path = '/page', host = 'recipe.test', secure = false) =>
	`${secure ? 'https' : 'http'}://${host}:${secure ? HTTPS_PORT : HTTP_PORT}${path}`;

async function rejected(run: Promise<unknown>): Promise<AppError> {
	try {
		await run;
	} catch (error) {
		expect(error).toBeInstanceOf(AppError);
		if (error instanceof AppError) return error;
		throw error;
	}
	throw new Error('Expected the import to fail.');
}

/** Observe proxy status directly so overload errors cannot masquerade as policy denials. */
function proxyStatus(url: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const pending = request(
			proxyUrl!,
			{ method: 'GET', path: url, headers: { connection: 'close' } },
			(response) => {
				response.resume();
				response.once('end', () => resolve(response.statusCode!));
				response.once('error', reject);
			}
		);
		pending.once('error', reject);
		pending.setTimeout(10000, () => pending.destroy(new Error('Fixture proxy did not answer.')));
		pending.end();
	});
}

function openTunnel(): Promise<{ socket: Duplex; status: number }> {
	return new Promise((resolve, reject) => {
		const target = `${FIXTURE_HOST}:${HTTPS_PORT}`;
		const pending = request(proxyUrl!, {
			method: 'CONNECT',
			path: target,
			headers: { host: target }
		});
		pending.once('connect', (response, socket) => {
			pending.setTimeout(0);
			socket.on('error', () => {});
			resolve({ socket, status: response.statusCode! });
		});
		pending.once('error', reject);
		pending.setTimeout(10000, () => pending.destroy(new Error('Fixture CONNECT did not answer.')));
		pending.end();
	});
}

beforeAll(async () => {
	origins = await startOrigins(certDir);
});
afterAll(async () => {
	await origins?.close();
	expect(origins?.errors).toEqual([]);
});

describe('real Smokescreen import policy', () => {
	it('downloads normal pages and images over HTTP and verified HTTPS', async () => {
		for (const secure of [false, true]) {
			expect((await fetchRecipePage(address('/page', 'recipe.test', secure), options)).html).toBe(
				PAGE
			);
			expect(await fetchImageBytes(address('/image', 'recipe.test', secure), options)).toEqual(
				PIXEL
			);
		}
	});

	it('keeps both Chrome-profile attempts proxied, including trusted HTTPS', async () => {
		for (const secure of [false, true]) {
			const before = origins.requests.length;
			const page = await fetchRecipePage(address('/challenge', 'challenge.test', secure), options);
			expect(page.html).toBe(PAGE);
			const asked = origins.requests.slice(before);
			expect(asked).toHaveLength(2);
			expect(asked[0].userAgent).toMatch(/my-kitchen/);
			expect(asked[1].userAgent).toMatch(/Chrome\//);
		}
	});

	it('does not allow NO_PROXY or competing environment proxies to bypass the configured proxy', async () => {
		vi.stubEnv('NO_PROXY', '*');
		vi.stubEnv('no_proxy', '*');
		vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
		vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
		try {
			expect((await fetchRecipePage(address('/page'), options)).html).toBe(PAGE);
			expect(
				(await fetchRecipePage(address('/challenge', 'challenge.test', true), options)).html
			).toBe(PAGE);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it.each([
		'127.0.0.1',
		'0.0.0.0',
		'10.0.0.1',
		'172.16.0.1',
		'192.168.0.1',
		'100.100.100.200',
		'169.254.169.254',
		'168.63.129.16',
		'[::1]',
		'[fc00::1]',
		'[fe80::1]',
		'[::ffff:127.0.0.1]',
		'[64:ff9b::7f00:1]'
	])('rejects initial destination %s without an origin request', async (host) => {
		const before = origins.requests.length;
		const url = `http://${host}:${HTTP_PORT}/page`;
		// ip4 rejects native IPv6 before address classification; mapped IPv4 still reaches policy.
		const unsupportedIpv6 = host.startsWith('[') && !host.startsWith('[::ffff:');
		expect(await proxyStatus(url)).toBe(unsupportedIpv6 ? 502 : 407);
		const error = await rejected(fetchRecipePage(url, options));
		expect(error.status).toBe(502);
		expect(error.message).not.toContain('Smokescreen');
		expect(error.message).not.toContain(host);
		expect(origins.requests).toHaveLength(before);
	});

	it('bounds retained Chrome tunnels across repeated completed imports', async () => {
		const closed: Promise<void>[] = [];
		origins.routes.set('/retained', (request, response) => {
			const ended = Promise.withResolvers<void>();
			request.socket.once('close', ended.resolve);
			closed.push(ended.promise);
			response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
		});
		try {
			for (let i = 0; i < 20; i++) {
				const page = await fetchRecipePage(address('/retained', 'recipe.test', true), {
					...options,
					fetchImpl: async () =>
						new Response('Challenge', { status: 403, headers: { 'content-type': 'text/html' } })
				});
				expect(page.html).toBe(PAGE);
			}
			expect(closed).toHaveLength(20);
			await Promise.all(closed);
		} finally {
			origins.routes.delete('/retained');
		}
	});

	it('enforces the active CONNECT tunnel limit', async () => {
		const opened: Awaited<ReturnType<typeof openTunnel>>[] = [];
		try {
			for (let i = 0; i < 64; i++) {
				const tunnel = await openTunnel();
				opened.push(tunnel);
				expect(tunnel.status).toBe(200);
			}
			const overflow = await openTunnel();
			opened.push(overflow);
			expect(overflow.status).toBe(429);
		} finally {
			const closed = opened.map(
				({ socket }) =>
					new Promise<void>((resolve) => {
						if (socket.closed) resolve();
						else socket.once('close', () => resolve());
					})
			);
			for (const { socket } of opened) socket.destroy();
			await Promise.all(closed);
		}
	});

	it('enforces request concurrency while DNS work is pending', async () => {
		const gates = Array.from({ length: 16 }, (_, index) => {
			const name = `busy${index}.test`;
			const received = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			origins.answers.set(name, [FIXTURE_HOST]);
			origins.dnsReached.set(name, received.resolve);
			origins.dnsGates.set(name, release.promise);
			return { name, received, release };
		});
		const pending = gates.map(({ name }) => proxyStatus(address('/page', name)));
		try {
			await Promise.all(gates.map(({ received }) => received.promise));
			expect(await proxyStatus(address())).toBe(503);
		} finally {
			for (const { release } of gates) release.resolve();
			await Promise.allSettled(pending);
			for (const { name } of gates) {
				origins.dnsReached.delete(name);
				origins.dnsGates.delete(name);
			}
		}
	});

	it('blocks forbidden redirects in normal page, Chrome retry and image paths', async () => {
		origins.routes.set('/blocked', (request, response) => {
			if (!/Chrome\//.test(request.headers['user-agent'] ?? '')) {
				response.writeHead(403, { 'content-type': 'text/html' }).end('Challenge');
			} else response.writeHead(302, { location: `http://127.0.0.1:${HTTP_PORT}/secret` }).end();
		});
		try {
			const before = origins.requests.length;
			const redirect = address(
				`/redirect?to=${encodeURIComponent(`http://127.0.0.1:${HTTP_PORT}/secret`)}`
			);
			await rejected(fetchRecipePage(redirect, options));
			await rejected(fetchRecipePage(address('/blocked'), options));
			await rejected(fetchImageBytes(redirect, options));
			expect(
				origins.requests.slice(before).map((request) => new URL(request.url).pathname)
			).toEqual(['/redirect', '/blocked', '/blocked', '/redirect']);
		} finally {
			origins.routes.delete('/blocked');
		}
	});

	it('uses only an allowed DNS answer and rechecks later resolutions', async () => {
		origins.answers.set('mixed.test', ['127.0.0.1', FIXTURE_HOST]);
		expect((await fetchRecipePage(address('/page', 'mixed.test'), options)).html).toBe(PAGE);
		expect((await fetchRecipePage(address('/page', 'rebind.test'), options)).html).toBe(PAGE);
		origins.answers.set('rebind.test', ['127.0.0.1']);
		const before = origins.requests.length;
		try {
			await rejected(fetchRecipePage(address('/page', 'rebind.test'), options));
			expect(origins.requests).toHaveLength(before);
			expect(
				origins.lookups.filter((host) => host === 'rebind.test').length
			).toBeGreaterThanOrEqual(2);
		} finally {
			origins.answers.set('rebind.test', [FIXTURE_HOST]);
		}
	});

	it('keeps certificate verification enabled for normal and Chrome transports', async () => {
		const url = `https://badcert.test:${UNTRUSTED_HTTPS_PORT}/challenge`;
		await rejected(fetchRecipePage(url, options));
		await rejected(
			fetchRecipePage(url, {
				...options,
				fetchImpl: async () =>
					new Response('Challenge', { status: 403, headers: { 'content-type': 'text/html' } })
			})
		);
	});

	it.each(['page', 'image', 'chrome'])(
		'keeps the %s tunnel alive until the final body chunk',
		async (kind) => {
			const received = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const closed = Promise.withResolvers<void>();
			const bytes = kind === 'image' ? PIXEL : Buffer.from(PAGE);
			origins.routes.set('/gated', (request, response) => {
				if (kind === 'chrome' && !/Chrome\//.test(request.headers['user-agent'] ?? '')) {
					response.writeHead(403, { 'content-type': 'text/html' }).end('Challenge');
					return;
				}
				request.socket.once('close', closed.resolve);
				response.writeHead(200, { 'content-type': kind === 'image' ? 'image/gif' : 'text/html' });
				response.write(bytes.subarray(0, 5));
				received.resolve();
				void release.promise.then(() => response.end(bytes.subarray(5)));
			});
			let settled = false;
			const pending =
				kind === 'image'
					? fetchImageBytes(address('/gated', 'recipe.test', true), options)
					: fetchRecipePage(address('/gated', 'recipe.test', true), options).then((page) =>
							Buffer.from(page.html)
						);
			void pending.then(
				() => {
					settled = true;
				},
				() => {}
			);
			try {
				await received.promise;
				expect(settled).toBe(false);
				release.resolve();
				expect(await pending).toEqual(bytes);
				// Native pooling may keep its tunnel idle; the configured proxy bounds that lifetime.
				await closed.promise;
			} finally {
				release.resolve();
				await Promise.allSettled([pending]);
				origins.routes.delete('/gated');
			}
		}
	);

	it('rejects oversized bodies and cancels a stalled body without waiting for it', async () => {
		const entered = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		origins.routes.set('/stalled', (request, response) => {
			request.socket.once('close', closed.resolve);
			response.writeHead(200, { 'content-type': 'text/html' });
			response.write('first');
			entered.resolve();
		});
		const clock = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(clock.signal);
		const pending = fetchRecipePage(address('/stalled'), options);
		try {
			await entered.promise;
			clock.abort(new DOMException('Timed out', 'TimeoutError'));
			expect((await rejected(pending)).status).toBe(504);
			await closed.promise;
		} finally {
			timeout.mockRestore();
			origins.routes.delete('/stalled');
		}
		expect((await rejected(fetchRecipePage(address(), { ...options, maxBytes: 5 }))).status).toBe(
			413
		);
	});

	it('fails closed when the proxy is down while trusted direct requests still work', async () => {
		const before = origins.requests.length;
		await rejected(fetchRecipePage(address(), { ...options, proxyUrl: 'http://127.0.0.1:1' }));
		await rejected(
			fetchImageBytes(address('/image'), { ...options, proxyUrl: 'http://127.0.0.1:1' })
		);
		await rejected(
			fetchRecipePage(address('/challenge'), {
				...options,
				proxyUrl: 'http://127.0.0.1:1',
				fetchImpl: async () =>
					new Response('Challenge', { status: 403, headers: { 'content-type': 'text/html' } })
			})
		);
		expect(origins.requests).toHaveLength(before);
		const response = await fetch(`http://${FIXTURE_HOST}:${HTTP_PORT}/page`);
		expect(await response.text()).toBe(PAGE);
	});

	it('closes a canceled unresolved-DNS request even when the response arrives later', async () => {
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		origins.answers.set('delayed.test', [FIXTURE_HOST]);
		origins.dnsGates.set('delayed.test', release.promise);
		origins.dnsReached.set('delayed.test', received.resolve);
		const clock = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(clock.signal);
		const pending = fetchRecipePage(address('/page', 'delayed.test'), options);
		try {
			await received.promise;
			clock.abort(new DOMException('Timed out', 'TimeoutError'));
			expect((await rejected(pending)).status).toBe(504);
		} finally {
			release.resolve();
			timeout.mockRestore();
			await Promise.allSettled([pending]);
			origins.dnsGates.delete('delayed.test');
			origins.dnsReached.delete('delayed.test');
		}
	});
});
