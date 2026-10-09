import { fail } from '@sveltejs/kit';
import {
	actionError,
	formText,
	formTextOrNull,
	guard,
	expectedRevision,
	lotFields,
	requiredAmount
} from '$lib/server/http';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoadEvent } from './$types';
import { db } from '$lib/server/db';
import { householdActor, requireMemberHousehold, revisionsOf } from '$lib/server/access';
import {
	addStock,
	correctLot,
	getPantryOverview,
	scanNewIngredientName,
	scanOrigin,
	updateLotMetadata,
	wasteLot
} from '$lib/server/pantry';
import { identifyAs, identifyManual, SYMBOLOGIES, type Symbology } from '$lib/shared/gtin';
import { pantryAmount } from '$lib/shared/package-size';
import { operationIdFrom } from '$lib/server/operations';
import { llmEnabled } from '$lib/server/llm/client';
import { LOCATION_MAX_CHARS } from '$lib/shared/text';

export const load = guard(async (event: PageServerLoadEvent) => {
	event.depends('app:pantry');
	const { household } = await requireMemberHousehold(db, event);
	const filterRaw = event.url.searchParams.get('filter');
	const filters = {
		q: (event.url.searchParams.get('q') ?? '').trim().slice(0, 60),
		location:
			(event.url.searchParams.get('location') ?? '').trim().slice(0, LOCATION_MAX_CHARS) || null,
		filter: (filterRaw === 'use_soon' || filterRaw === 'undated' || filterRaw === 'dated'
			? filterRaw
			: 'all') as 'all' | 'use_soon' | 'undated' | 'dated'
	};
	const overview = await getPantryOverview(db, household.id, filters);
	return {
		title: 'Pantry',
		overview,
		filters,
		revisions: revisionsOf(household),
		operationId: randomUUID(),
		aiEnabled: llmEnabled()
	};
});

export const actions: Actions = {
	add: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			const qty = requiredAmount(fd, 'quantity', 'Enter the amount', 'add');
			if (!qty.ok) return qty.failure;
			const ingredientId = formTextOrNull(fd, 'ingredientId');
			const newName = formText(fd, 'name').trim();
			const create = fd.get('createIdentity') === '1' || (!ingredientId && !!newName);
			const out = await addStock(ctx, {
				operationId: operationIdFrom(fd),
				ingredientId,
				newIngredientName: !ingredientId && create ? newName : null,
				category: String(fd.get('category') ?? 'Other'),
				quantity: qty.value,
				unit: formText(fd, 'unit'),
				...lotFields(fd)
			});
			return { ok: true, action: 'add', eventId: out.result.eventId, replayed: out.replayed };
		} catch (err) {
			return actionError(err);
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
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			const code = formText(fd, 'code').slice(0, 40);
			const rawSymbology = formText(fd, 'symbology');
			const symbology = SYMBOLOGIES.includes(rawSymbology as Symbology)
				? (rawSymbology as Symbology)
				: null;
			const identified = symbology ? identifyAs(code, symbology) : identifyManual(code);
			if (!identified.ok) return fail(400, { message: identified.message, form: 'scan' });

			const per = requiredAmount(fd, 'packageQuantity', 'Enter what one package holds', 'scan');
			if (!per.ok) return per.failure;
			const unit = formText(fd, 'unit');
			const packageCount = Number(fd.get('packageCount') ?? '1');
			const total = pantryAmount({ amount: per.value, unit }, packageCount);
			if (!total.ok) return fail(400, { message: total.error, form: 'scan' });

			const ingredientId = formTextOrNull(fd, 'ingredientId');
			const newName = formText(fd, 'name').trim();

			const out = await addStock(ctx, {
				operationId: operationIdFrom(fd),
				ingredientId,
				newIngredientName: scanNewIngredientName({
					ingredientId,
					name: newName,
					providerTitle: formText(fd, 'providerTitle'),
					createIdentity: fd.get('createIdentity') === '1'
				}),
				category: String(fd.get('category') ?? 'Other'),
				quantity: total.quantity,
				unit: total.unit,
				...lotFields(fd),
				barcode: {
					gtin: identified.identity.gtin,
					displayName: formText(fd, 'displayName') || newName,
					brand: formText(fd, 'brand'),
					packageQuantity: per.value,
					packageUnit: unit,
					packageCount,
					packageLabelText: formText(fd, 'labelText'),
					origin: scanOrigin(formText(fd, 'origin'))
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
			return actionError(err);
		}
	},
	correct: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			const qty = requiredAmount(fd, 'checkedQuantity', 'Enter the counted amount', 'correct');
			if (!qty.ok) return qty.failure;
			const out = await correctLot(ctx, {
				operationId: operationIdFrom(fd),
				lotId: formText(fd, 'lotId'),
				checkedQuantity: qty.value,
				expectedRevision: expectedRevision(fd),
				note: formText(fd, 'note')
			});
			return {
				ok: true,
				action: 'correct',
				eventId: out.result.eventId,
				noChange: out.result.noChange
			};
		} catch (err) {
			return actionError(err);
		}
	},
	waste: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			const qty = requiredAmount(fd, 'quantity', 'Enter the amount', 'waste');
			if (!qty.ok) return qty.failure;
			const out = await wasteLot(ctx, {
				operationId: operationIdFrom(fd),
				lotId: formText(fd, 'lotId'),
				quantity: qty.value,
				reason: formText(fd, 'reason')
			});
			return { ok: true, action: 'waste', eventId: out.result.eventId };
		} catch (err) {
			return actionError(err);
		}
	},
	metadata: async (event) => {
		const ctx = householdActor(event);
		const fd = await event.request.formData();
		try {
			await updateLotMetadata(ctx, {
				lotId: formText(fd, 'lotId'),
				expectedRevision: expectedRevision(fd),
				...lotFields(fd)
			});
			return { ok: true, action: 'metadata' };
		} catch (err) {
			return actionError(err);
		}
	}
};
