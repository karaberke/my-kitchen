import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import { z, type ZodType } from 'zod';
import { serverEnv } from '$lib/server/env';
import { AppError } from '$lib/server/errors';
import { LLM_LIMITS, consume } from '$lib/server/ratelimit';

/**
 * The AI assistant: one OpenAI-compatible model server on the private network.
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
/** Interactive calls allowed to wait behind the running one before a caller is told to come back. */
export const LLM_MAX_WAITING = 3;

/**
 * How one call waits and how long it may run. A `background` call has no
 * person waiting on it: it gets `LLM_BACKGROUND_TIMEOUT_MS`, it is never told
 * the queue is full, and every interactive call waiting goes before it.
 */
export interface LlmCallOptions {
	timeoutMs?: number;
	background?: boolean;
}

function timeoutFor(call: LlmCallOptions): number {
	return call.timeoutMs ?? (call.background ? LLM_BACKGROUND_TIMEOUT_MS : LLM_TIMEOUT_MS);
}

let override: { config: LlmConfig | null; fetch?: LlmFetch } | null = null;
let cached: { key: string; openai: OpenAI } | null = null;

/**
 * Test hook: point the assistant at a stub `fetch` (or switch it off with
 * `config: null`) without the environment. Pass null to go back to the env.
 */
export function setLlmForTests(next: { config: LlmConfig | null; fetch?: LlmFetch } | null) {
	override = next;
	cached = null;
}

/**
 * The assistant's configuration, or null when it is off.
 *
 * Reading the environment happens here and nowhere else.
 */
export function llmConfig(): LlmConfig | null {
	if (override) return override.config;
	const env = serverEnv();
	if (!env.LLM_BASE_URL) return null;
	return { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL };
}

export function llmEnabled(): boolean {
	return llmConfig() !== null;
}

/** A client for one configuration. Exported so a test can build one with its own `fetch`. */
export function createLlmClient(config: LlmConfig, fetchImpl?: LlmFetch): OpenAI {
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

function client(): { openai: OpenAI; model: string } {
	const config = llmConfig();
	if (!config) throw new AppError(503, 'The assistant is not set up on this installation.');
	const key = `${config.baseUrl}\n${config.apiKey}`;
	if (!cached || cached.key !== key)
		cached = { key, openai: createLlmClient(config, override?.fetch) };
	return { openai: cached.openai, model: config.model };
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

function enqueue<T>(job: () => Promise<T>, background = false): Promise<T> {
	if (!background && lanes.interactive.length >= LLM_MAX_WAITING)
		throw new AppError(503, 'The assistant is busy. Try again in a minute.');
	return new Promise<T>((resolve, reject) => {
		(background ? lanes.background : lanes.interactive).push(() =>
			Promise.resolve().then(job).then(resolve, reject)
		);
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

function stoppedError(why: 'idle' | 'total'): AppError {
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
	}
): Promise<Reply> {
	const { openai, model } = client();
	// Streamed, so the limit is on silence, not on how long a slow server writes.
	const abort = new AbortController();
	let stopped: 'idle' | 'total' | null = null;
	const stop = (why: 'idle' | 'total') => {
		stopped = why;
		abort.abort();
	};
	let idle = setTimeout(() => stop('idle'), LLM_IDLE_TIMEOUT_MS);
	const total = setTimeout(() => stop('total'), params.timeoutMs);
	try {
		const stream = await openai.chat.completions.create(
			{
				model,
				messages: [{ role: 'system', content: system }, ...messages],
				max_tokens: params.maxTokens,
				temperature: params.temperature,
				stream: true,
				...(params.responseFormat ? { response_format: params.responseFormat } : {})
			},
			{ signal: abort.signal }
		);
		let content = '';
		let finishReason: string | null = null;
		for await (const chunk of stream) {
			clearTimeout(idle);
			idle = setTimeout(() => stop('idle'), LLM_IDLE_TIMEOUT_MS);
			const choice = chunk.choices?.[0];
			if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
			if (choice?.finish_reason) finishReason = choice.finish_reason;
		}
		// The SDK ends an aborted stream quietly, so a partial reply must not pass.
		if (stopped) throw stoppedError(stopped);
		return { content, finishReason };
	} catch (err) {
		throw stopped ? stoppedError(stopped) : asLlmError(err);
	} finally {
		clearTimeout(idle);
		clearTimeout(total);
	}
}

/** A thinking block or a code fence some servers add around JSON. */
function unwrapJson(content: string): string {
	return content
		.replace(/<think>[\s\S]*?<\/think>/gi, '')
		.trim()
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
	options: { maxTokens: number; name?: string } & LlmCallOptions
): Promise<T> {
	const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
	// Draft markers mean nothing to the server's grammar builder.
	delete jsonSchema.$schema;
	const responseFormat = {
		type: 'json_schema' as const,
		json_schema: { name: options.name ?? 'result', strict: true, schema: jsonSchema }
	};
	return enqueue(async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const reply = await chat(system, [{ role: 'user', content: userText }], {
				maxTokens: options.maxTokens,
				temperature: LLM_JSON_TEMPERATURE,
				responseFormat,
				timeoutMs: timeoutFor(options)
			});
			if (reply.finishReason === 'length')
				throw new AppError(502, 'The recipe is too long for the assistant.');
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
	}, options.background);
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
			timeoutMs: timeoutFor(options)
		});
		const text = reply.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
		if (!text) throw new AppError(502, 'The assistant gave no answer.');
		return text;
	}, options.background);
}
