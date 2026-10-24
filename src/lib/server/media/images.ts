import { randomUUID } from 'node:crypto';
import { and, eq, or, exists, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '$lib/server/db';
import { images, recipes } from '$lib/server/db/schema';
import { recipeReadableBy } from '$lib/server/access';
import { serverEnv } from '$lib/server/env';
import { AppError } from '$lib/server/errors';
import { withTransaction } from '$lib/server/operations';
import { fetchImageBytes } from './image-fetch';
import { IMAGE_VARIANTS, renderImageVariants, type ImageVariant } from './image-pipeline';
import { MEDIA_SWEEP_BATCH, storage } from './storage';

export { IMAGE_VARIANTS, type ImageVariant };

const unreferencedImage = sql`not exists (select 1 from ${recipes} where ${recipes.imageId} = ${images.id})`;

/** Tiny semaphore so image processing cannot exhaust CPU/memory under a burst of uploads. */
class Semaphore {
	private queue: (() => void)[] = [];
	private active = 0;
	constructor(
		private readonly max: number,
		/** Waiting slots. Beyond this the upload is refused rather than queued forever. */
		private readonly maxQueued = 32
	) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) {
			if (this.queue.length >= this.maxQueued)
				throw new AppError(503, 'Too many photos are being processed. Try again in a moment.');
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}
let semaphore: Semaphore | null = null;

function bounded<T>(concurrency: number, fn: () => Promise<T>): Promise<T> {
	semaphore ??= new Semaphore(concurrency);
	return semaphore.run(fn);
}

export function variantKey(objectKey: string, variant: ImageVariant): string {
	return `${objectKey}/${variant}.webp`;
}

/**
 * Compress the bytes into variants, store them and record the image row.
 *
 * Every source of a picture ends here, so an uploaded photo and one pulled from
 * a link are compressed the same way and neither is kept at full size.
 */
async function storeImageBytes(userId: string, buffer: Buffer): Promise<string> {
	const rendered = await renderImageVariants(buffer);
	const objectKey = `images/${userId.toLowerCase().replace(/[^a-z0-9_-]/g, '')}/${randomUUID()}`;
	const store = storage();
	const variants: Record<string, { width: number; height: number; bytes: number; mime: string }> =
		{};
	await Promise.all(
		Object.entries(rendered.variants).map(([name, variant]) =>
			store.put(variantKey(objectKey, name as ImageVariant), variant.data, variant.mime)
		)
	);
	for (const [name, variant] of Object.entries(rendered.variants)) {
		variants[name] = {
			width: variant.width,
			height: variant.height,
			bytes: variant.bytes,
			mime: variant.mime
		};
	}
	const [row] = await db
		.insert(images)
		.values({
			ownerUserId: userId,
			backend: store.name,
			objectKey,
			version: 1,
			mime: rendered.mime,
			sizeBytes: buffer.length,
			width: rendered.width,
			height: rendered.height,
			variants
		})
		.returning({ id: images.id });
	return row.id;
}

/**
 * Validate an uploaded file (size first, then the real decoded image), generate
 * bounded variants once, strip metadata, store them and record the image row.
 */
export async function storeRecipeImage(userId: string, file: File): Promise<string> {
	const env = serverEnv();
	if (file.size > env.UPLOAD_MAX_BYTES)
		throw new AppError(
			413,
			`Images must be under ${Math.round(env.UPLOAD_MAX_BYTES / 1024 / 1024)} MB`
		);
	if (file.size < 64) throw new AppError(400, 'That file does not look like an image');
	return bounded(env.IMAGE_CONCURRENCY, async () => {
		// Read inside the semaphore: buffering first would let a burst hold every
		// upload in memory at once while only IMAGE_CONCURRENCY of them progress.
		const buffer = Buffer.from(await file.arrayBuffer());
		return storeImageBytes(userId, buffer);
	});
}

/**
 * The same, for a picture named by a link.
 *
 * The download stays outside the semaphore: it is bounded by its own byte cap
 * and timeout, and holding a processing slot while the network is slow would
 * block uploads that are ready to work. Only the compression is bounded here.
 */
export async function storeRecipeImageFromUrl(userId: string, url: string): Promise<string> {
	const env = serverEnv();
	const buffer = await fetchImageBytes(url, { maxBytes: env.UPLOAD_MAX_BYTES });
	return bounded(env.IMAGE_CONCURRENCY, () => storeImageBytes(userId, buffer));
}

/** An image is readable by its owner or by anyone who can read a recipe using it. */
export async function loadReadableImage(dbx: DbOrTx, userId: string, imageId: string) {
	const [row] = await dbx
		.select({
			id: images.id,
			objectKey: images.objectKey,
			version: images.version,
			variants: images.variants,
			backend: images.backend
		})
		.from(images)
		.where(
			and(
				eq(images.id, imageId),
				or(
					eq(images.ownerUserId, userId),
					exists(
						sql`(select 1 from ${recipes} where ${recipes.imageId} = ${images.id} and ${recipeReadableBy(userId)})`
					)
				)
			)
		)
		.limit(1);
	return row ?? null;
}

/** Delete an image the user owns when no recipe references it any more. */
export async function deleteImageIfUnreferenced(userId: string, imageId: string): Promise<boolean> {
	const rows = await withTransaction(async (tx) => {
		const candidates = await tx
			.select({ id: images.id })
			.from(images)
			.where(and(eq(images.id, imageId), eq(images.ownerUserId, userId)))
			.for('update');
		return deleteLockedUnreferencedImages(
			tx,
			candidates.map((row) => row.id)
		);
	});
	for (const row of rows) await deleteImageFiles(row.objectKey);
	return rows.length > 0;
}

/** Re-check references in a fresh statement after locking the image rows. */
async function deleteLockedUnreferencedImages(tx: Tx, ids: string[]) {
	if (!ids.length) return [];
	return tx
		.delete(images)
		.where(and(inArray(images.id, ids), unreferencedImage))
		.returning({ objectKey: images.objectKey });
}

/** Physical objects are removed only after their database deletion commits. */
async function deleteImageFiles(objectKey: string): Promise<void> {
	const store = storage();
	for (const variant of Object.keys(IMAGE_VARIANTS) as ImageVariant[]) {
		await store
			.delete(variantKey(objectKey, variant))
			.catch(() => console.warn('Image cleanup failed'));
	}
}

/**
 * Maintenance: remove image rows (and files) no recipe references. Never touches referenced images.
 * Lock bounded candidates without waiting on active claims, then re-check references.
 */
export async function cleanupUnreferencedImages(olderThanMinutes = 60): Promise<number> {
	const unreferenced = and(
		unreferencedImage,
		sql`${images.createdAt} < now() - make_interval(mins => ${olderThanMinutes})`
	);
	const rows = await withTransaction(async (tx) => {
		const candidates = await tx
			.select({ id: images.id })
			.from(images)
			.where(unreferenced)
			.orderBy(images.id)
			.limit(MEDIA_SWEEP_BATCH)
			.for('update', { skipLocked: true });
		return deleteLockedUnreferencedImages(
			tx,
			candidates.map((row) => row.id)
		);
	});
	for (const row of rows) await deleteImageFiles(row.objectKey);
	return rows.length;
}
