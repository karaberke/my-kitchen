import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	STUB_LLM_CONFIG,
	completionResponse,
	jsonResponse,
	sseChunk,
	unstubLlm
} from '../../../../tests/llm-stub';
import {
	LLM_ENDPOINT_CACHE_MS,
	LLM_IDLE_TIMEOUT_MS,
	LLM_PROBE_TIMEOUT_MS,
	completeJson,
	completeText,
	setLlmForTests
} from './client';

const SYSTEM = 'You are a test system prompt.';
const PRIMARY = STUB_LLM_CONFIG.baseUrl;
const FALLBACK = 'http://windows-llm.test/v1';
const CONFIG = { ...STUB_LLM_CONFIG, fallbackBaseUrl: FALLBACK };

interface Request {
	url: string;
	init?: RequestInit;
}

function ready() {
	return jsonResponse({ object: 'list', data: [{ id: CONFIG.model, object: 'model' }] });
}

function unanswered(init?: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
		if (init?.signal?.aborted) abort();
		else init?.signal?.addEventListener('abort', abort, { once: true });
	});
}

function dualStub(answer: (request: Request) => Response | Promise<Response>) {
	const requests: Request[] = [];
	const fetchStub = (async (input: unknown, init?: RequestInit) => {
		const request = { url: String(input), init };
		requests.push(request);
		return answer(request);
	}) as typeof fetch;
	setLlmForTests({ config: CONFIG, fetch: fetchStub });
	return {
		requests,
		probes: () => requests.filter((request) => request.url.endsWith('/models')),
		generations: () => requests.filter((request) => request.url.endsWith('/chat/completions'))
	};
}

afterEach(() => {
	unstubLlm();
	vi.useRealTimers();
});

