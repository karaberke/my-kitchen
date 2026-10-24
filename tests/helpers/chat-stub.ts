import { createServer, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { completionResponse } from './llm-response.ts';

export { STUB_LLM_MODEL as CHAT_STUB_MODEL } from './llm-response.ts';

export const CHAT_STUB_BASE_URL = 'http://127.0.0.1:4320/v1';
export const CHAT_STUB_API_KEY = 'e2e-stub-key';

interface ChatRequest {
	messages: { role: string; content: string }[];
}

/** Responses wait for an explicit release, so browser tests control the close/reopen race. */
export async function startChatStub() {
	const requests: ChatRequest[] = [];
	const pending: ServerResponse[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((req, res) => {
		if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
			res.writeHead(404);
			res.end();
			return;
		}
		let body = '';
		req.on('data', (chunk: Buffer) => (body += chunk.toString()));
		req.on('end', () => {
			try {
				requests.push(JSON.parse(body) as ChatRequest);
				pending.push(res);
			} catch {
				res.writeHead(400);
				res.end();
			}
		});
	});
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	const address = new URL(CHAT_STUB_BASE_URL);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(Number(address.port), address.hostname, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	return {
		requests,
		async release(answer: string) {
			const res = pending.shift();
			if (!res) throw new Error('No pending chat request');
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end(await completionResponse(answer).text());
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	};
}
