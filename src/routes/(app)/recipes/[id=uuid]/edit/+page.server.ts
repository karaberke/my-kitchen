import type { Actions, PageServerLoadEvent } from './$types';
import { actionError, guard } from '$lib/server/http';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { getRecipeDetail, recipeToFormInput } from '$lib/server/recipes';
import { handleRecipeSubmit } from '$lib/server/recipe-form';
import { getIngredientMeta } from '$lib/server/ingredients';
import { error, fail } from '@sveltejs/kit';
import { parseRecipeForm } from '$lib/shared/recipe-input';
import { AppError } from '$lib/server/errors';
import { claimLlmCall, llmEnabled } from '$lib/server/llm/client';
import { fixRecipe } from '$lib/server/llm/recipe';

const loadImpl = async (event: PageServerLoadEvent) => {
	const user = requireUser(event);
	const recipe = await getRecipeDetail(db, user.id, event.params.id, null);
	if (!recipe.isOwner)
		throw error(403, 'Only the recipe owner can edit it. Duplicate it to make your own copy.');
	const meta = await getIngredientMeta(
		db,
		recipe.ingredients.map((i) => i.ingredientId).filter((x): x is string => !!x)
	);
	const initial = recipeToFormInput(recipe);
	return {
		title: `Edit ${recipe.title}`,
		recipeId: recipe.id,
		revision: recipe.revision,
		image: recipe.image ? { id: recipe.image.id, version: recipe.image.version } : null,
		initial,
		identityLabels: Object.fromEntries([...meta].map(([id, m]) => [id, m.name])),
		aiEnabled: llmEnabled()
	};
};

export const actions: Actions = {
	// Named, not `default`: SvelteKit refuses every POST to a page that mixes the two.
	save: async (event) => {
		requireUser(event);
		return handleRecipeSubmit(event, event.params.id);
	},
	/**
	 * The assistant's tidy copy of the form as posted. It refills the form and
	 * saves nothing: the user reads it and saves through `save`, with the
	 * revision the form already carries.
	 */
	aiFix: async (event) => {
		const user = requireUser(event);
		let recipe;
		try {
			recipe = await getRecipeDetail(db, user.id, event.params.id, null);
		} catch (err) {
			return actionError(err);
		}
		if (!recipe.isOwner) return fail(403, { message: 'Only the recipe owner can edit it.' });
		const input = parseRecipeForm(await event.request.formData());
		try {
			claimLlmCall(user.id);
			const proposed = await fixRecipe(input, { signal: event.request.signal });
			return { input: proposed, errors: {}, message: '', conflict: false, aiFixed: true };
		} catch (err) {
			// The form keeps what the user typed; only the message changes.
			if (err instanceof AppError)
				return fail(err.status, { input, errors: {}, message: err.message, conflict: false });
			throw err;
		}
	}
};

export const load = guard(loadImpl);
