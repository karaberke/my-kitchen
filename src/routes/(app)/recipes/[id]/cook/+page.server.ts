import { fail } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { requireHousehold } from '$lib/server/access';
import { finishCooking, previewCooking, type CookItemInput } from '$lib/server/cooking';
import { getRecipeDetail } from '$lib/server/recipes';
import { undoEvent } from '$lib/server/undo';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { parseAmount } from '$lib/shared/amount-parse';
import { Dec } from '$lib/shared/decimal';
import { isOperationId } from '$lib/server/operations';

const loadImpl = async (event: PageServerLoadEvent) => {
	const { user, household } = requireHousehold(event);
	event.depends('app:cook');
	const ctx = { userId: user.id, actorName: user.name, householdId: household.id };
	const recipe = await getRecipeDetail(db, user.id, event.params.id, household.id);
	const servingsRaw = event.url.searchParams.get('servings') ?? recipe.baseServings ?? '1';
	const parsed = parseAmount(servingsRaw);
	const servings =
		parsed.ok && parsed.value && parsed.value.isPositive()
			? parsed.value
			: Dec.from(recipe.baseServings ?? '1');
	const preview = recipe.cookable ? await previewCooking(db, ctx, recipe.id, servings) : null;
	return {
		title: `Cooking ${recipe.title}`,
		recipe,
		preview,
		operationId: randomUUID(),
		undoOperationId: randomUUID()
	};
};

export const actions: Actions = {
	finish: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		const operationId = String(fd.get('operationId') ?? '');
		if (!isOperationId(operationId))
			return fail(400, { message: 'Missing operation id; reload and try again' });
		const servingsParsed = parseAmount(String(fd.get('servings') ?? ''));
		if (!servingsParsed.ok || !servingsParsed.value?.isPositive())
			return fail(400, { message: 'Servings must be a positive number' });
		const expectedRecipeRevision = Number(fd.get('expectedRecipeRevision'));
		const batchId = String(fd.get('batchId') ?? '') || null;
		const positions = new Set<number>();
		for (const key of fd.keys()) {
			const m = /^item\.(\d+)\.mode$/.exec(key);
			if (m) positions.add(Number(m[1]));
		}
		const items: CookItemInput[] = [];
		for (const pos of [...positions].sort((a, b) => a - b)) {
			const mode = fd.get(`item.${pos}.mode`) === 'deduct' ? 'deduct' : 'skip';
			const ingredientId = String(fd.get(`item.${pos}.ingredientId`) ?? '') || null;
			const allocations: CookItemInput['allocations'] = [];
			for (let i = 0; i < 50; i++) {
				const lotId = fd.get(`item.${pos}.alloc.${i}.lotId`);
				if (!lotId) break;
				const amtParsed = parseAmount(String(fd.get(`item.${pos}.alloc.${i}.amount`) ?? ''));
				if (!amtParsed.ok)
					return fail(400, {
						message: `Check the amount for ${fd.get(`item.${pos}.name`) ?? 'an ingredient'}: ${amtParsed.error}`
					});
				if (!amtParsed.value || !amtParsed.value.isPositive()) continue;
				allocations.push({
					lotId: String(lotId),
					amount: amtParsed.value,
					expectedRevision: Number(fd.get(`item.${pos}.alloc.${i}.revision`) ?? 0)
				});
			}
			items.push({
				position: pos,
				mode: mode === 'deduct' && allocations.length ? 'deduct' : 'skip',
				ingredientId,
				allocations,
				note: String(fd.get(`item.${pos}.note`) ?? '').slice(0, 300)
			});
		}
		try {
			const out = await finishCooking(
				{ userId: user.id, actorName: user.name, householdId: household.id },
				{
					operationId,
					recipeId: event.params.id,
					expectedRecipeRevision,
					servings: servingsParsed.value,
					batchId,
					items
				}
			);
			return {
				ok: true,
				eventId: out.result.eventId,
				deductions: out.result.deductions,
				plannedServingsFulfilled: out.result.plannedServingsFulfilled,
				unplannedServings: out.result.unplannedServings,
				replayed: out.replayed
			};
		} catch (err) {
			if (err instanceof ReviewConflict)
				return fail(409, { message: err.message, review: err.review });
			if (err instanceof AppError) return fail(err.status, { message: err.message });
			throw err;
		}
	},
	undo: async (event) => {
		const { user, household } = requireHousehold(event);
		const fd = await event.request.formData();
		const operationId = String(fd.get('operationId') ?? '');
		const eventId = String(fd.get('eventId') ?? '');
		if (!isOperationId(operationId)) return fail(400, { message: 'Missing operation id' });
		try {
			await undoEvent(
				{ userId: user.id, actorName: user.name, householdId: household.id },
				{ operationId, eventId }
			);
			return { undone: true };
		} catch (err) {
			if (err instanceof ReviewConflict)
				return fail(409, { message: err.message, review: err.review });
			if (err instanceof AppError) return fail(err.status, { message: err.message });
			throw err;
		}
	}
};

export const load = guard(loadImpl);
