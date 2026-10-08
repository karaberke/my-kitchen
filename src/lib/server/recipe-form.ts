import { fail, redirect } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { createCustomIngredient } from '$lib/server/ingredients';
import {
	deleteImageIfUnreferenced,
	storeRecipeImage,
	storeRecipeImageFromUrl
} from '$lib/server/media/images';
import { IMPORT_LIMITS, consume } from '$lib/server/ratelimit';
import { createRecipe, updateRecipe } from '$lib/server/recipes';
import {
	parseRecipeForm,
	validateRecipe,
	type FieldErrors,
	type RecipeFormInput
} from '$lib/shared/recipe-input';

export type RecipeFormClientInput = RecipeFormInput;

/** Why a recipe was not saved: the `fail()` status and payload the form shows. */
export interface RecipeSaveFailure {
	ok: false;
	status: number;
	data: { input: RecipeFormInput; errors: FieldErrors; message: string; conflict: boolean };
}

/**
 * Validate and save one recipe for `userId`: a new one when `recipeId` is null.
 * `image` is a chosen file; without one, `input.imageUrl` is downloaded. Needs
 * no request, so a background job saves through it too.
 */
export async function saveRecipeInput(
	userId: string,
	input: RecipeFormInput,
	recipeId: string | null,
	image: File | null
): Promise<{ ok: true; recipeId: string } | RecipeSaveFailure> {
	const failure = (status: number, errors: FieldErrors, message: string, conflict = false) =>
		({ ok: false, status, data: { input, errors, message, conflict } }) as const;
	const validation = validateRecipe(input);
	if (!validation.ok) return failure(400, validation.errors, 'Please fix the highlighted fields.');

	// Confirmed "new ingredient" rows get a private identity owned by the user.
	for (const v of validation.value.ingredients) {
		if (!v.ingredientId && v.createIdentity)
			v.ingredientId = (await createCustomIngredient(db, userId, v.name)).id;
	}

	let imageId: string | null | undefined = undefined;
	try {
		// A chosen file beats a pasted link: the file is the more deliberate act.
		if (image && image.size > 0) imageId = await storeRecipeImage(userId, image);
		else if (input.imageUrl) {
			// The fetch reaches any address this host can route to, by decision. The
			// bucket is the only thing bounding that, so it is checked before the request.
			const limit = consume(`image-url:${userId}`, IMPORT_LIMITS.image);
			if (!limit.allowed)
				throw new AppError(
					429,
					`Too many pictures from links. Try again in ${limit.retryAfterSeconds} seconds.`
				);
			imageId = await storeRecipeImageFromUrl(userId, input.imageUrl);
		} else if (input.removeImage) imageId = null;
	} catch (err) {
		if (err instanceof AppError) return failure(err.status, { image: err.message }, err.message);
		throw err;
	}

	try {
		if (recipeId) {
			const { previousImageId } = await updateRecipe(
				userId,
				recipeId,
				validation.value,
				input.expectedRevision,
				imageId === undefined ? {} : { set: imageId }
			);
			if (previousImageId && previousImageId !== imageId)
				await deleteImageIfUnreferenced(userId, previousImageId).catch(() => {});
		} else {
			recipeId = await createRecipe(userId, validation.value, imageId ?? null);
		}
	} catch (err) {
		if (imageId) await deleteImageIfUnreferenced(userId, imageId).catch(() => {});
		if (err instanceof ReviewConflict) return failure(409, {}, err.message, true);
		if (err instanceof AppError) return failure(err.status, {}, err.message);
		throw err;
	}
	return { ok: true, recipeId };
}

/** Shared action for the new/edit pages. Preserves all input on validation errors. */
export async function handleRecipeSubmit(event: RequestEvent, recipeId: string | null) {
	const user = event.locals.user!;
	const fd = await event.request.formData();
	const file = fd.get('image');
	const saved = await saveRecipeInput(
		user.id,
		parseRecipeForm(fd),
		recipeId,
		file instanceof File ? file : null
	);
	if (!saved.ok) return fail(saved.status, saved.data);
	throw redirect(303, `/recipes/${saved.recipeId}`);
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
		removeImage: false,
		imageUrl: ''
	};
}
