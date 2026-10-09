import { fail, redirect } from '@sveltejs/kit';
import {
	actionError,
	expectedRevision,
	formText,
	formTextOrNull,
	guard,
	lotFields,
	requiredAmount
} from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { householdActor, requireMemberHousehold, revisionsOf } from '$lib/server/access';
import {
	addManualLine,
	applyTidyChanges,
	completeList,
	deleteDraftList,
	getListDetail,
	recordPurchase,
	refreshDraft,
	reopenList,
	removeBatch,
	removeLine,
	startShopping,
	updateBatch,
	updateLine,
	type UpdateLineInput
} from '$lib/server/grocery';
import { llmEnabled } from '$lib/server/llm/client';
import { GROCERY_TIDY_MAX_LINES } from '$lib/server/llm/grocery';
import { match as isUuid } from '../../../../params/uuid';
import { parseAmount, parsePositiveAmount } from '$lib/shared/amount-parse';
import { operationIdFrom } from '$lib/server/operations';
import { isGroceryCategory } from '$lib/shared/grocery-categories';
import { isUnitId } from '$lib/shared/units';

export const load = guard(async (event: PageServerLoadEvent) => {
	event.depends('app:grocery');
	const { household } = await requireMemberHousehold(db, event);
	const list = await getListDetail(db, household.id, event.params.listId, household.pantryRevision);
	return {
		title: list.name,
		list,
		revisions: revisionsOf(household),
		operationId: randomUUID(),
		aiEnabled: llmEnabled()
	};
});

/**
 * The changes `applyTidy` posts, one group per line: `change.<i>.lineId` and
 * `change.<i>.expectedRevision`, then only the fields to change:
 * `change.<i>.name`, `change.<i>.amount` with `change.<i>.unit` (blank clears
 * it), `change.<i>.category`, `change.<i>.ingredientId` (blank unlinks).
 */
function parseTidyChanges(
	listId: string,
	fd: FormData
): { ok: true; changes: UpdateLineInput[] } | { ok: false; message: string } {
	const indexes = new Set<number>();
	for (const key of fd.keys()) {
		const m = /^change\.(\d+)\./.exec(key);
		if (m) indexes.add(Number(m[1]));
	}
	if (!indexes.size) return { ok: false, message: 'Choose at least one change' };
	if (indexes.size > GROCERY_TIDY_MAX_LINES) return { ok: false, message: 'Too many changes' };
	const changes: UpdateLineInput[] = [];
	for (const i of [...indexes].sort((a, b) => a - b)) {
		const field = (name: string) => {
			const v = fd.get(`change.${i}.${name}`);
			return v === null ? undefined : String(v);
		};
		const lineId = field('lineId') ?? '';
		const expectedRevision = Number(field('expectedRevision'));
		if (!isUuid(lineId) || !Number.isInteger(expectedRevision))
			return { ok: false, message: 'The changes could not be read' };
		const change: UpdateLineInput = { listId, lineId, expectedRevision };
		const name = field('name');
		if (name !== undefined) change.name = name;
		const amountRaw = field('amount');
		if (amountRaw !== undefined) {
			const amount = parseAmount(amountRaw);
			if (!amount.ok) return { ok: false, message: amount.error };
			change.amount = amount.value;
			change.unit = field('unit') || null;
		}
		const category = field('category');
		if (category !== undefined) {
			if (!isGroceryCategory(category)) return { ok: false, message: 'Unknown aisle' };
			change.category = category;
		}
		const ingredientId = field('ingredientId');
		if (ingredientId !== undefined) {
			if (ingredientId && !isUuid(ingredientId))
				return { ok: false, message: 'The changes could not be read' };
			change.ingredientId = ingredientId || null;
		}
		changes.push(change);
	}
	return { ok: true, changes };
}

