import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '$lib/server/db';
import { recipeAttachments, recipes } from '$lib/server/db/schema';
import { recipeReadableBy } from '$lib/server/access';
import { AppError } from '$lib/server/errors';
import { storage } from '$lib/server/media/storage';

/** Source files an import may keep. HTML is stored as bytes and never served as markup. */
export const ATTACHMENT_TYPES = {
	pdf: { mime: 'application/pdf', label: 'PDF' },
	html: { mime: 'text/html', label: 'HTML file' }
} as const;
export type AttachmentKind = keyof typeof ATTACHMENT_TYPES;

export const MAX_ATTACHMENT_BYTES = 10_000_000;

function safeFilename(name: string): string {
	const clean = name
		.replace(/[\r\n\t]/g, ' ')
		.replace(/[\\/]/g, '-')
		.trim();
	return (clean || 'import').slice(0, 120);
}

/**
 * Keep the original file an import came from. Returns the attachment id, which
 * the review form carries so a saved recipe can point back at it.
 */
export async function storeAttachment(
	userId: string,
	input: { bytes: Buffer; filename: string; kind: AttachmentKind; pageCount?: number | null }
): Promise<string> {
	if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
		throw new AppError(413, 'That file is too large to keep as a source');
	const objectKey = `attachments/${userId.toLowerCase().replace(/[^a-z0-9_-]/g, '')}/${randomUUID()}`;
	const type = ATTACHMENT_TYPES[input.kind];
	const store = storage();
	await store.put(objectKey, input.bytes, type.mime);
	const [row] = await db
		.insert(recipeAttachments)
		.values({
			ownerUserId: userId,
			backend: store.name,
			objectKey,
			filename: safeFilename(input.filename),
			mime: type.mime,
			sizeBytes: input.bytes.byteLength,
			pageCount: input.pageCount ?? null
		})
		.returning({ id: recipeAttachments.id });
	return row.id;
}

/**
 * An attachment is readable by its owner, or by anyone who can read a recipe
 * that points at it — the same rule the recipe itself follows.
 */
export async function loadReadableAttachment(dbx: DbOrTx, userId: string, attachmentId: string) {
	const [row] = await dbx
		.select({
			id: recipeAttachments.id,
			objectKey: recipeAttachments.objectKey,
			filename: recipeAttachments.filename,
			mime: recipeAttachments.mime,
			sizeBytes: recipeAttachments.sizeBytes,
			pageCount: recipeAttachments.pageCount,
			ownerUserId: recipeAttachments.ownerUserId
		})
		.from(recipeAttachments)
		.where(eq(recipeAttachments.id, attachmentId))
		.limit(1);
	if (!row) return null;
	if (row.ownerUserId === userId) return row;
	const [shared] = await dbx
		.select({ id: recipes.id })
		.from(recipes)
		.where(and(eq(recipes.sourceAttachmentId, attachmentId), recipeReadableBy(userId)))
		.limit(1);
	return shared ? row : null;
}

/** Claim an attachment for a recipe the user owns. Ignores anything not theirs. */
export async function attachToRecipe(
	dbx: DbOrTx,
	userId: string,
	recipeId: string,
	attachmentId: string
): Promise<void> {
	const [own] = await dbx
		.select({ id: recipeAttachments.id })
		.from(recipeAttachments)
		.where(and(eq(recipeAttachments.id, attachmentId), eq(recipeAttachments.ownerUserId, userId)))
		.limit(1);
	if (!own) return;
	await dbx
		.update(recipes)
		.set({ sourceAttachmentId: attachmentId })
		.where(and(eq(recipes.id, recipeId), eq(recipes.ownerUserId, userId)));
}

/**
 * Drop attachments no recipe claimed — an import the user started and abandoned.
 * Mirrors the unreferenced-image sweep.
 */
export async function cleanupUnreferencedAttachments(olderThanMinutes = 60): Promise<number> {
	const rows = await db
		.select({ id: recipeAttachments.id, objectKey: recipeAttachments.objectKey })
		.from(recipeAttachments)
		.leftJoin(recipes, eq(recipes.sourceAttachmentId, recipeAttachments.id))
		.where(
			and(
				isNull(recipes.id),
				lt(recipeAttachments.createdAt, sql`now() - make_interval(mins => ${olderThanMinutes})`)
			)
		)
		.limit(500);
	const store = storage();
	for (const row of rows) {
		await store.delete(row.objectKey).catch(() => {});
		await db.delete(recipeAttachments).where(eq(recipeAttachments.id, row.id));
	}
	return rows.length;
}
