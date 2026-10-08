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

/** One request may run this long before it is a 504. */
export const LLM_TIMEOUT_MS = 120_000;
/** Low, so structured output copies the source instead of inventing. */
export const LLM_JSON_TEMPERATURE = 0.1;
export const LLM_TEXT_TEMPERATURE = 0.3;
/** Calls allowed to wait behind the running one before a caller is told to come back. */
export const LLM_MAX_WAITING = 3;

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
		timeout: LLM_TIMEOUT_MS,
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
export function claimLlmCall(userId: string): void {
	if (!llmEnabled()) throw new AppError(503, 'The assistant is not set up on this installation.');
	const limit = consume(`llm:${userId}`, LLM_LIMITS.user);
	if (!limit.allowed)
		throw new AppError(
			429,
			`Too many assistant requests. Try again in ${limit.retryAfterSeconds} seconds.`
		);
}

/* -------------------------------------------------------------------- */
/* One request at a time                                                 */
/* -------------------------------------------------------------------- */

let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;

function enqueue<T>(job: () => Promise<T>): Promise<T> {
	if (waiting >= LLM_MAX_WAITING)
		throw new AppError(503, 'The assistant is busy. Try again in a minute.');
	waiting++;
	const start = () => {
		waiting--;
		return job();
	};
	const run = tail.then(start, start);
	tail = run.catch(() => undefined);
	return run;
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

async function chat(
	system: string,
	userText: string,
	params: {
		maxTokens: number;
		temperature: number;
		responseFormat?: OpenAI.Chat.Completions.ChatCompletionCreateParams['response_format'];
	}
): Promise<Reply> {
	const { openai, model } = client();
	try {
		const res = await openai.chat.completions.create({
			model,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: userText }
			],
			max_tokens: params.maxTokens,
			temperature: params.temperature,
			...(params.responseFormat ? { response_format: params.responseFormat } : {})
		});
		const choice = res.choices?.[0];
		return {
			content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
			finishReason: choice?.finish_reason ?? null
		};
	} catch (err) {
		throw asLlmError(err);
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
	options: { maxTokens: number; name?: string }
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
			const reply = await chat(system, userText, {
				maxTokens: options.maxTokens,
				temperature: LLM_JSON_TEMPERATURE,
				responseFormat
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
	});
}

/** Ask for plain text, such as the answer to a question. */
export async function completeText(
	system: string,
	userText: string,
	options: { maxTokens: number }
): Promise<string> {
	return enqueue(async () => {
		const reply = await chat(system, userText, {
			maxTokens: options.maxTokens,
			temperature: LLM_TEXT_TEMPERATURE
		});
		const text = reply.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
		if (!text) throw new AppError(502, 'The assistant gave no answer.');
		return text;
	});
}
