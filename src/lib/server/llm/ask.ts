import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { AppError } from '$lib/server/errors';
import { getRecipeDetail, recipeToPlainText } from '$lib/server/recipes';
import { claimLlmCall, completeChat, type LlmMessage } from './client';
import { RECIPE_ASK_SYSTEM, RECIPE_ASK_TASK } from './prompts';
import { LLM_MAX_INPUT_CHARS } from './recipe';
import { parsePositiveAmount } from '$lib/shared/amount-parse';
import {
	LLM_CHAT_ANSWER_MAX_CHARS,
	LLM_CHAT_HISTORY_MAX_CHARS,
	LLM_CHAT_MAX_TURNS,
	LLM_QUESTION_MAX_CHARS,
	type RecipeChatTurn
} from '$lib/shared/recipe-input';

/** A short answer to one question. */
export const LLM_ANSWER_MAX_TOKENS = 400;

/** Text from the browser made safe for the prompt: no control characters, one line, at most `max` characters. */
export function cleanChatText(raw: string, max: number): string {
	return raw
		.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

/**
 * The earlier turns the model sees: each part cleaned, empty turns removed,
 * then the oldest dropped until at most `LLM_CHAT_MAX_TURNS` remain and they
 * fit in `LLM_CHAT_HISTORY_MAX_CHARS`. The newest turns are kept.
 */
export function trimChatHistory(history: readonly RecipeChatTurn[]): RecipeChatTurn[] {
	const turns = history
		.map((t) => ({
			question: cleanChatText(t.question, LLM_QUESTION_MAX_CHARS),
			answer: cleanChatText(t.answer, LLM_CHAT_ANSWER_MAX_CHARS)
		}))
		.filter((t) => t.question && t.answer)
		.slice(-LLM_CHAT_MAX_TURNS);
	let size = turns.reduce((n, t) => n + t.question.length + t.answer.length, 0);
	let first = 0;
	while (first < turns.length && size > LLM_CHAT_HISTORY_MAX_CHARS) {
		size -= turns[first].question.length + turns[first].answer.length;
		first++;
	}
	return turns.slice(first);
}

/** The context for the newest question only, such as "(On step 3 of 7.) ". Empty when the step is unknown or out of range. */
export function stepNote(step: number | undefined, stepCount: number): string {
	if (step === undefined || !Number.isInteger(step) || step < 1 || step > stepCount) return '';
	return `(On step ${step} of ${stepCount}.) `;
}

/**
 * The conversation after the system prompt, in the order the model server can
 * cache: the recipe text and the first question, then each answer and the next
 * question, and the new question last. The per-turn `note` goes only in the
 * last message, so everything before it is the same bytes on the next turn.
 */
export function buildRecipeChatMessages(
	recipeText: string,
	history: readonly RecipeChatTurn[],
	question: string,
	note = ''
): LlmMessage[] {
	const questions = [...history.map((t) => t.question), question];
	const messages: LlmMessage[] = [];
	questions.forEach((q, i) => {
		const last = i === questions.length - 1;
		const asked = `${last ? note : ''}Question: ${q}`;
		messages.push({
			role: 'user',
			content: i === 0 ? `${RECIPE_ASK_TASK}${recipeText}\n\n${asked}` : asked
		});
		if (!last) messages.push({ role: 'assistant', content: history[i].answer });
	});
	return messages;
}

/**
 * Answer a question about a recipe the caller can read, with the earlier turns
 * of the chat. `step` is the step the cook is on (1-based); `servings` scales
 * the amounts in code before the model sees them. Nothing is stored.
 */
export async function askAboutRecipe(
	event: RequestEvent,
	arg: {
		recipeId: string;
		question: string;
		history?: RecipeChatTurn[];
		step?: number;
		servings?: string;
	}
): Promise<{ answer: string }> {
	const user = requireUserApi(event);
	const question = cleanChatText(arg.question, LLM_QUESTION_MAX_CHARS);
	if (!question) throw new AppError(400, 'Type a question first.');
	const servings = arg.servings === undefined ? undefined : parsePositiveAmount(arg.servings);
	if (servings === null) throw new AppError(400, 'Servings must be a positive number.');
	// The access check: a recipe this user cannot read is a 404, before any quota is spent.
	const recipe = await getRecipeDetail(db, user.id, arg.recipeId, null);
	claimLlmCall(user.id, 'chat');
	const text = recipeToPlainText(recipe, servings).slice(0, LLM_MAX_INPUT_CHARS);
	const messages = buildRecipeChatMessages(
		text,
		trimChatHistory(arg.history ?? []),
		question,
		stepNote(arg.step, recipe.steps.length)
	);
	const answer = await completeChat(RECIPE_ASK_SYSTEM, messages, {
		maxTokens: LLM_ANSWER_MAX_TOKENS
	});
	return { answer };
}
