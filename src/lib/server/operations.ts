import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '$lib/server/db';
import { operations } from '$lib/server/db/schema';
import { AppError, pgError } from '$lib/server/errors';

/** Stable JSON (sorted keys) so equal payloads produce equal fingerprints. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function fingerprint(kind: string, payload: unknown): string {
	return createHash('sha256')
		.update(kind)
		.update('\n')
		.update(stableStringify(payload))
		.digest('hex');
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

function isRetryable(err: unknown): boolean {
	const pg = pgError(err);
	return !!pg && RETRYABLE.has(pg.code);
}

function isUniqueViolation(err: unknown, constraint?: string): boolean {
	const pg = pgError(err);
	return (
		!!pg && pg.code === '23505' && (constraint === undefined || pg.constraint_name === constraint)
	);
}

/**
 * Run a short transaction with bounded retries on serialization failures or
 * deadlocks. Callers must lock rows in a consistent order (household first).
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await db.transaction(fn);
		} catch (err) {
			lastError = err;
			if (!isRetryable(err) || i === attempts - 1) throw err;
			await new Promise((r) => setTimeout(r, 25 * (i + 1) + Math.random() * 25));
		}
	}
	throw lastError;
}

export interface OperationContext {
	operationId: string;
	userId: string;
	kind: string;
	payload: unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isOperationId(value: unknown): value is string {
	return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Exactly-once mutation wrapper.
 *
 * - A retry with the same operation id and identical payload returns the
 *   stored result without touching data again.
 * - The same id with a different payload is rejected (409).
 * - The operation row is inserted inside the same transaction as the mutation,
 *   so the primary key is the integrity mechanism, not client-side state.
 */
export async function runOperation<T extends Record<string, unknown>>(
	ctx: OperationContext,
	fn: (tx: Tx) => Promise<T>
): Promise<{ result: T; replayed: boolean }> {
	if (!isOperationId(ctx.operationId)) throw new AppError(400, 'A valid operation id is required');
	const fp = fingerprint(ctx.kind, ctx.payload);

	const checkExisting = async (): Promise<{ result: T; replayed: true } | null> => {
		const rows = await db
			.select({
				userId: operations.userId,
				fingerprint: operations.fingerprint,
				result: operations.result
			})
			.from(operations)
			.where(eq(operations.id, ctx.operationId))
			.limit(1);
		const existing = rows[0];
		if (!existing) return null;
		if (existing.userId !== ctx.userId)
			throw new AppError(409, 'Operation id belongs to another user');
		if (existing.fingerprint !== fp)
			throw new AppError(409, 'This operation id was already used with a different request');
		return { result: existing.result as T, replayed: true };
	};

	const prior = await checkExisting();
	if (prior) return prior;

	try {
		const result = await withTransaction(async (tx) => {
			// Claim the id first: a concurrent retry blocks on this primary key until
			// we commit or roll back, then replays or is rejected. Events may
			// reference the operation row inside the same transaction.
			await tx.insert(operations).values({
				id: ctx.operationId,
				userId: ctx.userId,
				kind: ctx.kind,
				fingerprint: fp,
				result: {}
			});
			const value = await fn(tx);
			await tx.update(operations).set({ result: value }).where(eq(operations.id, ctx.operationId));
			return value;
		});
		return { result, replayed: false };
	} catch (err) {
		if (isUniqueViolation(err, 'operation_pkey')) {
			const replay = await checkExisting();
			if (replay) return replay;
		}
		throw err;
	}
}

/**
 * Drop idempotency records past the window in which a client could still retry.
 * The table only ever grows otherwise: every pantry, grocery and cooking
 * mutation writes one row and nothing removed them.
 */
export async function cleanupOperations(olderThanDays = 30): Promise<number> {
	const rows = await db
		.delete(operations)
		.where(sql`${operations.createdAt} < now() - make_interval(days => ${olderThanDays})`)
		.returning({ id: operations.id });
	return rows.length;
}
