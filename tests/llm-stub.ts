import { setLlmForTests, type LlmConfig } from '../src/lib/server/llm/client';

/** A made-up server address and key: nothing is sent anywhere. */
export const STUB_LLM_CONFIG: LlmConfig = {
	baseUrl: 'http://llm.test/v1',
	apiKey: 'stub-key',
	model: 'stub-model'
};

export interface StubRequest {
	model: string;
	messages: { role: string; content: string }[];
	max_tokens: number;
	temperature: number;
	stream?: boolean;
	response_format?: { type: string; json_schema?: { name: string; schema: unknown } };
}

/** One `chat.completion.chunk` event of a streamed reply. */
export function sseChunk(delta: { content?: string }, finishReason: string | null = null): string {
	const chunk = {
		id: 'chatcmpl-stub',
		object: 'chat.completion.chunk',
		created: 0,
		model: STUB_LLM_CONFIG.model,
		choices: [{ index: 0, delta, finish_reason: finishReason }]
	};
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** The end of a streamed reply. */
export const SSE_DONE = 'data: [DONE]\n\n';

/** A streamed reply (the client always asks for one) that carries `content` in one chunk. */
export function completionResponse(content: string, finishReason = 'stop'): Response {
	const body = sseChunk({ content }) + sseChunk({}, finishReason) + SSE_DONE;
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

type Reply = string | { content: string; finishReason: string } | Error;

/**
 * Switch the assistant on with a stub `fetch` that answers from `replies` in
 * order (the last one repeats). `requests` holds every request body it saw.
 * Call `unstubLlm` after the test.
 */
export function stubLlm(replies: Reply[]) {
	const requests: StubRequest[] = [];
	const fetchStub = (async (_url: unknown, init?: RequestInit) => {
		requests.push(JSON.parse(String(init?.body)) as StubRequest);
		const reply = replies[Math.min(requests.length, replies.length) - 1];
		if (reply instanceof Error) throw reply;
		return typeof reply === 'string'
			? completionResponse(reply)
			: completionResponse(reply.content, reply.finishReason);
	}) as typeof fetch;
	setLlmForTests({ config: STUB_LLM_CONFIG, fetch: fetchStub });
	return { requests };
}

export function unstubLlm() {
	setLlmForTests(null);
}
