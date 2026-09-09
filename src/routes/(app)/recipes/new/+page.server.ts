import type { Actions, PageServerLoad } from './$types';
import { requireUser } from '$lib/server/access';
import { emptyRecipeInput, handleRecipeSubmit } from '$lib/server/recipe-form';

export const load: PageServerLoad = (event) => {
	requireUser(event);
	return { title: 'New recipe', initial: emptyRecipeInput() };
};

export const actions: Actions = {
	default: async (event) => {
		requireUser(event);
		return handleRecipeSubmit(event, null);
	}
};
