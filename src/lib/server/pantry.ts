import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '$lib/server/db';
import {
	ingredients,
	inventoryEvents,
	inventoryMovements,
	stockLots,
	groceryLines
} from '$lib/server/db/schema';
import { assertMember } from '$lib/server/access';
import { AppError, ReviewConflict } from '$lib/server/errors';
import { assertIngredientsVisible, createCustomIngredient } from '$lib/server/ingredients';
import {
	applyMovement,
	createLot,
	insertEvent,
	lockHousehold,
	lockLots
} from '$lib/server/inventory';
import { runOperation } from '$lib/server/operations';
import { Dec } from '$lib/shared/decimal';
import { convertAmount, isUnitId, unitInfo, unitsCompatible } from '$lib/shared/units';

export interface ActorContext {
	userId: string;
	actorName: string;
	householdId: string;
}

export interface PantryFilters {
	q: string;
	location: string | null;
	filter: 'all' | 'use_soon' | 'undated' | 'dated';
}

export interface PantryLotView {
	id: string;
	quantity: string;
	unit: string;
	location: string;
	expiresOn: string | null;
	note: string;
	revision: number;
	createdAt: string;
	useSoon: boolean;
	expired: boolean;
}

export interface PantryGroup {
	ingredientId: string;
	name: string;
	category: string;
	gramsPerMl: string | null;
	totals: { quantity: string; unit: string }[];
	lots: PantryLotView[];
	useSoon: boolean;
	expired: boolean;
	earliestExpiry: string | null;
}

export const USE_SOON_DAYS = 7;

