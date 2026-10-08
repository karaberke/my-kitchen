import { z } from 'zod';
import { command, query } from '$app/server';
import { remote } from '$lib/server/http';
import { INGREDIENT_NAME_MAX, suggestIngredients } from '$lib/server/ingredients';
import { matchIngredient } from '$lib/server/ingredient-match';
import { suggestIngredientMatch } from '$lib/server/llm/match';
import { INGREDIENT_MATCH_MAX_NAMES } from '$lib/shared/assistant-limits';

/** Autocomplete: catalog + the caller's own custom identities only. */
export const ingredientSuggestions = query(
	z.object({ q: z.string(), limit: z.number().optional() }),
	remote(suggestIngredients)
);

/** The catalog match the app proposes for one written name, or null. */
export const ingredientMatch = query(z.object({ name: z.string() }), remote(matchIngredient));

/**
 * The assistant's pick among the catalog candidates for names the strict
 * matcher could not link; a suggestion only, nothing is linked. A command, not
 * a query: it spends assistant quota, so a refresh must not run it again.
 */
export const assistantIngredientMatch = command(
	z.object({
		names: z.array(z.string().max(INGREDIENT_NAME_MAX)).min(1).max(INGREDIENT_MATCH_MAX_NAMES)
	}),
	remote(suggestIngredientMatch)
);
