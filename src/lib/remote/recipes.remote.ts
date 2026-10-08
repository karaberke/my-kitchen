import { z } from 'zod';
import { command } from '$app/server';
import { remote } from '$lib/server/http';
import { askAboutRecipe } from '$lib/server/llm/ask';
import { LLM_QUESTION_MAX_CHARS } from '$lib/shared/recipe-input';

/** Ask the assistant one question about a recipe the caller can read. Returns `{ answer }`. */
export const askRecipe = command(
	z.object({
		recipeId: z.string().uuid(),
		question: z.string().min(1).max(LLM_QUESTION_MAX_CHARS)
	}),
	remote(askAboutRecipe)
);
