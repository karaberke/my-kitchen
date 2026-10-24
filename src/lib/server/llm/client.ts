import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { z, type ZodType } from 'zod';
import { serverEnv } from '$lib/server/env';
import { AppError } from '$lib/server/errors';
import { LLM_LIMITS, consume } from '$lib/server/ratelimit';
import { discardBody, readCappedOrNull } from '$lib/server/fetch-capped';

/**
 * The AI assistant: OpenAI-compatible model servers on the private network.
 *
 * The server is a small CPU box. It answers one request at a time, it is slow
 * (about 19 tokens a second out), and its context is 8192 tokens. So every
 * call sets `max_tokens`, every call waits its turn in one process-wide queue,
 * and the system prompt stays identical so the server can reuse its prefix
 * cache. Nothing the model says is trusted: JSON is checked with zod, and the
 * caller only ever shows the result as a proposal.
 */

export interface LlmConfig {
	baseUrl: string;
	/** A second installation of the same model, such as the other dual-boot OS. */
	fallbackBaseUrl?: string;
	apiKey: string;
	model: string;
}

export type LlmFetch = typeof fetch;

/**
 * A request whose server sends nothing for this long is a 504. Replies are
 * streamed, so a slow server that is still writing tokens is never cut off;
 * the gap before the first token (reading the prompt, about 30 s for a long
 * recipe on the CPU) has to fit in it too.
 */
export const LLM_IDLE_TIMEOUT_MS = 90_000;
/** The most one interactive request may take in total, even while tokens arrive. */
export const LLM_TIMEOUT_MS = 300_000;
/** The limit for work nobody waits on, such as an import that runs in the background. */
export const LLM_BACKGROUND_TIMEOUT_MS = 600_000;
/** Low, so structured output copies the source instead of inventing. */
export const LLM_JSON_TEMPERATURE = 0.1;
export const LLM_TEXT_TEMPERATURE = 0.3;
/** The cut-off message when the caller words none of its own. */
export const LLM_TOO_LONG_MESSAGE = 'The request is too long for the assistant.';
/** Interactive calls allowed to wait behind the running one before a caller is told to come back. */
export const LLM_MAX_WAITING = 3;
/** Readiness checks must not wait for an offline operating system. */
export const LLM_PROBE_TIMEOUT_MS = 2_000;
/** Reuse the working server briefly, then check both installations again. */
export const LLM_ENDPOINT_CACHE_MS = 30_000;
/** Model lists are small; never buffer an unbounded readiness response. */
export const LLM_MODELS_MAX_BYTES = 64 * 1024;

/**
 * How one call waits and how long it may run. A `background` call has no
 * person waiting on it: it gets `LLM_BACKGROUND_TIMEOUT_MS`, it is never told
 * the queue is full, and every interactive call waiting goes before it.
 */
export interface LlmCallOptions {
	timeoutMs?: number;
	background?: boolean;
	/**
	 * The caller's request signal. When it aborts, a call still waiting leaves
	 * the queue without reaching the server, and a running call is stopped.
	 */
	signal?: AbortSignal;
}

/** The person who asked went away; nobody reads this answer. */
function cancelledError(): AppError {
	return new AppError(499, 'The request was cancelled.');
}

function timeoutFor(call: LlmCallOptions): number {
	return call.timeoutMs ?? (call.background ? LLM_BACKGROUND_TIMEOUT_MS : LLM_TIMEOUT_MS);
}

let override: { config: LlmConfig | null; fetch?: LlmFetch } | null = null;
const clients = new Map<string, OpenAI>();
let preferred: { key: string; baseUrl: string; until: number } | null = null;

/**
 * Test hook: point the assistant at a stub `fetch` (or switch it off with
 * `config: null`) without the environment. Pass null to go back to the env.
 */
export function setLlmForTests(next: { config: LlmConfig | null; fetch?: LlmFetch } | null) {
	override = next;
	clients.clear();
	preferred = null;
}

