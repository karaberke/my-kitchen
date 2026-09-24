import { z } from 'zod';
import { query } from '$app/server';
import { remote } from '$lib/server/http';
import { suggestIngredients } from '$lib/server/ingredients';
import { matchIngredient } from '$lib/server/ingredient-match';

/** Autocomplete: catalog + the caller's own custom identities only. */
export const ingredientSuggestions = query(
	z.object({ q: z.string(), limit: z.number().optional() }),
	remote(suggestIngredients)
);

/** The catalog match the app proposes for one written name, or null. */
export const ingredientMatch = query(z.object({ name: z.string() }), remote(matchIngredient));