describe('AI endpoint failover', () => {
	it('checks the primary model with authentication before generating an answer', async () => {
		const stub = dualStub(({ url }) =>
			url.endsWith('/models') ? ready() : completionResponse('Use the primary.')
		);
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).resolves.toBe('Use the primary.');
		const probe = stub.probes().find((request) => request.url === `${PRIMARY}/models`);
		expect(probe).toBeDefined();
		expect(new Headers(probe?.init?.headers).get('authorization')).toBe(`Bearer ${CONFIG.apiKey}`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`
		]);
		expect(JSON.parse(String(stub.generations()[0].init?.body)).model).toBe(CONFIG.model);
	});

	it('generates on the fallback when the primary cannot be reached', async () => {
		const stub = dualStub(({ url }) => {
			if (url.startsWith(PRIMARY)) throw new TypeError('fetch failed');
			return url.endsWith('/models') ? ready() : completionResponse('Use Windows.');
		});
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).resolves.toBe('Use Windows.');
		expect(stub.probes().map((request) => request.url)).toContain(`${FALLBACK}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${FALLBACK}/chat/completions`
		]);
	});

	it('sends no generation request when neither endpoint is reachable', async () => {
		const stub = dualStub(() => {
			throw new TypeError('fetch failed');
		});
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).rejects.toMatchObject({
			status: 502
		});
		expect(
			stub
				.probes()
				.map((request) => request.url)
				.sort()
		).toEqual([`${PRIMARY}/models`, `${FALLBACK}/models`].sort());
		expect(stub.generations()).toHaveLength(0);
	});

	it('uses the fallback when the primary is loading its model', async () => {
		const stub = dualStub(({ url }) => {
			if (url === `${PRIMARY}/models`) return jsonResponse({ error: 'Loading model' }, 503);
			return url.endsWith('/models') ? ready() : completionResponse('Use Windows.');
		});
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).resolves.toBe('Use Windows.');
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${FALLBACK}/chat/completions`
		]);
	});

	it('skips a reachable endpoint whose model list is empty', async () => {
		const stub = dualStub(({ url }) => {
			if (url === `${PRIMARY}/models`) return jsonResponse({ object: 'list', data: [] });
			return url.endsWith('/models') ? ready() : completionResponse('Use Windows.');
		});
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).resolves.toBe('Use Windows.');
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${FALLBACK}/chat/completions`
		]);
	});

	it('sends no prompt if neither server has the configured model', async () => {
		const stub = dualStub(() => jsonResponse({ data: [{ id: 'some-other-model' }] }));
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).rejects.toMatchObject({
			status: 502
		});
		expect(stub.probes()).toHaveLength(2);
		expect(stub.generations()).toHaveLength(0);
	});

	it('moves past a silent primary within the short readiness timeout', async () => {
		vi.useFakeTimers();
		const stub = dualStub(({ url, init }) => {
			if (url === `${PRIMARY}/models`) return unanswered(init);
			return url.endsWith('/models') ? ready() : completionResponse('Use Windows.');
		});
		const result = completeText(SYSTEM, 'x', { maxTokens: 50 }).catch((err) => err);
		await vi.advanceTimersByTimeAsync(LLM_PROBE_TIMEOUT_MS + 1);
		expect(await result).toBe('Use Windows.');
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${FALLBACK}/chat/completions`
		]);
	});

	it('bounds readiness checks when both endpoints stay silent', async () => {
		vi.useFakeTimers();
		const stub = dualStub(({ init }) => unanswered(init));
		const result = completeText(SYSTEM, 'x', { maxTokens: 50 }).catch((err) => err);
		await vi.advanceTimersByTimeAsync(2 * LLM_PROBE_TIMEOUT_MS + 1);
		expect(await result).toMatchObject({ status: 502 });
		expect(stub.probes()).toHaveLength(2);
		expect(stub.generations()).toHaveLength(0);
	});

	it('remembers a working fallback and recovers when it disappears after switching operating systems', async () => {
		let primaryUp = false;
		let fallbackUp = true;
		const stub = dualStub(({ url }) => {
			if ((url.startsWith(PRIMARY) && !primaryUp) || (url.startsWith(FALLBACK) && !fallbackUp))
				throw new TypeError('fetch failed');
			return url.endsWith('/models') ? ready() : completionResponse('answer');
		});
		await completeText(SYSTEM, 'first', { maxTokens: 50 });
		const primaryChecks = stub.probes().filter((request) => request.url.startsWith(PRIMARY)).length;
		await completeText(SYSTEM, 'second', { maxTokens: 50 });
		expect(stub.probes().filter((request) => request.url.startsWith(PRIMARY))).toHaveLength(
			primaryChecks
		);
		primaryUp = true;
		fallbackUp = false;
		await expect(completeText(SYSTEM, 'third', { maxTokens: 50 })).resolves.toBe('answer');
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${FALLBACK}/chat/completions`,
			`${FALLBACK}/chat/completions`,
			`${PRIMARY}/chat/completions`
		]);
	});

	it('switches within the readiness timeout when a cached endpoint stops responding', async () => {
		vi.useFakeTimers();
		let primaryUp = true;
		const stub = dualStub(({ url, init }) => {
			if (url.startsWith(PRIMARY) && !primaryUp) return unanswered(init);
			return url.endsWith('/models') ? ready() : completionResponse('answer');
		});
		await completeText(SYSTEM, 'first', { maxTokens: 50 });
		primaryUp = false;
		const result = completeText(SYSTEM, 'second', { maxTokens: 50 }).catch((err) => err);
		await vi.advanceTimersByTimeAsync(LLM_PROBE_TIMEOUT_MS + 1);
		expect(await result).toBe('answer');
		expect(stub.probes().filter((request) => request.url === `${PRIMARY}/models`)).toHaveLength(2);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`,
			`${FALLBACK}/chat/completions`
		]);
	});

	it('checks the preferred primary again after the cached fallback expires', async () => {
		vi.useFakeTimers();
		let primaryUp = false;
		const stub = dualStub(({ url }) => {
			if (url.startsWith(PRIMARY) && !primaryUp) throw new TypeError('fetch failed');
			return url.endsWith('/models') ? ready() : completionResponse('answer');
		});
		await completeText(SYSTEM, 'first', { maxTokens: 50 });
		primaryUp = true;
		await vi.advanceTimersByTimeAsync(LLM_ENDPOINT_CACHE_MS + 1);
		await completeText(SYSTEM, 'second', { maxTokens: 50 });
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${FALLBACK}/chat/completions`,
			`${PRIMARY}/chat/completions`
		]);
	});

	it.each([new TypeError('fetch failed'), 503])(
		'fails over once when generation fails before any output: %s',
		async (failure) => {
			const stub = dualStub(({ url }) => {
				if (url.endsWith('/models')) return ready();
				if (url.startsWith(PRIMARY)) {
					if (failure instanceof Error) throw failure;
					return jsonResponse({ error: 'Server unavailable' }, failure);
				}
				return completionResponse('Use Windows.');
			});
			await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).resolves.toBe('Use Windows.');
			expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
			expect(stub.generations().map((request) => request.url)).toEqual([
				`${PRIMARY}/chat/completions`,
				`${FALLBACK}/chat/completions`
			]);
		}
	);

	it('does not retry either generation endpoint more than once', async () => {
		const stub = dualStub(({ url }) => {
			if (url.endsWith('/models')) return ready();
			throw new TypeError('fetch failed');
		});
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).rejects.toMatchObject({
			status: 502
		});
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`,
			`${FALLBACK}/chat/completions`
		]);
	});

	it('stops readiness checks when the caller cancels', async () => {
		const reached = Promise.withResolvers<void>();
		const stub = dualStub(({ init }) => {
			reached.resolve();
			return unanswered(init);
		});
		const caller = new AbortController();
		const result = completeText(SYSTEM, 'x', { maxTokens: 50, signal: caller.signal }).catch(
			(err) => err
		);
		await Promise.race([reached.promise, result]);
		caller.abort();
		expect(await result).toMatchObject({ status: 499 });
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.probes().every((request) => request.init?.signal?.aborted)).toBe(true);
		expect(stub.generations()).toHaveLength(0);
	});

	it('does not fail over a generation request that the caller cancels', async () => {
		const reached = Promise.withResolvers<void>();
		const stub = dualStub(({ url, init }) => {
			if (url.endsWith('/models')) return ready();
			reached.resolve();
			return unanswered(init);
		});
		const caller = new AbortController();
		const result = completeText(SYSTEM, 'x', { maxTokens: 50, signal: caller.signal }).catch(
			(err) => err
		);
		await Promise.race([reached.promise, result]);
		caller.abort();
		expect(await result).toMatchObject({ status: 499 });
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`
		]);
	});

	it.each([400, 401, 403])('does not bypass a readiness configuration error %i', async (status) => {
		const stub = dualStub(({ url }) =>
			url === `${PRIMARY}/models`
				? jsonResponse({ error: 'private server detail' }, status)
				: completionResponse('Unexpected fallback.')
		);
		const err = await completeText(SYSTEM, 'x', { maxTokens: 50 }).catch((error) => error);
		expect(err).toMatchObject({ status: 502 });
		expect(err.message).not.toContain('private server detail');
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations()).toHaveLength(0);
	});

	it.each([400, 401, 403])(
		'does not fail over a generation configuration error %i',
		async (status) => {
			const stub = dualStub(({ url }) =>
				url.endsWith('/models') ? ready() : jsonResponse({ error: 'private server detail' }, status)
			);
			await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).rejects.toMatchObject({
				status: 502
			});
			expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
			expect(stub.generations().map((request) => request.url)).toEqual([
				`${PRIMARY}/chat/completions`
			]);
		}
	);

	it('does not combine a partial answer with a fallback answer', async () => {
		const stub = dualStub(({ url }) => {
			if (url.endsWith('/models')) return ready();
			let sent = false;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent) controller.error(new TypeError('Connection lost'));
					else {
						sent = true;
						controller.enqueue(new TextEncoder().encode(sseChunk({ content: 'partial answer' })));
					}
				}
			});
			return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
		});
		await expect(completeText(SYSTEM, 'x', { maxTokens: 50 })).rejects.toMatchObject({
			status: 502
		});
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`
		]);
	});

	it('keeps unreadable structured answers on the selected endpoint', async () => {
		const stub = dualStub(({ url }) =>
			url.endsWith('/models') ? ready() : completionResponse('{"ok":"wrong type"}')
		);
		await expect(
			completeJson(z.object({ ok: z.boolean() }), SYSTEM, 'x', { maxTokens: 50 })
		).rejects.toMatchObject({ status: 502 });
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`,
			`${PRIMARY}/chat/completions`
		]);
	});

	it('does not fail over an answer cut off by the token limit', async () => {
		const stub = dualStub(({ url }) =>
			url.endsWith('/models') ? ready() : completionResponse('{"ok":', 'length')
		);
		await expect(
			completeJson(z.object({ ok: z.boolean() }), SYSTEM, 'x', { maxTokens: 50 })
		).rejects.toMatchObject({ status: 502 });
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`
		]);
	});

	it('shares the caller deadline across readiness checks and failover', async () => {
		vi.useFakeTimers();
		const stub = dualStub(({ url, init }) => {
			if (url.endsWith('/models')) return ready();
			if (url.startsWith(PRIMARY))
				return new Promise((resolve) => {
					setTimeout(() => resolve(jsonResponse({ error: 'Unavailable' }, 503)), 750);
				});
			return unanswered(init);
		});
		const result = completeText(SYSTEM, 'x', { maxTokens: 50, timeoutMs: 1_000 }).catch(
			(err) => err
		);
		await vi.advanceTimersByTimeAsync(1_001);
		expect(await result).toMatchObject({ status: 504 });
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`,
			`${FALLBACK}/chat/completions`
		]);
	});

	it('fails over after the primary stays silent before its first output', async () => {
		vi.useFakeTimers();
		const stub = dualStub(({ url, init }) => {
			if (url.endsWith('/models')) return ready();
			return url.startsWith(PRIMARY) ? unanswered(init) : completionResponse('Use Windows.');
		});
		const result = completeText(SYSTEM, 'x', { maxTokens: 50 }).catch((err) => err);
		await vi.advanceTimersByTimeAsync(LLM_IDLE_TIMEOUT_MS + 1);
		expect(await result).toBe('Use Windows.');
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`,
			`${FALLBACK}/chat/completions`
		]);
	});

	it('does not change endpoints if the structured-answer repair loses its connection', async () => {
		let attempts = 0;
		const stub = dualStub(({ url }) => {
			if (url.endsWith('/models')) return ready();
			if (attempts++ === 0) return completionResponse('{"ok":"wrong type"}');
			throw new TypeError('fetch failed');
		});
		await expect(
			completeJson(z.object({ ok: z.boolean() }), SYSTEM, 'x', { maxTokens: 50 })
		).rejects.toMatchObject({ status: 502 });
		expect(stub.probes().map((request) => request.url)).toContain(`${PRIMARY}/models`);
		expect(stub.generations().map((request) => request.url)).toEqual([
			`${PRIMARY}/chat/completions`,
			`${PRIMARY}/chat/completions`
		]);
	});
});
