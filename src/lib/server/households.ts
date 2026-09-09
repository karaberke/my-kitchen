import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import {
	householdInvites,
	householdMembers,
	households,
	inventoryMovements,
	user,
	userPreferences,
	type HouseholdRole
} from '$lib/server/db/schema';
import { AppError, forbidden } from '$lib/server/errors';
import { assertMember, assertOwner } from '$lib/server/access';
import { withTransaction } from '$lib/server/operations';
import { dbTimestampMs } from '$lib/shared/time';

/** Create the personal household for a new user, idempotently. */
export async function ensurePersonalHousehold(db: DbOrTx, userId: string, displayName: string) {
	const existing = await db
		.select({ householdId: householdMembers.householdId })
		.from(householdMembers)
		.where(eq(householdMembers.userId, userId))
		.limit(1);
	if (existing.length) return existing[0].householdId;
	const first = displayName.trim().split(/\s+/)[0] || 'My';
	const name = `${first}'s kitchen`;
	const [household] = await db.insert(households).values({ name }).returning({ id: households.id });
	await db.insert(householdMembers).values({ householdId: household.id, userId, role: 'owner' });
	await db
		.insert(userPreferences)
		.values({ userId, activeHouseholdId: household.id })
		.onConflictDoUpdate({
			target: userPreferences.userId,
			set: { activeHouseholdId: household.id }
		});
	return household.id;
}

export interface MembershipRow {
	householdId: string;
	name: string;
	role: HouseholdRole;
	memberCount: number;
}

export async function listMemberships(db: DbOrTx, userId: string): Promise<MembershipRow[]> {
	const rows = await db
		.select({
			householdId: householdMembers.householdId,
			name: households.name,
			role: householdMembers.role,
			memberCount: sql<number>`(select count(*)::int from household_member m2 where m2.household_id = ${householdMembers.householdId})`
		})
		.from(householdMembers)
		.innerJoin(households, eq(households.id, householdMembers.householdId))
		.where(eq(householdMembers.userId, userId))
		.orderBy(asc(households.createdAt), asc(households.id));
	return rows;
}

export async function getMembership(db: DbOrTx, householdId: string, userId: string) {
	const rows = await db
		.select({ role: householdMembers.role })
		.from(householdMembers)
		.where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
		.limit(1);
	return rows[0] ?? null;
}

/* ------------------------- management (owners) ------------------------- */

export const INVITE_TTL_HOURS = 72;

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export async function createHousehold(db: DbOrTx, userId: string, name: string): Promise<string> {
	const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
	if (clean.length < 2) throw new AppError(400, 'Give the household a name');
	const [household] = await db
		.insert(households)
		.values({ name: clean })
		.returning({ id: households.id });
	await db.insert(householdMembers).values({ householdId: household.id, userId, role: 'owner' });
	await setActiveHousehold(db, userId, household.id);
	return household.id;
}

export async function renameHousehold(
	db: DbOrTx,
	userId: string,
	householdId: string,
	name: string
) {
	await assertOwner(db, householdId, userId);
	const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
	if (clean.length < 2) throw new AppError(400, 'Give the household a name');
	await db.update(households).set({ name: clean }).where(eq(households.id, householdId));
}

export async function setActiveHousehold(db: DbOrTx, userId: string, householdId: string) {
	await assertMember(db, householdId, userId);
	await db
		.insert(userPreferences)
		.values({ userId, activeHouseholdId: householdId })
		.onConflictDoUpdate({
			target: userPreferences.userId,
			set: { activeHouseholdId: householdId, updatedAt: sql`now()` }
		});
}

export async function listMembers(db: DbOrTx, householdId: string) {
	return db
		.select({
			userId: householdMembers.userId,
			name: user.name,
			email: user.email,
			role: householdMembers.role,
			joinedAt: householdMembers.createdAt
		})
		.from(householdMembers)
		.innerJoin(user, eq(user.id, householdMembers.userId))
		.where(eq(householdMembers.householdId, householdId))
		.orderBy(asc(householdMembers.createdAt));
}

/** Create a single-use invite. The raw token is returned exactly once. */
export async function createInvite(
	db: DbOrTx,
	userId: string,
	householdId: string
): Promise<{ id: string; token: string; expiresAt: string }> {
	await assertOwner(db, householdId, userId);
	const token = randomBytes(24).toString('base64url');
	const expires = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000).toISOString();
	const [row] = await db
		.insert(householdInvites)
		.values({ householdId, tokenHash: hashToken(token), createdBy: userId, expiresAt: expires })
		.returning({ id: householdInvites.id, expiresAt: householdInvites.expiresAt });
	return { id: row.id, token, expiresAt: row.expiresAt };
}

export async function listActiveInvites(db: DbOrTx, householdId: string) {
	return db
		.select({
			id: householdInvites.id,
			createdAt: householdInvites.createdAt,
			expiresAt: householdInvites.expiresAt,
			createdByName: user.name
		})
		.from(householdInvites)
		.leftJoin(user, eq(user.id, householdInvites.createdBy))
		.where(
			and(
				eq(householdInvites.householdId, householdId),
				isNull(householdInvites.usedAt),
				isNull(householdInvites.revokedAt),
				gt(householdInvites.expiresAt, sql`now()`)
			)
		)
		.orderBy(desc(householdInvites.createdAt))
		.limit(20);
}

export async function revokeInvite(
	db: DbOrTx,
	userId: string,
	householdId: string,
	inviteId: string
) {
	await assertOwner(db, householdId, userId);
	await db
		.update(householdInvites)
		.set({ revokedAt: sql`now()` })
		.where(and(eq(householdInvites.id, inviteId), eq(householdInvites.householdId, householdId)));
}

