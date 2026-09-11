import { fail } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/access';
import { linkIngredientNames, listUnlinkedIngredients } from '$lib/server/ingredient-links';
import { createCustomIngredient } from '$lib/server/ingredients';
import { asAppError } from '$lib/server/errors';

const loadImpl = async (event: PageServerLoadEvent) => {
	const user = requireUser(event);
	event.depends('app:ingredient-links');
	const groups = await listUnlinkedIngredients(db, user.id);
	return { title: 'Pantry links', groups };
};

/** Reads the rows the page posted: link.<i>.name plus the combobox fields. */
function parseRows(fd: FormData) {
	const indexes = new Set<number>();
	for (const key of fd.keys()) {
		const m = /^link\.(\d+)\./.exec(key);
		if (m) indexes.add(Number(m[1]));
	}
	return [...indexes]
		.sort((a, b) => a - b)
		.map((i) => ({
			name: String(fd.get(`link.${i}.name`) ?? '').trim(),
			ingredientId: String(fd.get(`link.${i}.match.ingredientId`) ?? '').trim(),
			createIdentity: fd.get(`link.${i}.match.createIdentity`) === '1',
			typedName: String(fd.get(`link.${i}.match.name`) ?? '').trim()
		}))
		.filter((r) => r.name);
}

export const actions: Actions = {
	link: async (event) => {
		const user = requireUser(event);
		const rows = parseRows(await event.request.formData());
		try {
			const requests: { name: string; ingredientId: string }[] = [];
			for (const row of rows) {
				let ingredientId = row.ingredientId;
				if (!ingredientId && row.createIdentity && row.typedName)
					ingredientId = (await createCustomIngredient(db, user.id, row.typedName)).id;
				if (ingredientId) requests.push({ name: row.name, ingredientId });
			}
			if (!requests.length)
				return fail(400, { message: 'Pick an ingredient for at least one row' });
			const result = await linkIngredientNames(user.id, requests);
			return { ok: true, ...result };
		} catch (err) {
			const app = asAppError(err);
			if (app) return fail(app.status, { message: app.message });
			throw err;
		}
	}
};

export const load = guard(loadImpl);
