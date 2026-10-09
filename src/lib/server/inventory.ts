import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '$lib/server/db';
import {
	households,
	inventoryEvents,
	inventoryMovements,
	stockLots,
	type EventKind
} from '$lib/server/db/schema';
import { Dec } from '$lib/shared/decimal';
import { convertAmount, unitsCompatible, type Convention } from '$lib/shared/units';
import { AppError } from '$lib/server/errors';

/**
 * Lock order for every inventory transaction:
 *   1. household row (UPDATE ... bumps the revision counter and takes the lock)
 *   2. stock lots, ordered by id, FOR UPDATE
 * Keeping this order everywhere makes deadlocks impossible between app
 * transactions; the guarded UPDATE on quantity is the last line of defence.
 */
export async function lockHousehold(
	tx: Tx,
	householdId: string,
	bump: { pantry?: boolean; grocery?: boolean; plan?: boolean }
) {
	const [row] = await tx
		.update(households)
		.set({
			pantryRevision: bump.pantry
				? sql`${households.pantryRevision} + 1`
				: households.pantryRevision,
			groceryRevision: bump.grocery
				? sql`${households.groceryRevision} + 1`
				: households.groceryRevision,
			planRevision: bump.plan ? sql`${households.planRevision} + 1` : households.planRevision
		})
		.where(eq(households.id, householdId))
		.returning({
			pantryRevision: households.pantryRevision,
			groceryRevision: households.groceryRevision,
			planRevision: households.planRevision
		});
	if (!row) throw new AppError(404, 'Household not found');
	return row;
}

export interface LockedLot {
	id: string;
	ingredientId: string;
	quantity: Dec;
	unit: string;
	location: string;
	expiresOn: string | null;
	revision: number;
}

export async function lockLots(
	tx: Tx,
	householdId: string,
	lotIds: string[]
): Promise<Map<string, LockedLot>> {
	if (!lotIds.length) return new Map();
	const ids = [...new Set(lotIds)].sort();
	const rows = await tx
		.select({
			id: stockLots.id,
			ingredientId: stockLots.ingredientId,
			quantity: stockLots.quantity,
			unit: stockLots.unit,
			location: stockLots.location,
			expiresOn: stockLots.expiresOn,
			revision: stockLots.revision
		})
		.from(stockLots)
		.where(and(eq(stockLots.householdId, householdId), inArray(stockLots.id, ids)))
		.orderBy(asc(stockLots.id))
		.for('update');
	return new Map(rows.map((r) => [r.id, { ...r, quantity: Dec.from(r.quantity) }]));
}

/** Lock one lot of the household, or 404. */
export async function lockLot(tx: Tx, householdId: string, lotId: string): Promise<LockedLot> {
	const lot = (await lockLots(tx, householdId, [lotId])).get(lotId);
	if (!lot) throw new AppError(404, 'Pantry lot not found');
	return lot;
}

export interface EventInput {
	householdId: string;
	kind: EventKind;
	actorUserId: string;
	actorName: string;
	operationId?: string | null;
	summary: string;
	details?: Record<string, unknown>;
	recipeId?: string | null;
	recipeTitle?: string | null;
	recipeRevision?: number | null;
	servings?: Dec | null;
	batchId?: string | null;
	plannedServingsFulfilled?: Dec | null;
	unplannedServings?: Dec | null;
	groceryListId?: string | null;
	reversesEventId?: string | null;
}

export async function insertEvent(tx: Tx, input: EventInput): Promise<string> {
	const [row] = await tx
		.insert(inventoryEvents)
		.values({
			householdId: input.householdId,
			kind: input.kind,
			actorUserId: input.actorUserId,
			actorName: input.actorName,
			operationId: input.operationId ?? null,
			summary: input.summary,
			details: input.details ?? {},
			recipeId: input.recipeId ?? null,
			recipeTitle: input.recipeTitle ?? null,
			recipeRevision: input.recipeRevision ?? null,
			servings: input.servings ? input.servings.toDb() : null,
			batchId: input.batchId ?? null,
			plannedServingsFulfilled: input.plannedServingsFulfilled
				? input.plannedServingsFulfilled.toDb()
				: null,
			unplannedServings: input.unplannedServings ? input.unplannedServings.toDb() : null,
			groceryListId: input.groceryListId ?? null,
			reversesEventId: input.reversesEventId ?? null
		})
		.returning({ id: inventoryEvents.id });
	return row.id;
}

export interface MovementInput {
	eventId: string;
	householdId: string;
	lotId: string;
	ingredientId: string;
	delta: Dec;
	unit: string;
}

/**
 * Apply signed deltas to lots, each with a guarded atomic update (never below
 * zero), in the given order, and record the append-only movements with their
 * resulting balances in one insert. Returns the balances in input order.
 */
export async function applyMovements(tx: Tx, moves: MovementInput[]): Promise<Dec[]> {
	const balances: Dec[] = [];
	for (const m of moves) {
		const [updated] = await tx
			.update(stockLots)
			.set({
				quantity: sql`${stockLots.quantity} + ${m.delta.toDb()}::numeric`,
				revision: sql`${stockLots.revision} + 1`,
				updatedAt: sql`now()`
			})
			.where(
				and(
					eq(stockLots.id, m.lotId),
					eq(stockLots.householdId, m.householdId),
					sql`${stockLots.quantity} + ${m.delta.toDb()}::numeric >= 0`
				)
			)
			.returning({ quantity: stockLots.quantity });
		if (!updated) throw new AppError(409, 'That change would take a pantry lot below zero');
		balances.push(Dec.from(updated.quantity));
	}
	if (moves.length)
		await tx.insert(inventoryMovements).values(
			moves.map((m, i) => ({
				eventId: m.eventId,
				householdId: m.householdId,
				lotId: m.lotId,
				ingredientId: m.ingredientId,
				delta: m.delta.toDb(),
				unit: m.unit,
				balanceAfter: balances[i].toDb()
			}))
		);
	return balances;
}

