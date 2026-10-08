import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '$lib/server/errors';
import { LLM_LIMITS, resetRateLimits } from '$lib/server/ratelimit';
import {
	SSE_DONE,
	STUB_LLM_CONFIG,
	completionResponse,
	jsonResponse,
	sseChunk,
	stubLlm,
	unstubLlm
} from '../../../../tests/llm-stub';
import {
	LLM_BACKGROUND_TIMEOUT_MS,
	LLM_IDLE_TIMEOUT_MS,
	LLM_JSON_TEMPERATURE,
	LLM_MAX_WAITING,
	LLM_TIMEOUT_MS,
	claimLlmCall,
	completeJson,
	completeText,
	llmEnabled,
	setLlmForTests
} from './client';

const schema = z.object({ ok: z.boolean(), name: z.string() });
const good = JSON.stringify({ ok: true, name: 'dal' });
const SYSTEM = 'You are a test system prompt.';

beforeEach(resetRateLimits);
afterEach(() => {
	unstubLlm();
	vi.useRealTimers();
});

describe('completeJson request', () => {
	it('asks for json_schema output, low temperature and a token cap', async () => {
		const { requests } = stubLlm([good]);
		const out = await completeJson(schema, SYSTEM, 'the text', { maxTokens: 321, name: 'dish' });
		expect(out).toEqual({ ok: true, name: 'dal' });
		expect(requests).toHaveLength(1);
		const body = requests[0];
		expect(body.model).toBe(STUB_LLM_CONFIG.model);
		expect(body.max_tokens).toBe(321);
		expect(body.temperature).toBe(LLM_JSON_TEMPERATURE);
		expect(body.temperature).toBe(0.1);
		expect(body.response_format?.type).toBe('json_schema');
		expect(body.response_format?.json_schema?.name).toBe('dish');
		const sent = body.response_format?.json_schema?.schema as Record<string, unknown>;
		expect(sent.type).toBe('object');
		expect(Object.keys(sent.properties as object).sort()).toEqual(['name', 'ok']);
		expect(sent).not.toHaveProperty('$schema');
	});

	it('keeps the system prompt first and byte-identical, and the user text last', async () => {
		const { requests } = stubLlm([good]);
		await completeJson(schema, SYSTEM, 'first text', { maxTokens: 100 });
		await completeJson(schema, SYSTEM, 'second text', { maxTokens: 100 });
		const [a, b] = requests;
		expect(a.messages[0]).toEqual({ role: 'system', content: SYSTEM });
		expect(b.messages[0]).toEqual(a.messages[0]);
		expect(a.messages.at(-1)).toEqual({ role: 'user', content: 'first text' });
		expect(b.messages.at(-1)).toEqual({ role: 'user', content: 'second text' });
	});

	it('reads JSON inside a code fence or after a thinking block', async () => {
		stubLlm(['<think>hmm</think>\n```json\n' + good + '\n```']);
		await expect(completeJson(schema, SYSTEM, 'x', { maxTokens: 100 })).resolves.toEqual({
			ok: true,
			name: 'dal'
		});
	});
});

describe('completeJson bad replies', () => {
	it('asks one more time after an unreadable reply and returns the second', async () => {
		const { requests } = stubLlm(['not json at all', good]);
		await expect(completeJson(schema, SYSTEM, 'x', { maxTokens: 100 })).resolves.toEqual({
			ok: true,
			name: 'dal'
		});
		expect(requests).toHaveLength(2);
	});

	it('is a 502 after two unreadable replies', async () => {
		const { requests } = stubLlm(['nope', '{broken']);
		await expect(completeJson(schema, SYSTEM, 'x', { maxTokens: 100 })).rejects.toMatchObject({
			status: 502
		});
		expect(requests).toHaveLength(2);
	});

	it('is a 502 after two replies of the wrong shape', async () => {
		const { requests } = stubLlm([JSON.stringify({ ok: 'yes' }), JSON.stringify({ name: 5 })]);
		const err = await completeJson(schema, SYSTEM, 'x', { maxTokens: 100 }).catch((e) => e);
		expect(err).toBeInstanceOf(AppError);
		expect(err.status).toBe(502);
		expect(requests).toHaveLength(2);
	});

	it('is a 502 at once when the reply was cut off by max_tokens', async () => {
		const { requests } = stubLlm([{ content: '{"ok": tr', finishReason: 'length' }, good]);
		await expect(completeJson(schema, SYSTEM, 'x', { maxTokens: 100 })).rejects.toMatchObject({
			status: 502
		});
		expect(requests).toHaveLength(1);
	});
});