/**
 * The assistant's configuration, or null when it is off.
 *
 * Reading the environment happens here and nowhere else.
 */
export function llmConfig(): LlmConfig | null {
	if (override) return override.config;
	const env = serverEnv();
	const baseUrl = env.LLM_BASE_URL || env.LLM_FALLBACK_BASE_URL;
	if (!baseUrl) return null;
	return {
		baseUrl,
		...(env.LLM_BASE_URL && env.LLM_FALLBACK_BASE_URL
			? { fallbackBaseUrl: env.LLM_FALLBACK_BASE_URL }
			: {}),
		apiKey: env.LLM_API_KEY,
		model: env.LLM_MODEL
	};
}

export function llmEnabled(): boolean {
	return llmConfig() !== null;
}

/** A client for one configuration. */
function createLlmClient(config: LlmConfig, fetchImpl?: LlmFetch): OpenAI {
	return new OpenAI({
		baseURL: config.baseUrl,
		apiKey: config.apiKey,
		// The real limits are in `chat`; this one only backs them up.
		timeout: LLM_BACKGROUND_TIMEOUT_MS + LLM_IDLE_TIMEOUT_MS,
		// A retry would put a second slow request in the one-slot queue; the
		// caller decides what a failure means instead.
		maxRetries: 0,
		...(fetchImpl ? { fetch: fetchImpl } : {})
	});
}

function client(config: LlmConfig, baseUrl: string): OpenAI {
	const key = `${baseUrl}\n${config.apiKey}`;
	let openai = clients.get(key);
	if (!openai) {
		openai = createLlmClient({ ...config, baseUrl }, override?.fetch);
		clients.set(key, openai);
	}
	return openai;
}

type ProbeResult = 'ready' | 'unavailable' | 'refused';

/** Check the authenticated OpenAI model list, including loading and wrong-model servers. */
async function probeEndpoint(
	config: LlmConfig,
	baseUrl: string,
	signal: AbortSignal
): Promise<ProbeResult> {
	if (signal.aborted) return 'unavailable';
	const abort = new AbortController();
	const cancel = () => abort.abort();
	signal.addEventListener('abort', cancel, { once: true });
	const timer = setTimeout(cancel, LLM_PROBE_TIMEOUT_MS);
	let onAbort: () => void;
	const interrupted = new Promise<ProbeResult>((resolve) => {
		onAbort = () => resolve('unavailable');
		abort.signal.addEventListener('abort', onAbort, { once: true });
	});
	try {
		const probe = async (): Promise<ProbeResult> => {
			const response = await (override?.fetch ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/models`, {
				method: 'GET',
				headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}` },
				redirect: 'error',
				signal: abort.signal
			});
			if (!response.ok) {
				await discardBody(response);
				return [400, 401, 403].includes(response.status) ? 'refused' : 'unavailable';
			}
			const bytes = await readCappedOrNull(response, LLM_MODELS_MAX_BYTES);
			if (!bytes) return 'unavailable';
			const body: unknown = JSON.parse(bytes.toString('utf8'));
			const parsed = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(body);
			return parsed.success && parsed.data.data.some((model) => model.id === config.model)
				? 'ready'
				: 'unavailable';
		};
		return await Promise.race([probe().catch((): ProbeResult => 'unavailable'), interrupted]);
	} finally {
		signal.removeEventListener('abort', cancel);
		abort.signal.removeEventListener('abort', onAbort!);
		clearTimeout(timer);
	}
}

/** Kept for the whole queued call, including a structured-output repair attempt. */
interface LlmRoute {
	selected?: string;
	failoverUsed?: boolean;
	deadline?: number;
}

function routeKey(config: LlmConfig): string {
	return `${config.baseUrl}\n${config.fallbackBaseUrl ?? ''}\n${config.apiKey}\n${config.model}`;
}

