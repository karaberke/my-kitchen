import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

/** A test-only proxy: it never connects to anything outside literal loopback hosts. */
export async function startImportProxy() {
	const requests: string[] = [];
	const tunnels: string[] = [];
	const sockets = new Set<Socket>();
	let closed = false;
	let closing: Promise<void> | undefined;

	function track(socket: Socket) {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		if (closed) socket.destroy();
	}

	function targetFor(raw: string): URL | null {
		try {
			const target = new URL(raw);
			return target.protocol === 'http:' &&
				!target.username &&
				!target.password &&
				['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
				? target
				: null;
		} catch {
			return null;
		}
	}

	const server = createServer((incoming, outgoing) => {
		requests.push(incoming.url ?? '');
		const target = targetFor(incoming.url ?? '');
		if (!target || incoming.method !== 'GET') {
			outgoing.writeHead(407, { 'content-type': 'text/plain', connection: 'close' });
			outgoing.end('Test proxy only accepts loopback GET requests.');
			return;
		}
		const headers: IncomingHttpHeaders = { ...incoming.headers, host: target.host };
		delete headers['proxy-authorization'];
		delete headers['proxy-connection'];
		const forwarded = request(target, { method: 'GET', headers, agent: false }, (response) => {
			outgoing.writeHead(response.statusCode ?? 502, response.headers);
			response.once('error', () => outgoing.destroy());
			response.pipe(outgoing);
		});
		forwarded.once('socket', track);
		forwarded.once('error', () => {
			if (outgoing.headersSent) outgoing.destroy();
			else {
				outgoing.writeHead(502, { connection: 'close' });
				outgoing.end();
			}
		});
		outgoing.once('close', () => forwarded.destroy());
		incoming.once('aborted', () => forwarded.destroy());
		forwarded.end();
	});
	server.on('connection', track);
	server.on('connect', (incoming, client, head) => {
		tunnels.push(incoming.url ?? '');
		const target = targetFor(`http://${incoming.url ?? ''}`);
		if (!target) {
			client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
			return;
		}
		const upstream = connect({
			host: target.hostname.replace(/^\[|\]$/g, ''),
			port: Number(target.port || 80)
		});
		track(upstream);
		upstream.once('connect', () => {
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.length) upstream.write(head);
			client.pipe(upstream);
			upstream.pipe(client);
		});
		client.once('close', () => upstream.destroy());
		upstream.once('close', () => client.destroy());
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		tunnels,
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			closing = new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
				server.closeAllConnections();
			});
			return closing;
		}
	};
}