export const actions: Actions = {
	refresh: async (event) => {
		const ctx = householdActor(event);
		try {
			await refreshDraft(ctx, event.params.listId);
			return { ok: true, action: 'refresh' };
		} catch (err) {
			return actionError(err);
		}
	},
	start: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			await startShopping(ctx, {
				listId: event.params.listId,
				expectedRevision: expectedRevision(fd)
			});
			return { ok: true, action: 'start' };
		} catch (err) {
			return actionError(err);
		}
	},
	complete: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			await completeList(ctx, {
				listId: event.params.listId,
				expectedRevision: expectedRevision(fd)
			});
			return { ok: true, action: 'complete' };
		} catch (err) {
			return actionError(err);
		}
	},
	reopen: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			await reopenList(ctx, {
				listId: event.params.listId,
				expectedRevision: expectedRevision(fd)
			});
			return { ok: true, action: 'reopen' };
		} catch (err) {
			return actionError(err);
		}
	},
	deleteDraft: async (event) => {
		const ctx = householdActor(event);
		try {
			await deleteDraftList(ctx, event.params.listId);
		} catch (err) {
			return actionError(err);
		}
		throw redirect(303, '/grocery');
	},
	batch: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		const batchId = formText(fd, 'batchId');
		try {
			if (fd.get('remove') === '1') {
				await removeBatch(ctx, { listId: event.params.listId, batchId });
				return { ok: true, action: 'batch' };
			}
			const servings = parsePositiveAmount(formText(fd, 'servings'));
			if (!servings) return fail(400, { message: 'Servings must be a positive number' });
			const includeOptional = fd
				.getAll('includeOptional')
				.map((v) => Number(v))
				.filter(Number.isInteger);
			await updateBatch(ctx, {
				listId: event.params.listId,
				batchId,
				servings,
				includeOptional
			});
			return { ok: true, action: 'batch' };
		} catch (err) {
			return actionError(err);
		}
	},
	addLine: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			const amount = parseAmount(formText(fd, 'amount'));
			if (!amount.ok) return fail(400, { message: amount.error, form: 'addLine' });
			const unit = formTextOrNull(fd, 'unit');
			if (unit && !isUnitId(unit)) return fail(400, { message: 'Unknown unit', form: 'addLine' });
			await addManualLine(ctx, {
				listId: event.params.listId,
				name: formText(fd, 'name'),
				readTypedName: true,
				ingredientId: formTextOrNull(fd, 'ingredientId'),
				amount: amount.value,
				unit,
				category: formText(fd, 'category'),
				subtractPantry: fd.get('subtractPantry') === 'on',
				note: formText(fd, 'note')
			});
			return { ok: true, action: 'addLine' };
		} catch (err) {
			return actionError(err, 'addLine');
		}
	},
	line: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		const lineId = formText(fd, 'lineId');
		try {
			if (fd.get('remove') === '1') {
				await removeLine(ctx, { listId: event.params.listId, lineId });
				return { ok: true, action: 'line' };
			}
			const input: Parameters<typeof updateLine>[1] = {
				listId: event.params.listId,
				lineId,
				expectedRevision: expectedRevision(fd)
			};
			if (fd.has('amount')) {
				const amount = parseAmount(formText(fd, 'amount'));
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
			return actionError(err);
		}
	},
	/** Save the tidy proposals the user kept; see `parseTidyChanges` for the fields. */
	applyTidy: async (event) => {
		const ctx = householdActor(event);
		const parsed = parseTidyChanges(event.params.listId, await event.request.formData());
		if (!parsed.ok) return fail(400, { message: parsed.message, form: 'applyTidy' });
		let applied: number;
		let conflicts: string[];
		try {
			({ applied, conflicts } = await applyTidyChanges(ctx, event.params.listId, parsed.changes));
		} catch (err) {
			return actionError(err, 'applyTidy');
		}
		if (conflicts.length)
			return fail(409, {
				message: 'Some items changed since the assistant read them. Check them and try again.',
				form: 'applyTidy',
				applied,
				conflicts
			});
		return { ok: true, action: 'applyTidy', applied };
	},
	purchase: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			const operationId = operationIdFrom(fd);
			let bought: { quantity: import('$lib/shared/decimal').Dec; unit: string } | null = null;
			if (fd.get('handledOnly') !== '1') {
				const qty = requiredAmount(fd, 'quantity', 'Enter the amount you bought', 'purchase');
				if (!qty.ok) return qty.failure;
				const unit = formText(fd, 'unit');
				if (!isUnitId(unit)) return fail(400, { message: 'Choose a unit', form: 'purchase' });
				bought = { quantity: qty.value, unit };
			}
			const out = await recordPurchase(ctx, {
				operationId,
				listId: event.params.listId,
				lineId: formText(fd, 'lineId'),
				bought,
				ingredientId: formTextOrNull(fd, 'ingredientId'),
				newIngredientName: formTextOrNull(fd, 'newIngredientName'),
				...lotFields(fd)
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
			return actionError(err, 'purchase');
		}
	}
};