async function selectEndpoint(
	config: LlmConfig,
	urls: string[],
	signal: AbortSignal
): Promise<string> {
	let candidates = urls;
	if (preferred?.key === routeKey(config) && preferred.until > Date.now()) {
		const cachedUrl = preferred.baseUrl;
		const readiness = await probeEndpoint(config, cachedUrl, signal);
		if (readiness === 'ready') return cachedUrl;
		if (readiness === 'refused') throw new AppError(502, 'The assistant could not answer.');
		// A reboot can silently blackhole the previously working address. Bound
		// that check too, without probing the offline OS on healthy cached calls.
		preferred = null;
		candidates = urls.filter((url) => url !== cachedUrl);
	}
	const readiness = await Promise.all(candidates.map((url) => probeEndpoint(config, url, signal)));
	if (readiness.includes('refused')) throw new AppError(502, 'The assistant could not answer.');
	const ready = readiness.indexOf('ready');
	if (ready < 0) throw new AppError(502, 'The assistant could not be reached.');
	return candidates[ready];
}

/** Only a transient failure before any response chunk is safe to send elsewhere. */
function canFailOver(err: unknown): boolean {
	return (
		err instanceof APIConnectionError ||
		(err instanceof APIError &&
			(err.status === 408 || err.status === 409 || err.status === 429 || (err.status ?? 0) >= 500))
	);
}

/**
 * Check that the assistant is on and that this user still has calls left.
 * Throws 503 or 429; call it before the slow work starts.
 */
export function claimLlmCall(userId: string, rule: keyof typeof LLM_LIMITS = 'user'): void {
	if (!llmEnabled()) throw new AppError(503, 'The assistant is not set up on this installation.');
	// One bucket per rule, so a long chat does not use up the imports.
	const limit = consume(`llm:${rule}:${userId}`, LLM_LIMITS[rule]);
	if (!limit.allowed)
		throw new AppError(
			429,
			`Too many assistant requests. Try again in ${limit.retryAfterSeconds} seconds.`
		);
}

/* -------------------------------------------------------------------- */
/* One request at a time                                                 */
/* -------------------------------------------------------------------- */

/** Calls not started yet, one lane per kind; interactive calls go first. */
const lanes = {
	interactive: [] as (() => Promise<void>)[],
	background: [] as (() => Promise<void>)[]
};
let running = false;

function pump() {
	if (running) return;
	const next = lanes.interactive.shift() ?? lanes.background.shift();
	if (!next) return;
	running = true;
	void next().finally(() => {
		running = false;
		pump();
	});
}

function enqueue<T>(job: () => Promise<T>, call: LlmCallOptions): Promise<T> {
	const { background = false, signal } = call;
	if (signal?.aborted) return Promise.reject(cancelledError());
	if (!background && lanes.interactive.length >= LLM_MAX_WAITING)
		throw new AppError(503, 'The assistant is busy. Try again in a minute.');
	const lane = background ? lanes.background : lanes.interactive;
	return new Promise<T>((resolve, reject) => {
		// A caller that goes away while waiting gives up its place; the server never sees it.
		const onAbort = () => {
			const at = lane.indexOf(start);
			if (at < 0) return;
			lane.splice(at, 1);
			reject(cancelledError());
		};
		const start = () => {
			signal?.removeEventListener('abort', onAbort);
			return Promise.resolve().then(job).then(resolve, reject);
		};
		lane.push(start);
		signal?.addEventListener('abort', onAbort, { once: true });
		// Started on the next tick, so a burst of callers is counted before the first one runs.
		void Promise.resolve().then(pump);
	});
}

/** Map a client failure to an error that is safe to show. Nothing from the server leaks. */
function asLlmError(err: unknown): AppError {
	if (err instanceof AppError) return err;
	if (err instanceof APIConnectionTimeoutError)
		return new AppError(504, 'The assistant took too long to answer.');
	if (err instanceof APIConnectionError)
		return new AppError(502, 'The assistant could not be reached.');
	if (err instanceof APIError) {
		console.warn(`llm: request refused with status ${err.status ?? 'unknown'}`);
		return new AppError(502, 'The assistant could not answer.');
	}
	console.warn('llm: unexpected failure', err instanceof Error ? err.name : typeof err);
	return new AppError(502, 'The assistant could not answer.');
}