export async function peekInvite(db: DbOrTx, token: string) {
	const [row] = await db
		.select({
			id: householdInvites.id,
			householdId: householdInvites.householdId,
			householdName: households.name,
			expiresAt: householdInvites.expiresAt,
			usedAt: householdInvites.usedAt,
			revokedAt: householdInvites.revokedAt
		})
		.from(householdInvites)
		.innerJoin(households, eq(households.id, householdInvites.householdId))
		.where(eq(householdInvites.tokenHash, hashToken(token)))
		.limit(1);
	if (!row) return null;
	const valid = !row.usedAt && !row.revokedAt && dbTimestampMs(row.expiresAt) > Date.now();
	return { ...row, valid };
}

/** Accept an invite: single use, atomically. */
export async function acceptInvite(userId: string, token: string): Promise<string> {
	return withTransaction(async (tx) => {
		const [inv] = await tx
			.select()
			.from(householdInvites)
			.where(eq(householdInvites.tokenHash, hashToken(token)))
			.for('update');
		if (!inv) throw new AppError(404, 'This invitation link is not valid');
		if (inv.revokedAt) throw new AppError(410, 'This invitation was revoked');
		if (inv.usedAt) throw new AppError(410, 'This invitation was already used');
		if (dbTimestampMs(inv.expiresAt) < Date.now())
			throw new AppError(410, 'This invitation has expired');
		await tx
			.insert(householdMembers)
			.values({ householdId: inv.householdId, userId, role: 'member' })
			.onConflictDoNothing();
		await tx
			.update(householdInvites)
			.set({ usedAt: sql`now()`, usedBy: userId })
			.where(eq(householdInvites.id, inv.id));
		await setActiveHousehold(tx, userId, inv.householdId);
		return inv.householdId;
	});
}

async function ownerCount(db: DbOrTx, householdId: string): Promise<number> {
	const [{ n }] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(householdMembers)
		.where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.role, 'owner')));
	return n;
}

/** Owners can remove members; anyone can leave. The final owner must transfer ownership first. */
export async function removeMember(actorId: string, householdId: string, targetUserId: string) {
	await withTransaction(async (tx) => {
		const actorRole = await assertMember(tx, householdId, actorId);
		if (actorId !== targetUserId && actorRole !== 'owner')
			throw forbidden('Only owners can remove other members');
		const [target] = await tx
			.select({ role: householdMembers.role })
			.from(householdMembers)
			.where(
				and(
					eq(householdMembers.householdId, householdId),
					eq(householdMembers.userId, targetUserId)
				)
			)
			.for('update');
		if (!target) throw new AppError(404, 'Member not found');
		if (target.role === 'owner' && (await ownerCount(tx, householdId)) <= 1) {
			throw new AppError(
				409,
				'Transfer ownership to another member before removing the last owner'
			);
		}
		await tx
			.delete(householdMembers)
			.where(
				and(
					eq(householdMembers.householdId, householdId),
					eq(householdMembers.userId, targetUserId)
				)
			);
	});
}

export async function setMemberRole(
	actorId: string,
	householdId: string,
	targetUserId: string,
	role: HouseholdRole
) {
	await withTransaction(async (tx) => {
		await assertOwner(tx, householdId, actorId);
		const [target] = await tx
			.select({ role: householdMembers.role })
			.from(householdMembers)
			.where(
				and(
					eq(householdMembers.householdId, householdId),
					eq(householdMembers.userId, targetUserId)
				)
			)
			.for('update');
		if (!target) throw new AppError(404, 'Member not found');
		if (target.role === 'owner' && role === 'member' && (await ownerCount(tx, householdId)) <= 1) {
			throw new AppError(409, 'Promote another member to owner first');
		}
		await tx
			.update(householdMembers)
			.set({ role })
			.where(
				and(
					eq(householdMembers.householdId, householdId),
					eq(householdMembers.userId, targetUserId)
				)
			);
	});
}

/**
 * Delete a household and every row scoped to it (members, invites, pantry, grocery lists,
 * inventory history, recipe shares). Recipes and images are user-owned and survive. Owner-only.
 */
export async function deleteHousehold(actorId: string, householdId: string): Promise<void> {
	await withTransaction(async (tx) => {
		await assertOwner(tx, householdId, actorId);
		// Lock the household row so concurrent pantry/grocery mutations serialise behind us.
		const [row] = await tx
			.select({ id: households.id })
			.from(households)
			.where(eq(households.id, householdId))
			.for('update');
		if (!row) throw new AppError(404, 'Household not found');
		// inventory_movement.lot_id -> stock_lot is ON DELETE RESTRICT, and the household cascade
		// does not guarantee movements go before their lots. Clear movements explicitly first.
		await tx.delete(inventoryMovements).where(eq(inventoryMovements.householdId, householdId));
		// Everything else cascades; user_preference.active_household_id is set null.
		await tx.delete(households).where(eq(households.id, householdId));
	});
}

export async function otherOwnersExist(
	db: DbOrTx,
	householdId: string,
	userId: string
): Promise<boolean> {
	const [row] = await db
		.select({ id: householdMembers.userId })
		.from(householdMembers)
		.where(
			and(
				eq(householdMembers.householdId, householdId),
				eq(householdMembers.role, 'owner'),
				ne(householdMembers.userId, userId)
			)
		)
		.limit(1);
	return !!row;
}
