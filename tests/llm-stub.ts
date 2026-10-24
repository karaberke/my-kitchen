import { setLlmForTests, type LlmConfig } from '../src/lib/server/llm/client';
import { completionResponse, STUB_LLM_MODEL } from './helpers/llm-response';

export { completionResponse, sseChunk, SSE_DONE } from './helpers/llm-response';

/** A made-up server address and key: nothing is sent anywhere. */
export const STUB_LLM_CONFIG: LlmConfig = {
	baseUrl: 'http://llm.test/v1',
	apiKey: 'stub-key',
	model: STUB_LLM_MODEL
};

export interface StubRequest {
	model: string;
	messages: { role: string; content: string }[];
	max_tokens: number;
	temperature: number;
	stream?: boolean;
	response_format?: { type: string; json_schema?: { name: string; schema: unknown } };
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
