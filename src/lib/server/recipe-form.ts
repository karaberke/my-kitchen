import { fail, redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { createCustomIngredient } from '$lib/server/ingredients';
import { deleteImageIfUnreferenced, storeRecipeImage } from '$lib/server/media/images';
import { createRecipe, updateRecipe } from '$lib/server/recipes';
import { parseRecipeForm, validateRecipe, type RecipeFormInput } from '$lib/shared/recipe-input';

export type RecipeFormClientInput = RecipeFormInput;

/** Shared action for the new/edit pages. Preserves all input on validation errors. */
export async function handleRecipeSubmit(event: RequestEvent, recipeId: string | null) {
	const user = event.locals.user!;
	const fd = await event.request.formData();
	const input = parseRecipeForm(fd);
	const validation = validateRecipe(input);
	if (!validation.ok)
		return fail(400, {
			input,
			errors: validation.errors,
			message: 'Please fix the highlighted fields.',
			conflict: false
		});

	// Confirmed "new ingredient" rows get a private identity owned by the user.
	for (const v of validation.value.ingredients) {
		if (!v.ingredientId && v.createIdentity)
			v.ingredientId = (await createCustomIngredient(db, user.id, v.name)).id;
	}

	let imageId: string | null | undefined = undefined;
	const file = fd.get('image');
	try {
		if (file instanceof File && file.size > 0) imageId = await storeRecipeImage(user.id, file);
		else if (input.removeImage) imageId = null;
	} catch (err) {
		if (err instanceof AppError)
			return fail(err.status, {
				input,
				errors: { image: err.message },
				message: err.message,
				conflict: false
			});
		throw err;
	}

	try {
		if (recipeId) {
			const { previousImageId } = await updateRecipe(
				user.id,
				recipeId,
				validation.value,
				input.expectedRevision,
				imageId === undefined ? {} : { set: imageId }
			);
			if (previousImageId && previousImageId !== imageId)
				await deleteImageIfUnreferenced(user.id, previousImageId).catch(() => {});
		} else {
			recipeId = await createRecipe(user.id, validation.value, imageId ?? null);
		}
	} catch (err) {
		if (imageId) await deleteImageIfUnreferenced(user.id, imageId).catch(() => {});
		if (err instanceof ReviewConflict)
			return fail(409, { input, errors: {}, message: err.message, conflict: true });
		if (err instanceof AppError)
			return fail(err.status, { input, errors: {}, message: err.message, conflict: false });
		throw err;
	}
	throw redirect(303, `/recipes/${recipeId}`);
}

export function emptyRecipeInput(): RecipeFormClientInput {
	return {
		title: '',
		description: '',
		baseServings: '',
		yieldNote: '',
		prepMinutes: '',
		cookMinutes: '',
		source: '',
		notes: '',
		tags: '',
		convention: 'metric',
		ingredients: [],
		steps: [],
		intent: 'save',
		expectedRevision: null,
		removeImage: false
	};
}