/** `applyMovements` for one lot; returns its balance after the change. */
export async function applyMovement(tx: Tx, args: MovementInput): Promise<Dec> {
	const [balance] = await applyMovements(tx, [args]);
	return balance;
}

export async function createLot(
	tx: Tx,
	args: {
		eventId: string;
		householdId: string;
		ingredientId: string;
		quantity: Dec;
		unit: string;
		location: string;
		expiresOn: string | null;
		note: string;
	}
): Promise<string> {
	if (args.quantity.isNegative()) throw new AppError(400, 'Quantity cannot be negative');
	const [lot] = await tx
		.insert(stockLots)
		.values({
			householdId: args.householdId,
			ingredientId: args.ingredientId,
			quantity: '0',
			unit: args.unit,
			location: args.location,
			expiresOn: args.expiresOn,
			note: args.note
		})
		.returning({ id: stockLots.id });
	await applyMovement(tx, {
		eventId: args.eventId,
		householdId: args.householdId,
		lotId: lot.id,
		ingredientId: args.ingredientId,
		delta: args.quantity,
		unit: args.unit
	});
	return lot.id;
}

export interface LotSuggestion {
	lotId: string;
	quantity: Dec;
	unit: string;
	location: string;
	expiresOn: string | null;
	revision: number;
	/** amount to take from this lot, in the lot's unit */
	take: Dec;
	/** the same amount expressed in the requested unit */
	takeInRequested: Dec;
}

export interface DeductionPlan {
	ingredientId: string;
	requestedUnit: string;
	requested: Dec;
	covered: Dec;
	shortfall: Dec;
	suggestions: LotSuggestion[];
	/** lots of this ingredient that could not be converted to the requested unit */
	incompatible: { lotId: string; quantity: Dec; unit: string }[];
}

/**
 * FEFO order for pantry lots: earliest expires_on first, then undated lots
 * oldest first; the lot id breaks ties so the order is stable.
 */
export function fefoOrder(
	a: { id: string; expiresOn: string | null; createdAt?: string },
	b: { id: string; expiresOn: string | null; createdAt?: string }
): number {
	if (a.expiresOn && b.expiresOn && a.expiresOn !== b.expiresOn)
		return a.expiresOn < b.expiresOn ? -1 : 1;
	if (a.expiresOn && !b.expiresOn) return -1;
	if (!a.expiresOn && b.expiresOn) return 1;
	if (!a.expiresOn) {
		const ca = a.createdAt ?? '';
		const cb = b.createdAt ?? '';
		if (ca !== cb) return ca < cb ? -1 : 1;
	}
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Suggest lots to deduct from in `fefoOrder`. Pure planning — nothing is
 * written. Callers may override.
 */
export function planDeduction(
	ingredientId: string,
	requested: Dec,
	requestedUnit: string,
	lots: {
		id: string;
		ingredientId: string;
		quantity: Dec;
		unit: string;
		location: string;
		expiresOn: string | null;
		revision: number;
		createdAt?: string;
	}[],
	convention: Convention,
	gramsPerMl: Dec | null = null
): DeductionPlan {
	const candidates = lots
		.filter((l) => l.ingredientId === ingredientId && l.quantity.isPositive())
		.sort(fefoOrder);
	let remaining = requested;
	const suggestions: LotSuggestion[] = [];
	const incompatible: DeductionPlan['incompatible'] = [];
	for (const lot of candidates) {
		const compatible = unitsCompatible(lot.unit, requestedUnit);
		const opts = { gramsPerMl };
		const available = compatible
			? convertAmount(lot.quantity, lot.unit, requestedUnit, convention)
			: gramsPerMl
				? convertAmount(lot.quantity, lot.unit, requestedUnit, convention, opts)
				: null;
		if (available === null) {
			incompatible.push({ lotId: lot.id, quantity: lot.quantity, unit: lot.unit });
			continue;
		}
		if (!remaining.isPositive()) break;
		const takeRequested = Dec.min(remaining, available);
		const takeLot = takeRequested.eq(available)
			? lot.quantity
			: (convertAmount(takeRequested, requestedUnit, lot.unit, convention, opts) ?? takeRequested);
		suggestions.push({
			lotId: lot.id,
			quantity: lot.quantity,
			unit: lot.unit,
			location: lot.location,
			expiresOn: lot.expiresOn,
			revision: lot.revision,
			take: takeLot,
			takeInRequested: takeRequested
		});
		remaining = remaining.sub(takeRequested);
	}
	return {
		ingredientId,
		requestedUnit,
		requested,
		covered: requested.sub(Dec.max(Dec.zero, remaining)),
		shortfall: Dec.max(Dec.zero, remaining),
		suggestions,
		incompatible
	};
}

export async function activeLotsForIngredients(
	tx: DbOrTx,
	householdId: string,
	ingredientIds: string[]
) {
	if (!ingredientIds.length) return [];
	const rows = await tx
		.select({
			id: stockLots.id,
			ingredientId: stockLots.ingredientId,
			quantity: stockLots.quantity,
			unit: stockLots.unit,
			location: stockLots.location,
			expiresOn: stockLots.expiresOn,
			revision: stockLots.revision,
			createdAt: stockLots.createdAt
		})
		.from(stockLots)
		.where(
			and(
				eq(stockLots.householdId, householdId),
				inArray(stockLots.ingredientId, [...new Set(ingredientIds)]),
				gt(stockLots.quantity, '0')
			)
		)
		.orderBy(asc(stockLots.id));
	return rows.map((r) => ({ ...r, quantity: Dec.from(r.quantity) }));
}
