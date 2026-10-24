import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { Impit } from 'impit';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { startImportProxy } from '../../../tests/helpers/import-proxy';
import { AppError } from './errors';
import { fetchRecipePage } from './import-fetch';
import { createImportTransport } from './import-transport';
import { fetchImageBytes } from './media/image-fetch';

const TRANSPORT_TIMEOUT_MS = 3000;

/** Local origins track their live sockets so transport disposal is observable. */
async function serve(handler: RequestListener) {
	const sockets = new Set<Socket>();
	const server = createServer(handler);
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	onTestFinished(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { origin: `http://127.0.0.1:${port}`, sockets, server };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('owned import proxy transports', () => {
	it('uses the proxy for both ordinary and Chrome attempts while preserving their user agents', async () => {
		const proxy = await startImportProxy();
		onTestFinished(() => proxy.close());
		const agents: string[] = [];
		const fixture = await serve((req, res) => {
			const agent = req.headers['user-agent'] ?? '';
			agents.push(agent);
			res.writeHead(agent.includes('Chrome/') ? 200 : 403, { 'content-type': 'text/html' });
			res.end(agent.includes('Chrome/') ? '<html>Dal</html>' : 'Use a browser');
		});
		const page = await fetchRecipePage(`${fixture.origin}/dal`, {
			maxBytes: 1000,
			proxyUrl: proxy.url
		});
		expect(page.html).toBe('<html>Dal</html>');
		expect(agents).toHaveLength(2);
		expect(agents[0]).toMatch(/my-kitchen/i);
		expect(agents[1]).toMatch(/Chrome\//);
		expect(proxy.requests.length + proxy.tunnels.length).toBe(2);
	});

	it.each(['fetch', 'browserFetch'] as const)(
		'%s keeps the explicit proxy when environment proxies conflict and NO_PROXY is *',
		async (kind) => {
			const proxy = await startImportProxy();
			onTestFinished(() => proxy.close());
			vi.stubEnv('NO_PROXY', '*');
			vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
			vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
			vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1');
			const fixture = await serve((_req, res) => res.end('proxied'));
			const transport = createImportTransport(TRANSPORT_TIMEOUT_MS, proxy.url);
			onTestFinished(() => transport.destroy());
			const response = await transport[kind](`${fixture.origin}/environment`, {
				signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS)
			});
			expect(await response.text()).toBe('proxied');
			expect(proxy.requests.length + proxy.tunnels.length).toBe(1);
		}
	);

	it.each(['page', 'image'] as const)(
		'a genuine proxy 407 stops a %s download without retrying or exposing its body',
		async (kind) => {
			const privateDetail = 'internal-proxy-policy-detail';
			let directRequests = 0;
			const fixture = await serve((_req, res) => {
				directRequests++;
				res.end('must not be reached');
			});
			const denied: string[] = [];
			const proxy = await serve((req, res) => {
				denied.push(req.url ?? '');
				res.writeHead(407, { connection: 'close' });
				res.end(privateDetail);
			});
			proxy.server.on('connect', (req, socket) => {
				denied.push(req.url ?? '');
				socket.end(
					`HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: ${privateDetail.length}\r\n\r\n${privateDetail}`
				);
			});
			const native = vi.spyOn(Impit.prototype, 'fetch');
			const options = { maxBytes: 1000, proxyUrl: proxy.origin, timeoutMs: TRANSPORT_TIMEOUT_MS };
			const result =
				kind === 'page'
					? fetchRecipePage(`${fixture.origin}/denied`, options)
					: fetchImageBytes(`${fixture.origin}/denied`, options);
			const err: unknown = await result.catch((error: unknown) => error);
			expect(err).toMatchObject({
				status: 502,
				message: expect.stringMatching(/could not reach/i)
			});
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).message).not.toContain(privateDetail);
			expect(denied).toHaveLength(1);
			expect(directRequests).toBe(0);
			expect(native).not.toHaveBeenCalled();
		}
	);

	it.each(['page', 'image', 'browser'] as const)(
		'%s fails closed when the configured proxy is down',
		async (kind) => {
			const proxy = await startImportProxy();
			await proxy.close();
			let directRequests = 0;
			const fixture = await serve((_req, res) => {
				directRequests++;
				res.writeHead(200, { 'content-type': 'text/html' });
				res.end('must not be fetched directly');
			});
			const options = { maxBytes: 1000, proxyUrl: proxy.url, timeoutMs: TRANSPORT_TIMEOUT_MS };
			const result =
				kind === 'image'
					? fetchImageBytes(`${fixture.origin}/down`, options)
					: fetchRecipePage(`${fixture.origin}/down`, {
							...options,
							...(kind === 'browser'
								? { fetchImpl: async () => new Response('blocked', { status: 403 }) }
								: {})
						});
			await expect(result).rejects.toBeInstanceOf(AppError);
			expect(directRequests).toBe(0);
		}
	);

	it.each(['page', 'image', 'browser'] as const)(
		'buffers every chunk of a %s before disposing its transport',
		async (kind) => {
			const proxy = await startImportProxy();
			onTestFinished(() => proxy.close());
			const arrived = Promise.withResolvers<void>();
			let finish: () => void = () => {};
			const fixture = await serve((_req, res) => {
				res.writeHead(200, { 'content-type': kind === 'image' ? 'image/png' : 'text/html' });
				res.write('first chunk;');
				finish = () => res.end('last chunk');
				arrived.resolve();
			});
			const options = { maxBytes: 1000, proxyUrl: proxy.url, timeoutMs: TRANSPORT_TIMEOUT_MS };
			let settled = false;
			const result = (
				kind === 'image'
					? fetchImageBytes(`${fixture.origin}/stream`, options).then((bytes) => bytes.toString())
					: fetchRecipePage(`${fixture.origin}/stream`, {
							...options,
							...(kind === 'browser'
								? { fetchImpl: async () => new Response('blocked', { status: 403 }) }
								: {})
						}).then((page) => page.html)
			).finally(() => (settled = true));
			void result.catch(() => {});
			await arrived.promise;
			expect(settled).toBe(false);
			expect(fixture.sockets.size).toBe(1);
			finish();
			await expect(result).resolves.toBe('first chunk;last chunk');
			await expect.poll(() => fixture.sockets.size).toBe(0);
		}
	);

	it.each(['page', 'image'] as const)(
		'closes a live %s socket when its streaming body exceeds the cap',
		async (kind) => {
			const proxy = await startImportProxy();
			onTestFinished(() => proxy.close());
			const closed = Promise.withResolvers<void>();
			const fixture = await serve((_req, res) => {
				res.once('close', () => closed.resolve());
				res.writeHead(200, { 'content-type': kind === 'image' ? 'image/png' : 'text/html' });
				res.write('x'.repeat(101));
			});
			const options = { maxBytes: 100, proxyUrl: proxy.url, timeoutMs: TRANSPORT_TIMEOUT_MS };
			const result =
				kind === 'image'
					? fetchImageBytes(`${fixture.origin}/large`, options)
					: fetchRecipePage(`${fixture.origin}/large`, options);
			await expect(result).rejects.toMatchObject({ status: 413 });
			await closed.promise;
			await expect.poll(() => fixture.sockets.size).toBe(0);
		}
	);

	it.each(['fetch', 'browserFetch'] as const)(
		'%s aborts a stalled body and releases its origin socket',
		async (kind) => {
			const proxy = await startImportProxy();
			onTestFinished(() => proxy.close());
			const closed = Promise.withResolvers<void>();
			const fixture = await serve((_req, res) => {
				res.once('close', () => closed.resolve());
				res.writeHead(200, { 'content-type': 'text/html' });
				res.write('prefix');
			});
			const transport = createImportTransport(TRANSPORT_TIMEOUT_MS, proxy.url);
			onTestFinished(() => transport.destroy());
			const abort = new AbortController();
			const response = await transport[kind](`${fixture.origin}/stalled`, {
				signal: abort.signal
			});
			const reader = response.body!.getReader();
			expect(new TextDecoder().decode((await reader.read()).value)).toBe('prefix');
			const pending = reader.read();
			abort.abort(new DOMException('Test cancelled', 'AbortError'));
			await expect(pending).rejects.toBeDefined();
			await transport.destroy();
			await closed.promise;
			await expect.poll(() => fixture.sockets.size).toBe(0);
		}
	);
});
