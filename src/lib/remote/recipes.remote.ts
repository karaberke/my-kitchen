import { z } from 'zod';
import { command, query } from '$app/server';
import { remote } from '$lib/server/http';
import { askAboutRecipe } from '$lib/server/llm/ask';
import {
	dismissAssistantJobFor,
	listAssistantJobs,
	type AssistantJobView
} from '$lib/server/llm/jobs';
import { LLM_QUESTION_MAX_CHARS } from '$lib/shared/recipe-input';

/** Ask the assistant one question about a recipe the caller can read. Returns `{ answer }`. */
export const askRecipe = command(
	z.object({
		recipeId: z.string().uuid(),
		question: z.string().min(1).max(LLM_QUESTION_MAX_CHARS)
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