interface Reply {
	content: string;
	finishReason: string | null;
}

type StopReason = 'idle' | 'total' | 'cancelled';

function stoppedError(why: StopReason): AppError {
	if (why === 'cancelled') return cancelledError();
	return why === 'idle'
		? new AppError(504, 'The assistant stopped answering.')
		: new AppError(504, 'The assistant took too long to answer.');
}

/** One turn of a conversation after the system prompt. */
export interface LlmMessage {
	role: 'user' | 'assistant';
	content: string;
}

async function chat(
	system: string,
	messages: LlmMessage[],
	params: {
		maxTokens: number;
		temperature: number;
		responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];
		timeoutMs: number;
		signal?: AbortSignal;
	},
	route: LlmRoute = {}
): Promise<Reply> {
	const config = llmConfig();
	if (!config) throw new AppError(503, 'The assistant is not set up on this installation.');
	const urls = [
		...new Set([config.baseUrl, config.fallbackBaseUrl].filter((url): url is string => !!url))
	];
	const dual = urls.length > 1;
	// One total budget includes readiness checks and both generation attempts.
	if (dual) route.deadline ??= Date.now() + params.timeoutMs;
	const remaining = dual ? route.deadline! - Date.now() : params.timeoutMs;
	if (remaining <= 0) throw stoppedError('total');
	const abort = new AbortController();
	let stopped: StopReason | null = null;
	const stop = (why: StopReason) => {
		stopped ??= why;
		abort.abort();
	};
	const cancel = () => stop('cancelled');
	if (params.signal?.aborted) throw cancelledError();
	params.signal?.addEventListener('abort', cancel, { once: true });
	const total = setTimeout(() => stop('total'), remaining);
	try {
		route.selected ??= dual ? await selectEndpoint(config, urls, abort.signal) : urls[0];
		if (stopped) throw stoppedError(stopped);
		for (;;) {
			// An idle attempt can end before output and try the other installation,
			// while cancellation and the total deadline still stop the whole call.
			const attemptAbort = new AbortController();
			const cancelAttempt = () => attemptAbort.abort();
			abort.signal.addEventListener('abort', cancelAttempt, { once: true });
			let idleStopped = false;
			let receivedChunk = false;
			const stopIdle = () => {
				idleStopped = true;
				attemptAbort.abort();
			};
			let idle = setTimeout(stopIdle, LLM_IDLE_TIMEOUT_MS);
			try {
				const stream = await client(config, route.selected).chat.completions.create(
					{
						model: config.model,
						messages: [{ role: 'system', content: system }, ...messages],
						max_tokens: params.maxTokens,
						temperature: params.temperature,
						stream: true,
						...(params.responseFormat ? { response_format: params.responseFormat } : {})
					},
					{ signal: attemptAbort.signal }
				);
				let content = '';
				let finishReason: string | null = null;
				for await (const chunk of stream) {
					receivedChunk = true;
					clearTimeout(idle);
					idle = setTimeout(stopIdle, LLM_IDLE_TIMEOUT_MS);
					const choice = chunk.choices?.[0];
					if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
					if (choice?.finish_reason) finishReason = choice.finish_reason;
				}
				// The SDK ends an aborted stream quietly; a partial reply must not pass.
				if (stopped) throw stoppedError(stopped);
				if (idleStopped) throw stoppedError('idle');
				if (dual)
					preferred = {
						key: routeKey(config),
						baseUrl: route.selected,
						until: Date.now() + LLM_ENDPOINT_CACHE_MS
					};
				return { content, finishReason };
			} catch (err) {
				clearTimeout(idle);
				if (stopped) throw stoppedError(stopped);
				if (dual && !route.failoverUsed && !receivedChunk && (idleStopped || canFailOver(err))) {
					route.failoverUsed = true;
					if (preferred?.key === routeKey(config)) preferred = null;
					const other = urls.find((url) => url !== route.selected)!;
					const readiness = await probeEndpoint(config, other, abort.signal);
					if (stopped) throw stoppedError(stopped);
					if (readiness === 'refused') throw new AppError(502, 'The assistant could not answer.');
					if (readiness === 'ready') {
						route.selected = other;
						continue;
					}
				}
				throw idleStopped ? stoppedError('idle') : asLlmError(err);
			} finally {
				abort.signal.removeEventListener('abort', cancelAttempt);
				clearTimeout(idle);
			}
		}
	} catch (err) {
		throw stopped ? stoppedError(stopped) : asLlmError(err);
	} finally {
		params.signal?.removeEventListener('abort', cancel);
		clearTimeout(total);
	}
}

