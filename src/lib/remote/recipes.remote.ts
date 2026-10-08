import { z } from 'zod';
import { command, query } from '$app/server';
import { remote } from '$lib/server/http';
import { askAboutRecipe } from '$lib/server/llm/ask';
import {
	dismissAssistantJobFor,
	listAssistantJobs,
	type AssistantJobView
} from '$lib/server/llm/jobs';
import { parsePositiveAmount } from '$lib/shared/amount-parse';
import {
	LLM_CHAT_ANSWER_MAX_CHARS,
	LLM_CHAT_MAX_TURNS,
	LLM_QUESTION_MAX_CHARS,
	SERVINGS_INPUT_MAX_CHARS
} from '$lib/shared/recipe-input';

/**
 * Ask the assistant a question about a recipe the caller can read, with the
 * earlier turns of the chat (oldest first), the step the cook is on (1-based)
 * and the servings shown. Returns `{ answer }`.
 */
export const askRecipe = command(
	z.object({
		recipeId: z.string().uuid(),
		question: z.string().min(1).max(LLM_QUESTION_MAX_CHARS),
		history: z
			.array(
				z.object({
					question: z.string().max(LLM_QUESTION_MAX_CHARS),
					answer: z.string().max(LLM_CHAT_ANSWER_MAX_CHARS)
				})
			)
			.max(LLM_CHAT_MAX_TURNS)
			.optional(),
		step: z.number().int().min(1).optional(),
		servings: z
			.string()
			.max(SERVINGS_INPUT_MAX_CHARS)
			.refine((s) => parsePositiveAmount(s) !== null, 'Servings must be a positive number.')
			.optional()
	}),
	remote(askAboutRecipe)
);

/** The caller's background assistant imports: `{ jobs }`, running first by start time, newest first. */
export const assistantJobs = query(remote<void, { jobs: AssistantJobView[] }>(listAssistantJobs));

/** Remove one finished job from the caller's list. Returns the list as it is now. */
export const dismissAssistantJob = command(
	z.object({ id: z.string().uuid() }),
	remote(dismissAssistantJobFor)
);
