export const STUB_LLM_MODEL = 'stub-model';

/** One OpenAI-compatible chunk; no provider connection is used by test fixtures. */
export function sseChunk(delta: { content?: string }, finishReason: string | null = null): string {
	const chunk = {
		id: 'chatcmpl-stub',
		object: 'chat.completion.chunk',
		created: 0,
		model: STUB_LLM_MODEL,
		choices: [{ index: 0, delta, finish_reason: finishReason }]
	};
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

/** A complete streamed answer, used by unit/integration and loopback browser fixtures. */
export function completionResponse(content: string, finishReason = 'stop'): Response {
	const body = sseChunk({ content }) + sseChunk({}, finishReason) + SSE_DONE;
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