function addDays(iso: string, days: number): string {
	const d = new Date(iso + 'T00:00:00Z');
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

export async function getPantryOverview(
	dbx: DbOrTx,
	householdId: string,
	filters: PantryFilters,
	today = todayIso()
) {
	const soonCutoff = addDays(today, USE_SOON_DAYS);
	const conds = [eq(stockLots.householdId, householdId), gt(stockLots.quantity, '0')];
	if (filters.q)
		conds.push(
			sql`${ingredients.nameNormalized} like ${filters.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`) + '%'}`
		);
	if (filters.location) conds.push(eq(stockLots.location, filters.location));
	if (filters.filter === 'use_soon') conds.push(sql`${stockLots.expiresOn} <= ${soonCutoff}`);
	if (filters.filter === 'undated') conds.push(sql`${stockLots.expiresOn} is null`);
	if (filters.filter === 'dated') conds.push(sql`${stockLots.expiresOn} is not null`);

	const [rows, locRows, [{ activeCount }]] = await Promise.all([
		dbx
			.select({
				id: stockLots.id,
				ingredientId: stockLots.ingredientId,
				name: ingredients.name,
				category: ingredients.category,
				gramsPerMl: ingredients.gramsPerMl,
				quantity: stockLots.quantity,
				unit: stockLots.unit,
				location: stockLots.location,
				expiresOn: stockLots.expiresOn,
				note: stockLots.note,
				revision: stockLots.revision,
				createdAt: stockLots.createdAt
			})
			.from(stockLots)
			.innerJoin(ingredients, eq(ingredients.id, stockLots.ingredientId))
			.where(and(...conds))
			.orderBy(
				asc(ingredients.nameNormalized),
				sql`${stockLots.expiresOn} asc nulls last`,
				asc(stockLots.createdAt),
				asc(stockLots.id)
			)
			.limit(5000),
		dbx
			.selectDistinct({ location: stockLots.location })
			.from(stockLots)
			.where(
				and(
					eq(stockLots.householdId, householdId),
					gt(stockLots.quantity, '0'),
					sql`${stockLots.location} <> ''`
				)
			)
			.orderBy(asc(stockLots.location))
			.limit(50),
		dbx
			.select({ activeCount: sql<number>`count(*)::int` })
			.from(stockLots)
			.where(and(eq(stockLots.householdId, householdId), gt(stockLots.quantity, '0')))
	]);

	const groups = new Map<string, PantryGroup>();
	for (const r of rows) {
		const g =
			groups.get(r.ingredientId) ??
			(() => {
				const created: PantryGroup = {
					ingredientId: r.ingredientId,
					name: r.name,
					category: r.category,
					gramsPerMl: r.gramsPerMl,
					totals: [],
					lots: [],
					useSoon: false,
					expired: false,
					earliestExpiry: null
				};
				groups.set(r.ingredientId, created);
				return created;
			})();
		const expired = !!r.expiresOn && r.expiresOn < today;
		const useSoon = !!r.expiresOn && r.expiresOn <= soonCutoff;
		g.lots.push({
			id: r.id,
			quantity: Dec.from(r.quantity).toString(),
			unit: r.unit,
			location: r.location,
			expiresOn: r.expiresOn,
			note: r.note,
			revision: r.revision,
			createdAt: r.createdAt,
			useSoon,
			expired
		});
		g.useSoon ||= useSoon;
		g.expired ||= expired;
		if (r.expiresOn && (!g.earliestExpiry || r.expiresOn < g.earliestExpiry))
			g.earliestExpiry = r.expiresOn;
		const q = Dec.from(r.quantity);
		const existing = g.totals.find((t) => unitsCompatible(t.unit, r.unit));
		if (existing) {
			const conv = convertAmount(q, r.unit, existing.unit, 'metric');
			existing.quantity = Dec.from(existing.quantity)
				.add(conv ?? Dec.zero)
				.toString();
		} else {
			g.totals.push({ quantity: q.toString(), unit: r.unit });
		}
	}
	return {
		groups: [...groups.values()],
		locations: locRows.map((l) => l.location),
		activeCount,
		today,
		useSoonDays: USE_SOON_DAYS
	};
}

export async function getLot(dbx: DbOrTx, householdId: string, lotId: string) {
	const [row] = await dbx
		.select({
			id: stockLots.id,
			ingredientId: stockLots.ingredientId,
			name: ingredients.name,
			quantity: stockLots.quantity,
			unit: stockLots.unit,
			location: stockLots.location,
			expiresOn: stockLots.expiresOn,
			note: stockLots.note,
			revision: stockLots.revision
		})
		.from(stockLots)
		.innerJoin(ingredients, eq(ingredients.id, stockLots.ingredientId))
		.where(and(eq(stockLots.id, lotId), eq(stockLots.householdId, householdId)))
		.limit(1);
	if (!row) throw new AppError(404, 'Pantry lot not found');
	return { ...row, quantity: Dec.from(row.quantity).toString() };
}

function validateDate(raw: string | null | undefined): string | null {
	if (!raw) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new AppError(400, 'Use a calendar date (YYYY-MM-DD)');
	const d = new Date(raw + 'T00:00:00Z');
	if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw)
		throw new AppError(400, 'That date does not exist');
	return raw;
}

function validateUnit(unit: string): string {
	if (!isUnitId(unit)) throw new AppError(400, 'Unknown unit');
	return unit;
}

export interface AddStockInput {
	operationId: string;
	ingredientId: string | null;
	newIngredientName: string | null;
	category?: string;
	quantity: Dec;
	unit: string;
	location: string;
	expiresOn: string | null;
	note: string;
}

export async function addStock(ctx: ActorContext, input: AddStockInput) {
	if (!input.quantity.isPositive()) throw new AppError(400, 'Enter the amount you are adding');
	const unit = validateUnit(input.unit);
	const expiresOn = validateDate(input.expiresOn);
	const payload = { ...input, quantity: input.quantity.toString(), householdId: ctx.householdId };
	return runOperation(
		{ operationId: input.operationId, userId: ctx.userId, kind: 'add_stock', payload },
		async (tx) => {
			await assertMember(tx, ctx.householdId, ctx.userId);
			let ingredientId = input.ingredientId;
			if (!ingredientId) {
				if (!input.newIngredientName)
					throw new AppError(400, 'Choose an ingredient or name a new one');
				ingredientId = (
					await createCustomIngredient(tx, ctx.userId, input.newIngredientName, input.category)
				).id;
			} else {
				await assertIngredientsVisible(tx, ctx.userId, [ingredientId]);
			}
			const [{ name }] = await tx
				.select({ name: ingredients.name })
				.from(ingredients)
				.where(eq(ingredients.id, ingredientId));
			await lockHousehold(tx, ctx.householdId, { pantry: true });
			const eventId = await insertEvent(tx, {
				householdId: ctx.householdId,
				kind: 'add_stock',
				actorUserId: ctx.userId,
				actorName: ctx.actorName,
				operationId: input.operationId,
				summary: `Added ${input.quantity.toHuman()} ${unitInfo(unit)?.plural ?? unit} of ${name}`,
				details: {
					ingredientId,
					name,
					quantity: input.quantity.toString(),
					unit,
					location: input.location,
					expiresOn
				}
			});
			const lotId = await createLot(tx, {
				eventId,
				householdId: ctx.householdId,
				ingredientId,
				quantity: input.quantity,
				unit,
				location: input.location.trim().slice(0, 60),
				expiresOn,
				note: input.note.trim().slice(0, 300)
			});
			return { eventId, lotId, ingredientId };
		}
	);
}

export async function updateLotMetadata(
	ctx: ActorContext,
	input: {
		lotId: string;
		expectedRevision: number;
		location: string;
		expiresOn: string | null;
		note: string;
	}
) {
	const expiresOn = validateDate(input.expiresOn);
	return db.transaction(async (tx) => {
		await assertMember(tx, ctx.householdId, ctx.userId);
		await lockHousehold(tx, ctx.householdId, { pantry: true });
		const lots = await lockLots(tx, ctx.householdId, [input.lotId]);
		const lot = lots.get(input.lotId);
		if (!lot) throw new AppError(404, 'Pantry lot not found');
		if (lot.revision !== input.expectedRevision)
			throw new ReviewConflict('This lot changed since you opened it', {
				lot: { ...lot, quantity: lot.quantity.toString() }
			});
		const [updated] = await tx
			.update(stockLots)
			.set({
				location: input.location.trim().slice(0, 60),
				expiresOn,
				note: input.note.trim().slice(0, 300),
				revision: sql`${stockLots.revision} + 1`,
				updatedAt: sql`now()`
			})
			.where(eq(stockLots.id, input.lotId))
			.returning({ revision: stockLots.revision });
		return { revision: updated.revision };
	});
}

/**
 * Quantity correction: the user reports the freshly checked balance; we
 * record the delta. A stale edit (lot revision moved on) is rejected for review.
 */
export async function correctLot(
	ctx: ActorContext,
	input: {
		operationId: string;
		lotId: string;
		checkedQuantity: Dec;
		expectedRevision: number;
		note: string;
	}
) {
	if (input.checkedQuantity.isNegative()) throw new AppError(400, 'Quantity cannot be negative');
	const payload = {
		lotId: input.lotId,
		checkedQuantity: input.checkedQuantity.toString(),
		expectedRevision: input.expectedRevision,
		note: input.note,
		householdId: ctx.householdId
	};
	return runOperation(
		{ operationId: input.operationId, userId: ctx.userId, kind: 'correction', payload },
		async (tx) => {
			await assertMember(tx, ctx.householdId, ctx.userId);
			await lockHousehold(tx, ctx.householdId, { pantry: true });
			const lot = (await lockLots(tx, ctx.householdId, [input.lotId])).get(input.lotId);
			if (!lot) throw new AppError(404, 'Pantry lot not found');
			if (lot.revision !== input.expectedRevision) {
				throw new ReviewConflict(
					'This lot was updated by someone else. Check the shelf again before correcting.',
					{
						lot: {
							id: lot.id,
							quantity: lot.quantity.toString(),
							unit: lot.unit,
							revision: lot.revision
						}
					}
				);
			}
			const delta = input.checkedQuantity.sub(lot.quantity);
			const [{ name }] = await tx
				.select({ name: ingredients.name })
				.from(ingredients)
				.where(eq(ingredients.id, lot.ingredientId));
			if (delta.isZero())
				return { eventId: null, delta: '0', balance: lot.quantity.toString(), noChange: true };
			const eventId = await insertEvent(tx, {
				householdId: ctx.householdId,
				kind: 'correction',
				actorUserId: ctx.userId,
				actorName: ctx.actorName,
				operationId: input.operationId,
				summary: `Corrected ${name}: ${lot.quantity.toHuman()} → ${input.checkedQuantity.toHuman()} ${lot.unit}`,
				details: {
					lotId: lot.id,
					ingredientId: lot.ingredientId,
					name,
					before: lot.quantity.toString(),
					after: input.checkedQuantity.toString(),
					unit: lot.unit,
					note: input.note.slice(0, 300)
				}
			});
			const balance = await applyMovement(tx, {
				eventId,
				householdId: ctx.householdId,
				lotId: lot.id,
				ingredientId: lot.ingredientId,
				delta,
				unit: lot.unit
			});
			return { eventId, delta: delta.toString(), balance: balance.toString(), noChange: false };
		}
	);
}

export async function wasteLot(
	ctx: ActorContext,
	input: { operationId: string; lotId: string; quantity: Dec; reason: string }
) {
	if (!input.quantity.isPositive()) throw new AppError(400, 'Enter the amount thrown away');
	const payload = {
		lotId: input.lotId,
		quantity: input.quantity.toString(),
		reason: input.reason,
		householdId: ctx.householdId
	};
	return runOperation(
		{ operationId: input.operationId, userId: ctx.userId, kind: 'waste', payload },
		async (tx) => {
			await assertMember(tx, ctx.householdId, ctx.userId);
			await lockHousehold(tx, ctx.householdId, { pantry: true });
			const lot = (await lockLots(tx, ctx.householdId, [input.lotId])).get(input.lotId);
			if (!lot) throw new AppError(404, 'Pantry lot not found');
			if (input.quantity.gt(lot.quantity)) {
				throw new ReviewConflict(
					`Only ${lot.quantity.toHuman()} ${lot.unit} is tracked in this lot`,
					{
						lot: {
							id: lot.id,
							quantity: lot.quantity.toString(),
							unit: lot.unit,
							revision: lot.revision
						}
					}
				);
			}
			const [{ name }] = await tx
				.select({ name: ingredients.name })
				.from(ingredients)
				.where(eq(ingredients.id, lot.ingredientId));
			const eventId = await insertEvent(tx, {
				householdId: ctx.householdId,
				kind: 'waste',
				actorUserId: ctx.userId,
				actorName: ctx.actorName,
				operationId: input.operationId,
				summary: `Discarded ${input.quantity.toHuman()} ${lot.unit} of ${name}${input.reason ? ` (${input.reason})` : ''}`,
				details: {
					lotId: lot.id,
					ingredientId: lot.ingredientId,
					name,
					quantity: input.quantity.toString(),
					unit: lot.unit,
					reason: input.reason.slice(0, 300)
				}
			});
			const balance = await applyMovement(tx, {
				eventId,
				householdId: ctx.householdId,
				lotId: lot.id,
				ingredientId: lot.ingredientId,
				delta: input.quantity.neg(),
				unit: lot.unit
			});
			return { eventId, balance: balance.toString() };
		}
	);
}

/* ------------------------------ history ------------------------------ */

export interface HistoryCursor {
	occurredAt: string;
	id: string;
}

export interface HistoryEvent {
	id: string;
	kind: string;
	actorName: string;
	occurredAt: string;
	summary: string;
	recipeTitle: string | null;
	servings: string | null;
	reversedByEventId: string | null;
	reversesEventId: string | null;
	details: Record<string, unknown>;
	movements: {
		lotId: string;
		ingredientName: string;
		delta: string;
		unit: string;
		balanceAfter: string;
	}[];
	canUndo: boolean;
}

export async function getHistory(
	dbx: DbOrTx,
	householdId: string,
	cursor: HistoryCursor | null,
	limit = 30
) {
	const conds = [eq(inventoryEvents.householdId, householdId)];
	if (cursor)
		conds.push(
			or(
				lt(inventoryEvents.occurredAt, cursor.occurredAt),
				and(eq(inventoryEvents.occurredAt, cursor.occurredAt), lt(inventoryEvents.id, cursor.id))
			)!
		);
	const events = await dbx
		.select({
			id: inventoryEvents.id,
			kind: inventoryEvents.kind,
			actorName: inventoryEvents.actorName,
			occurredAt: inventoryEvents.occurredAt,
			summary: inventoryEvents.summary,
			recipeTitle: inventoryEvents.recipeTitle,
			servings: inventoryEvents.servings,
			reversedByEventId: inventoryEvents.reversedByEventId,
			reversesEventId: inventoryEvents.reversesEventId,
			details: inventoryEvents.details
		})
		.from(inventoryEvents)
		.where(and(...conds))
		.orderBy(desc(inventoryEvents.occurredAt), desc(inventoryEvents.id))
		.limit(limit + 1);
	const hasMore = events.length > limit;
	const page = events.slice(0, limit);
	const ids = page.map((e) => e.id);
	const movements = ids.length
		? await dbx
				.select({
					eventId: inventoryMovements.eventId,
					lotId: inventoryMovements.lotId,
					ingredientName: ingredients.name,
					delta: inventoryMovements.delta,
					unit: inventoryMovements.unit,
					balanceAfter: inventoryMovements.balanceAfter
				})
				.from(inventoryMovements)
				.innerJoin(ingredients, eq(ingredients.id, inventoryMovements.ingredientId))
				.where(inArray(inventoryMovements.eventId, ids))
				.orderBy(asc(inventoryMovements.createdAt), asc(inventoryMovements.id))
		: [];
	const byEvent = new Map<string, HistoryEvent['movements']>();
	for (const m of movements) {
		const list = byEvent.get(m.eventId) ?? [];
		list.push({
			lotId: m.lotId,
			ingredientName: m.ingredientName,
			delta: Dec.from(m.delta).toString(),
			unit: m.unit,
			balanceAfter: Dec.from(m.balanceAfter).toString()
		});
		byEvent.set(m.eventId, list);
	}
	const items: HistoryEvent[] = page.map((e) => ({
		...e,
		servings: e.servings ? Dec.from(e.servings).toString() : null,
		movements: byEvent.get(e.id) ?? [],
		canUndo: e.kind !== 'undo' && !e.reversedByEventId
	}));
	const last = page[page.length - 1];
	return {
		items,
		nextCursor: hasMore && last ? { occurredAt: last.occurredAt, id: last.id } : null
	};
}

/* -------------------------- consistency check -------------------------- */

export interface ConsistencyReport {
	lotsChecked: number;
	lotMismatches: { lotId: string; householdId: string; balance: string; movementSum: string }[];
	lineMismatches: { lineId: string; purchasedAmount: string; allocationSum: string }[];
}

/** Compare current lot balances with the append-only movement log; never mutates. */
export async function consistencyCheck(
	dbx: DbOrTx,
	householdId: string | null = null
): Promise<ConsistencyReport> {
	const lotRows = await dbx
		.select({
			lotId: stockLots.id,
			householdId: stockLots.householdId,
			balance: stockLots.quantity,
			movementSum: sql<string>`coalesce((select sum(m.delta) from inventory_movement m where m.lot_id = stock_lot.id), 0)`
		})
		.from(stockLots)
		.where(householdId ? eq(stockLots.householdId, householdId) : sql`true`);
	const lotMismatches = lotRows
		.filter((r) => !Dec.from(r.balance).eq(Dec.from(r.movementSum)))
		.map((r) => ({
			lotId: r.lotId,
			householdId: r.householdId,
			balance: Dec.from(r.balance).toString(),
			movementSum: Dec.from(r.movementSum).toString()
		}));
	const lineRows = await dbx
		.select({
			lineId: groceryLines.id,
			purchasedAmount: groceryLines.purchasedAmount,
			allocationSum: sql<string>`coalesce((select sum(a.amount) from purchase_allocation a where a.line_id = grocery_line.id), 0)`
		})
		.from(groceryLines)
		.where(
			householdId
				? sql`${groceryLines.listId} in (select id from grocery_list where household_id = ${householdId})`
				: sql`true`
		);
	const lineMismatches = lineRows
		.filter((r) => !Dec.from(r.purchasedAmount).eq(Dec.from(r.allocationSum)))
		.map((r) => ({
			lineId: r.lineId,
			purchasedAmount: Dec.from(r.purchasedAmount).toString(),
			allocationSum: Dec.from(r.allocationSum).toString()
		}));
	return { lotsChecked: lotRows.length, lotMismatches, lineMismatches };
}
