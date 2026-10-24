import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import dnsPacket from 'dns-packet';
import {
	DNS_PORT,
	FIXTURE_HOST,
	HTTP_PORT,
	HTTPS_PORT,
	UNTRUSTED_HTTPS_PORT
} from './settings.mjs';

export const PAGE = '<html><head><title>Fixture recipe</title></head><body>Dal</body></html>';
export const PIXEL = Buffer.from(
	'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
	'base64'
);
export type Route = (request: IncomingMessage, response: ServerResponse) => void;

/** Every origin and DNS answer lives inside the acceptance network, with no public egress. */
export async function startOrigins(certDir: string) {
	const requests: { url: string; userAgent: string }[] = [];
	const lookups: string[] = [];
	const errors: unknown[] = [];
	const routes = new Map<string, Route>();
	const answers = new Map<string, string[]>(
		['recipe.test', 'challenge.test', 'mixed.test', 'rebind.test', 'badcert.test'].map((name) => [
			name,
			[FIXTURE_HOST]
		])
	);
	const dnsGates = new Map<string, Promise<void>>();
	const dnsReached = new Map<string, () => void>();
	const sockets = new Set<Socket>();
	const handle: Route = (request, response) => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
		requests.push({ url: url.toString(), userAgent: request.headers['user-agent'] ?? '' });
		const route = routes.get(url.pathname);
		if (route) return route(request, response);
		if (url.pathname === '/image') {
			response.writeHead(200, { 'content-type': 'image/gif' }).end(PIXEL);
		} else if (url.pathname === '/challenge') {
			const chrome = /Chrome\//.test(request.headers['user-agent'] ?? '');
			response
				.writeHead(chrome ? 200 : 403, { 'content-type': 'text/html' })
				.end(chrome ? PAGE : 'Challenge');
		} else if (url.pathname === '/redirect') {
			response.writeHead(302, { location: url.searchParams.get('to') ?? '/page' }).end();
		} else {
			response.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
		}
	};
	const [key, cert, untrustedKey, untrustedCert] = await Promise.all(
		['server.key', 'server.pem', 'untrusted.key', 'untrusted.pem'].map((name) =>
			readFile(join(certDir, name))
		)
	);
	const servers = [
		createServer(handle),
		createHttpsServer({ key, cert }, handle),
		createHttpsServer({ key: untrustedKey, cert: untrustedCert }, handle)
	];
	for (const server of servers) {
		server.on('connection', (socket) => {
			sockets.add(socket);
			socket.once('close', () => sockets.delete(socket));
			socket.on('error', () => {});
		});
		// Rejection of the intentionally untrusted fixture is an expected test outcome.
		server.on('tlsClientError', () => {});
	}
	const dns = createSocket('udp4');
	dns.on('message', (message, remote) => {
		void (async () => {
			const query = dnsPacket.decode(message);
			const question = query.questions?.[0];
			if (!question) return;
			lookups.push(question.name);
			dnsReached.get(question.name)?.();
			await dnsGates.get(question.name);
			const response = dnsPacket.encode({
				type: 'response',
				id: query.id,
				flags: dnsPacket.AUTHORITATIVE_ANSWER | dnsPacket.RECURSION_AVAILABLE,
				questions: query.questions,
				answers:
					question.type === 'A'
						? (answers.get(question.name) ?? []).map((data) => ({
								name: question.name,
								type: 'A' as const,
								ttl: 0,
								data
							}))
						: []
			});
			dns.send(response, remote.port, remote.address);
		})().catch((error) => errors.push(error));
	});
	dns.on('error', (error) => errors.push(error));
	try {
		await Promise.all([
			...servers.map(
				(server, index) =>
					new Promise<void>((resolve, reject) => {
						server.once('error', reject);
						server.listen([HTTP_PORT, HTTPS_PORT, UNTRUSTED_HTTPS_PORT][index], '0.0.0.0', resolve);
					})
			),
			new Promise<void>((resolve, reject) => {
				dns.once('error', reject);
				dns.bind(DNS_PORT, '0.0.0.0', resolve);
			})
		]);
	} catch (error) {
		for (const server of servers) server.close();
		dns.close();
		throw error;
	}
	return {
		requests,
		lookups,
		errors,
		routes,
		answers,
		dnsGates,
		dnsReached,
		async close() {
			for (const socket of sockets) socket.destroy();
			await Promise.all(
				servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
			);
			await new Promise<void>((resolve) => dns.close(resolve));
		}
	};
}