describe('failure mapping', () => {
	it('is a 502 when the server cannot be reached', async () => {
		stubLlm([new TypeError('fetch failed')]);
		const err = await completeJson(schema, SYSTEM, 'x', { maxTokens: 100 }).catch((e) => e);
		expect(err).toBeInstanceOf(AppError);
		expect(err.status).toBe(502);
		// Nothing from the connection error is shown to the user.
		expect(err.message).not.toContain('fetch failed');
	});

	it('is a 502 when the server answers with an error status', async () => {
		const fetchStub = (async () =>
			jsonResponse({ error: { message: 'secret detail' } }, 500)) as typeof fetch;
		setLlmForTests({ config: STUB_LLM_CONFIG, fetch: fetchStub });
		const err = await completeText(SYSTEM, 'x', { maxTokens: 50 }).catch((e) => e);
		expect(err).toBeInstanceOf(AppError);
		expect(err.status).toBe(502);
		expect(err.message).not.toContain('secret detail');
	});

	it('asks for a streamed reply', async () => {
		const { requests } = stubLlm([good]);
		await completeJson(schema, SYSTEM, 'x', { maxTokens: 100 });
		expect(requests[0].stream).toBe(true);
	});

	it('joins a reply streamed in many chunks', async () => {
		const parts = ['{"ok":', 'true,', '"name":', '"dal"}'];
		const body =
			parts.map((p) => sseChunk({ content: p })).join('') + sseChunk({}, 'stop') + SSE_DONE;
		const fetchStub = (async () =>
			new Response(body, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
		setLlmForTests({ config: STUB_LLM_CONFIG, fetch: fetchStub });
		await expect(completeJson(schema, SYSTEM, 'x', { maxTokens: 100 })).resolves.toEqual({
			ok: true,
			name: 'dal'
		});
	});

	it('is a 504 when the server sends nothing within the idle limit', async () => {
		vi.useFakeTimers();
		// A server that never answers: the call ends only when the client aborts it.
		const fetchStub = ((_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('The operation was aborted.', 'AbortError'))
				);
			})) as typeof fetch;
		setLlmForTests({ config: STUB_LLM_CONFIG, fetch: fetchStub });
		const result = completeText(SYSTEM, 'x', { maxTokens: 50 }).catch((e) => e);
		await vi.advanceTimersByTimeAsync(LLM_IDLE_TIMEOUT_MS + 1);
		const err = await result;
		expect(err).toBeInstanceOf(AppError);
		expect(err.status).toBe(504);
	});

	/**
	 * A server that streams `tokens` one word at a time, `everyMs` apart, and
	 * then (unless `stall`) ends the reply. It stops when the client aborts.
	 */
	function trickleStub(tokens: number, everyMs: number, stall = false) {
		const fetchStub = (async (_url: unknown, init?: RequestInit) => {
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					let sent = 0;
					const timer = setInterval(() => {
						if (sent < tokens) {
							controller.enqueue(encoder.encode(sseChunk({ content: `w${sent} ` })));
							sent++;
						} else if (!stall) {
							clearInterval(timer);
							controller.enqueue(encoder.encode(sseChunk({}, 'stop') + SSE_DONE));
							controller.close();
						}
					}, everyMs);
					init?.signal?.addEventListener('abort', () => {
						clearInterval(timer);
						controller.error(new DOMException('The operation was aborted.', 'AbortError'));
					});
				}
			});
			return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
		}) as typeof fetch;
		setLlmForTests({ config: STUB_LLM_CONFIG, fetch: fetchStub });
	}

	// Six tokens a minute apart: never silent for the idle limit, but longer
	// than an interactive call may take, and shorter than a background one.
	const TOKEN_GAP_MS = 60_000;
	const SLOW_TOKENS = 6;
	const slowTotalMs = (SLOW_TOKENS + 1) * TOKEN_GAP_MS;

	it('keeps a call alive past the idle limit while tokens arrive', async () => {
		vi.useFakeTimers();
		// Two tokens and the end, each just inside the idle limit: longer than the
		// idle limit in total, shorter than the total limit.
		const gap = LLM_IDLE_TIMEOUT_MS - 1_000;
		expect(3 * gap).toBeLessThan(LLM_TIMEOUT_MS);
		trickleStub(2, gap);
		const result = completeText(SYSTEM, 'x', { maxTokens: 50 });
		await vi.advanceTimersByTimeAsync(3 * gap + 1);
		await expect(result).resolves.toBe('w0 w1');
	});

	it('is a 504 when the stream goes silent after the first token', async () => {
		vi.useFakeTimers();
		trickleStub(1, 1_000, true);
		const result = completeText(SYSTEM, 'x', { maxTokens: 50 }).catch((e) => e);
		await vi.advanceTimersByTimeAsync(LLM_IDLE_TIMEOUT_MS + 2_000);
		expect(await result).toMatchObject({ status: 504 });
	});

	it('stops an interactive call at its total limit even while tokens arrive', async () => {
		expect(slowTotalMs).toBeGreaterThan(LLM_TIMEOUT_MS);
		vi.useFakeTimers();
		trickleStub(SLOW_TOKENS, TOKEN_GAP_MS);
		const result = completeText(SYSTEM, 'x', { maxTokens: 50 }).catch((e) => e);
		await vi.advanceTimersByTimeAsync(slowTotalMs + 1);
		expect(await result).toMatchObject({ status: 504 });
	});

	it('lets a background call run past the interactive limit', async () => {
		expect(slowTotalMs).toBeLessThan(LLM_BACKGROUND_TIMEOUT_MS);
		vi.useFakeTimers();
		trickleStub(SLOW_TOKENS, TOKEN_GAP_MS);
		const result = completeText(SYSTEM, 'x', { maxTokens: 50, background: true });
		await vi.advanceTimersByTimeAsync(slowTotalMs + 1);
		await expect(result).resolves.toBe('w0 w1 w2 w3 w4 w5');
	});

	it('is a 504 when a background call passes its own, longer limit', async () => {
		vi.useFakeTimers();
		const tokens = LLM_BACKGROUND_TIMEOUT_MS / TOKEN_GAP_MS + 2;
		trickleStub(tokens, TOKEN_GAP_MS);
		const result = completeJson(schema, SYSTEM, 'x', { maxTokens: 50, background: true }).catch(
			(e) => e
		);
		await vi.advanceTimersByTimeAsync((tokens + 1) * TOKEN_GAP_MS);
		expect(await result).toMatchObject({ status: 504 });
	});

	it('is a 502 when a text answer is empty', async () => {
		stubLlm(['  ']);
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).rejects.toMatchObject({
			status: 502
		});
	});
});

