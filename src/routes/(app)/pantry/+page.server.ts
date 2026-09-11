import { fail } from '@sveltejs/kit';
import { guard } from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { assertMember, loadHouseholdOrThrow, requireHousehold } from '$lib/server/access';
import {
	addStock,
	correctLot,
	getPantryOverview,
	updateLotMetadata,
	wasteLot
} from '$lib/server/pantry';
import { undoEvent } from '$lib/server/undo';
import { AppError, ReviewConflict, asAppError } from '$lib/server/errors';
import { parseAmount } from '$lib/shared/amount-parse';
import { identifyAs, identifyManual, SYMBOLOGIES, type Symbology } from '$lib/shared/gtin';
import { pantryAmount } from '$lib/shared/package-size';
import type { LinkOrigin } from '$lib/server/db/schema';
import { isOperationId } from '$lib/server/operations';
import { GROCERY_CATEGORIES } from '$lib/server/ingredients';

const loadImpl = async (event: PageServerLoadEvent) => {
	const { user, household } = requireHousehold(event);
	event.depends('app:pantry');
	await assertMember(db, household.id, user.id);
	const filterRaw = event.url.searchParams.get('filter');
	const filters = {
		q: (event.url.searchParams.get('q') ?? '').trim().slice(0, 60),
		location: (event.url.searchParams.get('location') ?? '').trim().slice(0, 60) || null,
		filter: (filterRaw === 'use_soon' || filterRaw === 'undated' || filterRaw === 'dated'
			? filterRaw
			: 'all') as 'all' | 'use_soon' | 'undated' | 'dated'
	};
	const [overview, h] = await Promise.all([
		getPantryOverview(db, household.id, filters),
		loadHouseholdOrThrow(db, household.id)
	]);
	return {
		title: 'Pantry',
		overview,
		filters,
		revisions: { pantry: h.pantryRevision, grocery: h.groceryRevision, plan: h.planRevision },
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
	const app = asAppError(err);
	if (app) return fail(app.status, { message: app.message });
	throw err;
}
function opIdOf(fd: FormData) {
	const id = String(fd.get('operationId') ?? '');
	if (!isOperationId(id)) throw new AppError(400, 'Missing operation id; reload and try again');
	return id;
}

export const actions: Actions = {
	add: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			const qty = parseAmount(String(fd.get('quantity') ?? ''));
			if (!qty.ok || !qty.value)
				return fail(400, { message: qty.ok ? 'Enter the amount' : qty.error, form: 'add' });
			const ingredientId = String(fd.get('ingredientId') ?? '') || null;
			const newName = String(fd.get('name') ?? '').trim();
			const create = fd.get('createIdentity') === '1' || (!ingredientId && !!newName);
			const out = await addStock(ctx, {
				operationId: opIdOf(fd),
				ingredientId,
				newIngredientName: !ingredientId && create ? newName : null,
				category: String(fd.get('category') ?? 'Other'),
				quantity: qty.value,
				unit: String(fd.get('unit') ?? ''),
				location: String(fd.get('location') ?? ''),
				expiresOn: String(fd.get('expiresOn') ?? '') || null,
				note: String(fd.get('note') ?? '')
			});
			return { ok: true, action: 'add', eventId: out.result.eventId, replayed: out.replayed };
		} catch (err) {
			return handle(err);
		}
	},
	/**
	 * Add a scanned product.
	 *
	 * The same authorised write as `add`, with two differences: the quantity is
	 * worked out here from what one package holds and how many were bought, and
	 * the household's link for the barcode is written in the same transaction.
	 * The barcode is validated again on this side, whatever the phone decoded.
	 */
	scanAdd: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			const code = String(fd.get('code') ?? '').slice(0, 40);
			const rawSymbology = String(fd.get('symbology') ?? '');
			const symbology = SYMBOLOGIES.includes(rawSymbology as Symbology)
				? (rawSymbology as Symbology)
				: null;
			const identified = symbology ? identifyAs(code, symbology) : identifyManual(code);
			if (!identified.ok) return fail(400, { message: identified.message, form: 'scan' });

			const per = parseAmount(String(fd.get('packageQuantity') ?? ''));
			if (!per.ok || !per.value)
				return fail(400, {
					message: per.ok ? 'Enter what one package holds' : per.error,
					form: 'scan'
				});
			const unit = String(fd.get('unit') ?? '');
			const packageCount = Number(fd.get('packageCount') ?? '1');
			const total = pantryAmount({ amount: per.value, unit }, packageCount);
			if (!total.ok) return fail(400, { message: total.error, form: 'scan' });

			const ingredientId = String(fd.get('ingredientId') ?? '') || null;
			const newName = String(fd.get('name') ?? '').trim();
			const rawOrigin = String(fd.get('origin') ?? 'manual');
			const origin: LinkOrigin = ['usda', 'off'].includes(rawOrigin)
				? (rawOrigin as LinkOrigin)
				: 'manual';

			const out = await addStock(ctx, {
				operationId: opIdOf(fd),
				ingredientId,
				newIngredientName: ingredientId ? null : newName,
				category: String(fd.get('category') ?? 'Other'),
				quantity: total.quantity,
				unit: total.unit,
				location: String(fd.get('location') ?? ''),
				expiresOn: String(fd.get('expiresOn') ?? '') || null,
				note: String(fd.get('note') ?? ''),
				barcode: {
					gtin: identified.identity.gtin,
					displayName: String(fd.get('displayName') ?? '') || newName,
					brand: String(fd.get('brand') ?? ''),
					packageQuantity: per.value,
					packageUnit: unit,
					packageCount,
					packageLabelText: String(fd.get('labelText') ?? ''),
					origin
				}
			});
			return {
				ok: true,
				action: 'scanAdd',
				eventId: out.result.eventId,
				replayed: out.replayed,
				gtin: identified.identity.gtin
			};
		} catch (err) {
			return handle(err);
		}
	},
	correct: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			const qty = parseAmount(String(fd.get('checkedQuantity') ?? ''));
			if (!qty.ok || !qty.value)
				return fail(400, {
					message: qty.ok ? 'Enter the counted amount' : qty.error,
					form: 'correct'
				});
			const out = await correctLot(ctx, {
				operationId: opIdOf(fd),
				lotId: String(fd.get('lotId') ?? ''),
				checkedQuantity: qty.value,
				expectedRevision: Number(fd.get('expectedRevision') ?? -1),
				note: String(fd.get('note') ?? '')
			});
			return {
				ok: true,
				action: 'correct',
				eventId: out.result.eventId,
				noChange: out.result.noChange
			};
		} catch (err) {
			return handle(err);
		}
	},
	waste: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			const qty = parseAmount(String(fd.get('quantity') ?? ''));
			if (!qty.ok || !qty.value)
				return fail(400, { message: qty.ok ? 'Enter the amount' : qty.error, form: 'waste' });
			const out = await wasteLot(ctx, {
				operationId: opIdOf(fd),
				lotId: String(fd.get('lotId') ?? ''),
				quantity: qty.value,
				reason: String(fd.get('reason') ?? '')
			});
			return { ok: true, action: 'waste', eventId: out.result.eventId };
		} catch (err) {
			return handle(err);
		}
	},
	metadata: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			await updateLotMetadata(ctx, {
				lotId: String(fd.get('lotId') ?? ''),
				expectedRevision: Number(fd.get('expectedRevision') ?? -1),
				location: String(fd.get('location') ?? ''),
				expiresOn: String(fd.get('expiresOn') ?? '') || null,
				note: String(fd.get('note') ?? '')
			});
			return { ok: true, action: 'metadata' };
		} catch (err) {
			return handle(err);
		}
	},
	undo: async (event) => {
		const ctx = ctxOf(event);
		const fd = await event.request.formData();
		try {
			await undoEvent(ctx, { operationId: opIdOf(fd), eventId: String(fd.get('eventId') ?? '') });
			return { ok: true, action: 'undo' };
		} catch (err) {
			return handle(err);
		}
	}
};

export const load = guard(loadImpl);
