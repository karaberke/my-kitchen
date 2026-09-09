import { fail, redirect } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { assertMember, loadHouseholdOrThrow, requireHousehold } from '$lib/server/access';
import {
	addManualLine,
	completeList,
	deleteDraftList,
	getListDetail,
	recordPurchase,
	refreshDraft,
	removeBatch,
	removeLine,
	startShopping,
	updateBatch,
	updateLine
} from '$lib/server/grocery';
import { undoEvent } from '$lib/server/undo';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { parseAmount } from '$lib/shared/amount-parse';
import { isOperationId } from '$lib/server/operations';
import { GROCERY_CATEGORIES } from '$lib/server/ingredients';
import { isUnitId } from '$lib/shared/units';

const loadImpl = async (event: PageServerLoadEvent) => {
	const { user, household } = requireHousehold(event);
	event.depends('app:grocery');
	await assertMember(db, household.id, user.id);
	const [list, h] = await Promise.all([
		getListDetail(db, household.id, event.params.listId),
		loadHouseholdOrThrow(db, household.id)
	]);
	return {
		title: list.name,
		list,
		revisions: { pantry: h.pantryRevision, grocery: h.groceryRevision },
		operationId: randomUUID(),
		categories: GROCERY_CATEGORIES
	};
};

function ctxOf(event: RequestEvent) {
	const { user, household } = requireHousehold(event);
	return { userId: user.id, actorName: user.name, householdId: household.id };
}
function handle(err: unknown) {
	if (err instanceof ReviewConflict) return fail(409, { message: err.message, review: err.review });
	if (err instanceof AppError) return fail(err.status, { message: err.message });
	throw err;
}
const num = (v: FormDataEntryValue | null) => Number(v ?? -1);

export const actions: Actions = {
	refresh: async (event) => {
		const ctx = ctxOf(event);
		try {
			await refreshDraft(ctx, event.params.listId);
			return { ok: true, action: 'refresh' };
		} catch (err) {
			return handle(err);
		}
	},
	start: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			await startShopping(ctx, {
				listId: event.params.listId,
				expectedRevision: num(fd.get('expectedRevision'))
			});
			return { ok: true, action: 'start' };
		} catch (err) {
			return handle(err);
		}
	},
	complete: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			await completeList(ctx, {
				listId: event.params.listId,
				expectedRevision: num(fd.get('expectedRevision'))
			});
			return { ok: true, action: 'complete' };
		} catch (err) {
			return handle(err);
		}
	},
	deleteDraft: async (event) => {
		const ctx = ctxOf(event);
		try {
			await deleteDraftList(ctx, event.params.listId);
		} catch (err) {
			return handle(err);
		}
		throw redirect(303, '/grocery');
	},
	batch: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		const batchId = String(fd.get('batchId') ?? '');
		try {
			if (fd.get('remove') === '1') {
				await removeBatch(ctx, { listId: event.params.listId, batchId });
				return { ok: true, action: 'batch' };
			}
			const servings = parseAmount(String(fd.get('servings') ?? ''));
			if (!servings.ok || !servings.value)
				return fail(400, { message: 'Servings must be a positive number' });
			const includeOptional = fd
				.getAll('includeOptional')
				.map((v) => Number(v))
				.filter(Number.isInteger);
			await updateBatch(ctx, {
				listId: event.params.listId,
				batchId,
				servings: servings.value,
				includeOptional
			});
			return { ok: true, action: 'batch' };
		} catch (err) {
			return handle(err);
		}
	},
	addLine: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			const amount = parseAmount(String(fd.get('amount') ?? ''));
			if (!amount.ok) return fail(400, { message: amount.error, form: 'addLine' });
			const unit = String(fd.get('unit') ?? '') || null;
			if (unit && !isUnitId(unit)) return fail(400, { message: 'Unknown unit', form: 'addLine' });
			await addManualLine(ctx, {
				listId: event.params.listId,
				name: String(fd.get('name') ?? ''),
				ingredientId: String(fd.get('ingredientId') ?? '') || null,
				amount: amount.value,
				unit: amount.value ? unit : null,
				category: String(fd.get('category') ?? ''),
				subtractPantry: fd.get('subtractPantry') === 'on',
				note: String(fd.get('note') ?? '')
			});
			return { ok: true, action: 'addLine' };
		} catch (err) {
			return handle(err);
		}
	},
	line: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		const lineId = String(fd.get('lineId') ?? '');
		try {
			if (fd.get('remove') === '1') {
				await removeLine(ctx, { listId: event.params.listId, lineId });
				return { ok: true, action: 'line' };
			}
			const input: Parameters<typeof updateLine>[1] = {
				listId: event.params.listId,
				lineId,
				expectedRevision: num(fd.get('expectedRevision'))
			};
			if (fd.has('amount')) {
				const amount = parseAmount(String(fd.get('amount') ?? ''));
				if (!amount.ok) return fail(400, { message: amount.error });
				input.amount = amount.value;
			}
			if (fd.has('category')) input.category = String(fd.get('category'));
			if (fd.has('note')) input.note = String(fd.get('note'));
			const status = fd.get('status');
			if (status === 'pending' || status === 'handled') input.status = status;
			await updateLine(ctx, input);
			return { ok: true, action: 'line' };
		} catch (err) {
			return handle(err);
		}
	},
	purchase: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		const operationId = String(fd.get('operationId') ?? '');
		if (!isOperationId(operationId))
			return fail(400, { message: 'Missing operation id; reload and try again' });
		try {
			let bought: { quantity: import('$lib/shared/decimal').Dec; unit: string } | null = null;
			if (fd.get('handledOnly') !== '1') {
				const qty = parseAmount(String(fd.get('quantity') ?? ''));
				if (!qty.ok || !qty.value)
					return fail(400, {
						message: qty.ok ? 'Enter the amount you bought' : qty.error,
						form: 'purchase'
					});
				const unit = String(fd.get('unit') ?? '');
				if (!isUnitId(unit)) return fail(400, { message: 'Choose a unit', form: 'purchase' });
				bought = { quantity: qty.value, unit };
			}
			const out = await recordPurchase(ctx, {
				operationId,
				listId: event.params.listId,
				lineId: String(fd.get('lineId') ?? ''),
				bought,
				ingredientId: String(fd.get('ingredientId') ?? '') || null,
				newIngredientName: String(fd.get('newIngredientName') ?? '') || null,
				location: String(fd.get('location') ?? ''),
				expiresOn: String(fd.get('expiresOn') ?? '') || null,
				note: String(fd.get('note') ?? '')
			});
			return {
				ok: true,
				action: 'purchase',
				eventId: out.result.eventId,
				remaining: out.result.remaining,
				lineStatus: out.result.lineStatus,
				replayed: out.replayed
			};
		} catch (err) {
			return handle(err);
		}
	},
	undo: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		const operationId = String(fd.get('operationId') ?? '');
		if (!isOperationId(operationId)) return fail(400, { message: 'Missing operation id' });
		try {
			await undoEvent(ctx, { operationId, eventId: String(fd.get('eventId') ?? '') });
			return { ok: true, action: 'undo' };
		} catch (err) {
			return handle(err);
		}
	}
};

export const load = guard(loadImpl);
