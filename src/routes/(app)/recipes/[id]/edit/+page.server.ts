import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { getRecipeDetail } from '$lib/server/recipes';
import { handleRecipeSubmit, type RecipeFormClientInput } from '$lib/server/recipe-form';
import { getIngredientMeta } from '$lib/server/ingredients';
import { error } from '@sveltejs/kit';
import { Dec } from '$lib/shared/decimal';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const recipe = await getRecipeDetail(db, user.id, event.params.id, null);
	if (!recipe.isOwner)
		throw error(403, 'Only the recipe owner can edit it. Duplicate it to make your own copy.');
	const meta = await getIngredientMeta(
		db,
		recipe.ingredients.map((i) => i.ingredientId).filter((x): x is string => !!x)
	);
	const initial: RecipeFormClientInput = {
		title: recipe.title,
		description: recipe.description,
		baseServings: recipe.baseServings ? Dec.from(recipe.baseServings).toHuman() : '',
		yieldNote: recipe.yieldNote,
		prepMinutes: recipe.prepMinutes?.toString() ?? '',
		cookMinutes: recipe.cookMinutes?.toString() ?? '',
		source: recipe.source,
		notes: recipe.notes,
		tags: recipe.tags.join(', '),
		convention: recipe.convention,
		ingredients: recipe.ingredients.map((i) => ({
			name: i.name,
			ingredientId: i.ingredientId,
			amount: i.amount ? Dec.from(i.amount).toString() : '',
			unit: i.unit ?? '',
			preparation: i.preparation,
			group: i.groupName,
			optional: i.optional,
			createIdentity: false
		})),
		steps: recipe.steps.map((s) => ({ section: s.sectionTitle, text: s.text })),
		intent: 'save',
		expectedRevision: recipe.revision,
		removeImage: false
	};
	return {
		title: `Edit ${recipe.title}`,
		recipeId: recipe.id,
		revision: recipe.revision,
		image: recipe.image ? { id: recipe.image.id, version: recipe.image.version } : null,
		initial,
		identityLabels: Object.fromEntries([...meta].map(([id, m]) => [id, m.name]))
	};
};

export const actions: Actions = {
	default: async (event) => {
		requireUser(event);
		return handleRecipeSubmit(event, event.params.id);
	}
};