describe('claimLlmCall', () => {
	it('is a 503 when the assistant is off, and llmEnabled is false', () => {
		setLlmForTests({ config: null });
		expect(llmEnabled()).toBe(false);
		let status = 0;
		try {
			claimLlmCall('u1');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			status = (err as AppError).status;
		}
		expect(status).toBe(503);
	});

	it('is a 503 from completeJson when the assistant is off', async () => {
		setLlmForTests({ config: null });
		await expect(completeJson(schema, SYSTEM, 'x', { maxTokens: 100 })).rejects.toMatchObject({
			status: 503
		});
	});

	it('allows the limit per user, then answers 429, and other users are unaffected', () => {
		stubLlm([good]);
		expect(llmEnabled()).toBe(true);
		for (let i = 0; i < LLM_LIMITS.user.max; i++) claimLlmCall('u1');
		let status = 0;
		try {
			claimLlmCall('u1');
		} catch (err) {
			status = (err as AppError).status;
		}
		expect(status).toBe(429);
		expect(() => claimLlmCall('u2')).not.toThrow();
	});
});

describe('queue', () => {
	/** A stub whose requests wait until the test lets each one go. */
	function gatedStub() {
		const gates: (() => void)[] = [];
		/** the user text of every request, in the order the server saw them */
		const texts: string[] = [];
		let active = 0;
		let maxActive = 0;
		let started = 0;
		const fetchStub = (async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
			texts.push(body.messages.at(-1)!.content);
			started++;
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => gates.push(resolve));
			active--;
			return completionResponse('answer');
		}) as typeof fetch;
		setLlmForTests({ config: STUB_LLM_CONFIG, fetch: fetchStub });
		return {
			gates,
			texts,
			started: () => started,
			maxActive: () => maxActive
		};
	}

	it('runs concurrent calls one at a time, in order', async () => {
		const stub = gatedStub();
		const calls = [1, 2, 3].map((n) => completeText(SYSTEM, `q${n}`, { maxTokens: 50 }));
		for (let n = 1; n <= 3; n++) {
			await vi.waitFor(() => expect(stub.started()).toBe(n));
			// The others are still waiting while this one runs.
			expect(stub.gates).toHaveLength(n);
			stub.gates[n - 1]();
		}
		await expect(Promise.all(calls)).resolves.toEqual(['answer', 'answer', 'answer']);
		expect(stub.maxActive()).toBe(1);
	});

	it('tells a caller to come back when too many are already waiting', async () => {
		const stub = gatedStub();
		const accepted = Array.from({ length: LLM_MAX_WAITING }, (_, n) =>
			completeText(SYSTEM, `q${n}`, { maxTokens: 50 })
		);
		const extra = completeText(SYSTEM, 'one too many', { maxTokens: 50 });
		await expect(extra).rejects.toMatchObject({ status: 503 });
		for (let n = 1; n <= LLM_MAX_WAITING; n++) {
			await vi.waitFor(() => expect(stub.started()).toBe(n));
			stub.gates[n - 1]();
		}
		await Promise.all(accepted);
		expect(stub.started()).toBe(LLM_MAX_WAITING);
	});

	it('runs an interactive call that arrives later before a background call that waits', async () => {
		const stub = gatedStub();
		const first = completeText(SYSTEM, 'running', { maxTokens: 50, background: true });
		await vi.waitFor(() => expect(stub.started()).toBe(1));
		const waitingBackground = completeText(SYSTEM, 'background', {
			maxTokens: 50,
			background: true
		});
		const interactive = completeText(SYSTEM, 'interactive', { maxTokens: 50 });
		stub.gates[0]();
		await vi.waitFor(() => expect(stub.started()).toBe(2));
		expect(stub.texts[1]).toBe('interactive');
		stub.gates[1]();
		await vi.waitFor(() => expect(stub.started()).toBe(3));
		expect(stub.texts[2]).toBe('background');
		stub.gates[2]();
		await Promise.all([first, waitingBackground, interactive]);
		expect(stub.maxActive()).toBe(1);
	});

	it('does not refuse a background call when the interactive callers waiting are at the limit', async () => {
		const stub = gatedStub();
		const interactive = Array.from({ length: LLM_MAX_WAITING }, (_, n) =>
			completeText(SYSTEM, `q${n}`, { maxTokens: 50 })
		);
		const background = completeText(SYSTEM, 'background', { maxTokens: 50, background: true });
		// The lane of interactive callers is full, so one more of them is refused.
		await expect(completeText(SYSTEM, 'one too many', { maxTokens: 50 })).rejects.toMatchObject({
			status: 503
		});
		for (let n = 1; n <= LLM_MAX_WAITING + 1; n++) {
			await vi.waitFor(() => expect(stub.started()).toBe(n));
			stub.gates[n - 1]();
		}
		await expect(background).resolves.toBe('answer');
		await Promise.all(interactive);
		// The background call went last.
		expect(stub.texts.at(-1)).toBe('background');
	});

	it('keeps serving after a call failed', async () => {
		stubLlm([new TypeError('fetch failed'), 'fine']);
		const first = completeText(SYSTEM, 'a', { maxTokens: 50 }).catch((e) => e);
		const second = completeText(SYSTEM, 'b', { maxTokens: 50 });
		expect(await first).toBeInstanceOf(AppError);
		await expect(second).resolves.toBe('fine');
	});
});