/** Drop the thinking block some servers put before the answer. */
function stripThinking(content: string): string {
	return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** A thinking block or a code fence some servers add around JSON. */
function unwrapJson(content: string): string {
	return stripThinking(content)
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '')
		.trim();
}

/**
 * Ask for JSON that matches `schema`.
 *
 * The server's `json_schema` mode makes the reply valid JSON, not correct
 * values, so zod checks it. An unreadable or wrong reply is asked for one more
 * time; a reply cut off by `max_tokens` is not, because the second one would be
 * cut off too. Then it is a 502.
 */
export async function completeJson<T>(
	schema: ZodType<T>,
	system: string,
	userText: string,
	options: {
		maxTokens: number;
		name?: string;
		/** Shown when the reply is cut off by `maxTokens`; worded for what was sent. */
		tooLongMessage?: string;
	} & LlmCallOptions
): Promise<T> {
	const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
	// Draft markers mean nothing to the server's grammar builder.
	delete jsonSchema.$schema;
	const responseFormat = {
		type: 'json_schema' as const,
		json_schema: { name: options.name ?? 'result', strict: true, schema: jsonSchema }
	};
	return enqueue(async () => {
		const route: LlmRoute = {};
		for (let attempt = 0; attempt < 2; attempt++) {
			const reply = await chat(
				system,
				[{ role: 'user', content: userText }],
				{
					maxTokens: options.maxTokens,
					temperature: LLM_JSON_TEMPERATURE,
					responseFormat,
					timeoutMs: timeoutFor(options),
					signal: options.signal
				},
				route
			);
			// A structured-output repair stays on the server that gave the reply.
			route.failoverUsed = true;
			if (reply.finishReason === 'length')
				throw new AppError(502, options.tooLongMessage ?? LLM_TOO_LONG_MESSAGE);
			let json: unknown;
			try {
				json = JSON.parse(unwrapJson(reply.content));
			} catch {
				continue;
			}
			const parsed = schema.safeParse(json);
			if (parsed.success) return parsed.data;
		}
		throw new AppError(502, 'The assistant gave an answer that could not be read.');
	}, options);
}

/** Ask for plain text, such as the answer to a question. */
export async function completeText(
	system: string,
	userText: string,
	options: { maxTokens: number } & LlmCallOptions
): Promise<string> {
	return completeChat(system, [{ role: 'user', content: userText }], options);
}

/**
 * Ask for plain text in a conversation: `messages` are the earlier turns in
 * order and end with the new user message. Keep the earlier turns byte-identical
 * from call to call, so the server reuses its cached prefix.
 */
export async function completeChat(
	system: string,
	messages: LlmMessage[],
	options: { maxTokens: number } & LlmCallOptions
): Promise<string> {
	if (messages.at(-1)?.role !== 'user') throw new Error('completeChat needs a user message last');
	return enqueue(async () => {
		const reply = await chat(system, messages, {
			maxTokens: options.maxTokens,
			temperature: LLM_TEXT_TEMPERATURE,
			timeoutMs: timeoutFor(options),
			signal: options.signal
		});
		const text = stripThinking(reply.content);
		if (!text) throw new AppError(502, 'The assistant gave no answer.');
		return text;
	}, options);
}
