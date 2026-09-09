import type { Actions, PageServerLoadEvent } from './$types';
import { guard } from '$lib/server/http';
import { requireUser } from '$lib/server/access';
import { emptyRecipeInput, handleRecipeSubmit } from '$lib/server/recipe-form';

const loadImpl = (event: PageServerLoadEvent) => {
	requireUser(event);
	return { title: 'New recipe', initial: emptyRecipeInput() };
};

export const actions: Actions = {
	default: async (event) => {
		requireUser(event);
		return handleRecipeSubmit(event, null);
	}
};

export const load = guard(loadImpl);
