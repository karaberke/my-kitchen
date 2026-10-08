import { fail } from '@sveltejs/kit';
import { actionError, guard } from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { householdActor } from '$lib/server/access';
import { finishCooking, previewCooking, type CookItemInput } from '$lib/server/cooking';
import { getRecipeDetail } from '$lib/server/recipes';
import { undoEvent } from '$lib/server/undo';
import { parseAmount, parsePositiveAmount } from '$lib/shared/amount-parse';
import { Dec } from '$lib/shared/decimal';
import { operationIdFrom } from '$lib/server/operations';
import { llmEnabled } from '$lib/server/llm/client';
import { NOTE_MAX_CHARS } from '$lib/shared/text';

const loadImpl = async (event: PageServerLoadEvent) => {
	const ctx = householdActor(event);
	event.depends('app:cook');
	const recipe = await getRecipeDetail(db, ctx.userId, event.params.id, ctx.householdId);
	const servingsRaw = event.url.searchParams.get('servings') ?? recipe.baseServings ?? '1';
	const servings = parsePositiveAmount(servingsRaw) ?? Dec.from(recipe.baseServings ?? '1');
	const preview = recipe.cookable ? await previewCooking(db, ctx, recipe.id, servings) : null;
	return {
		title: `Cooking ${recipe.title}`,
		recipe,
		preview,
		operationId: randomUUID(),
		undoOperationId: randomUUID(),
		aiEnabled: llmEnabled()
	};
};

export const actions: Actions = {
	finish: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			const operationId = operationIdFrom(fd);
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
					note: String(fd.get(`item.${pos}.note`) ?? '').slice(0, NOTE_MAX_CHARS)
				});
			}
			const out = await finishCooking(ctx, {
				operationId,
				recipeId: event.params.id,
				expectedRecipeRevision,
				servings: servingsParsed.value,
				batchId,
				items
			});
			return {
				ok: true,
				eventId: out.result.eventId,
				deductions: out.result.deductions,
				plannedServingsFulfilled: out.result.plannedServingsFulfilled,
				unplannedServings: out.result.unplannedServings,
				replayed: out.replayed
			};
		} catch (err) {
			return actionError(err);
		}
	},
	undo: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			const operationId = operationIdFrom(fd);
			const eventId = String(fd.get('eventId') ?? '');
			await undoEvent(ctx, { operationId, eventId });
			return { undone: true };
		} catch (err) {
			return actionError(err);
		}
	}
};

export const load = guard(loadImpl);
