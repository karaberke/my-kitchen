import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { AppError } from '$lib/server/errors';
import { getRecipeDetail, recipeToPlainText } from '$lib/server/recipes';
import { claimLlmCall, completeText } from './client';
import { RECIPE_ASK_SYSTEM, RECIPE_ASK_TASK } from './prompts';
import { LLM_MAX_INPUT_CHARS } from './recipe';
import { LLM_QUESTION_MAX_CHARS } from '$lib/shared/recipe-input';

/** A short answer to one question. */
export const LLM_ANSWER_MAX_TOKENS = 400;

/** Answer one question about a recipe the caller can read. Nothing is stored. */
export async function askAboutRecipe(
	event: RequestEvent,
	arg: { recipeId: string; question: string }
): Promise<{ answer: string }> {
	const user = requireUserApi(event);
	const question = arg.question
		.replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, LLM_QUESTION_MAX_CHARS);
	if (!question) throw new AppError(400, 'Type a question first.');
	// The access check: a recipe this user cannot read is a 404, before any quota is spent.
	const recipe = await getRecipeDetail(db, user.id, arg.recipeId, null);
	claimLlmCall(user.id);
	const text = recipeToPlainText(recipe).slice(0, LLM_MAX_INPUT_CHARS);
	// The recipe goes before the question, so a second question about the same
	// recipe reuses the server's cached prefix.
	const answer = await completeText(
		RECIPE_ASK_SYSTEM,
		`${RECIPE_ASK_TASK}${text}\n\nQuestion: ${question}`,
		{ maxTokens: LLM_ANSWER_MAX_TOKENS }
	);
	return { answer };
}
