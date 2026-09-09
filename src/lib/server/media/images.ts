import { randomUUID } from 'node:crypto';
import { and, eq, or, exists, sql } from 'drizzle-orm';
import sharp, { type Metadata } from 'sharp';
import { db, type DbOrTx } from '$lib/server/db';
import { images, recipes } from '$lib/server/db/schema';
import { recipeReadableBy } from '$lib/server/access';
import { serverEnv } from '$lib/server/env';
import { AppError } from '$lib/server/errors';
import { storage } from './storage';

export const IMAGE_VARIANTS = {
	detail: { width: 1600, quality: 80 },
	thumb: { width: 480, quality: 74 }
} as const;
export type ImageVariant = keyof typeof IMAGE_VARIANTS;

const ALLOWED_INPUT = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif']);
const MAX_DIMENSION = 10000;

/** Tiny semaphore so image processing cannot exhaust CPU/memory under a burst of uploads. */
class Semaphore {
	private queue: (() => void)[] = [];
	private active = 0;
	constructor(private readonly max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
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

export function variantKey(objectKey: string, variant: ImageVariant): string {
	return `${objectKey}/${variant}.webp`;
}

/**
 * Validate bytes (real decoded format + dimensions + size), generate bounded
 * variants once, strip metadata, store them and record the image row.
 */
export async function storeRecipeImage(userId: string, file: File): Promise<string> {
	const env = serverEnv();
	if (file.size > env.UPLOAD_MAX_BYTES)
		throw new AppError(
			413,
			`Images must be under ${Math.round(env.UPLOAD_MAX_BYTES / 1024 / 1024)} MB`
		);
	if (file.size < 64) throw new AppError(400, 'That file does not look like an image');
	const buffer = Buffer.from(await file.arrayBuffer());
	semaphore ??= new Semaphore(env.IMAGE_CONCURRENCY);
	return semaphore.run(async () => {
		let meta: Metadata;
		try {
			meta = await sharp(buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION }).metadata();
		} catch {
			throw new AppError(400, 'That file could not be decoded as an image');
		}
		if (!meta.format || !ALLOWED_INPUT.has(meta.format) || !meta.width || !meta.height)
			throw new AppError(400, 'Use a JPEG, PNG, WebP, AVIF or GIF image');
		if (meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION)
			throw new AppError(400, 'Image dimensions are too large');
		const objectKey = `images/${userId.toLowerCase().replace(/[^a-z0-9_-]/g, '')}/${randomUUID()}`;
		const variants: Record<string, { width: number; height: number; bytes: number; mime: string }> =
			{};
		const store = storage();
		for (const [name, spec] of Object.entries(IMAGE_VARIANTS)) {
			const out = await sharp(buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION })
				.rotate()
				.resize({ width: spec.width, withoutEnlargement: true })
				.webp({ quality: spec.quality })
				.toBuffer({ resolveWithObject: true });
			await store.put(variantKey(objectKey, name as ImageVariant), out.data, 'image/webp');
			variants[name] = {
				width: out.info.width,
				height: out.info.height,
				bytes: out.info.size,
				mime: 'image/webp'
			};
		}
		const [row] = await db
			.insert(images)
			.values({
				ownerUserId: userId,
				backend: store.name,
				objectKey,
				version: 1,
				mime: meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`,
				sizeBytes: buffer.length,
				width: meta.width,
				height: meta.height,
				variants
			})
			.returning({ id: images.id });
		return row.id;
	});
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
	const [row] = await db
		.select({
			id: images.id,
			objectKey: images.objectKey,
			referenced: sql<boolean>`exists (select 1 from ${recipes} where ${recipes.imageId} = ${images.id})`
		})
		.from(images)
		.where(and(eq(images.id, imageId), eq(images.ownerUserId, userId)))
		.limit(1);
	if (!row || row.referenced) return false;
	await db.delete(images).where(eq(images.id, imageId));
	const store = storage();
	for (const variant of Object.keys(IMAGE_VARIANTS) as ImageVariant[]) {
		await store
			.delete(variantKey(row.objectKey, variant))
			.catch((err) => console.warn('image cleanup failed', row.objectKey, err));
	}
	return true;
}

/** Maintenance: remove image rows (and files) no recipe references. Never touches referenced images. */
export async function cleanupUnreferencedImages(olderThanMinutes = 60): Promise<number> {
	const rows = await db
		.select({ id: images.id, objectKey: images.objectKey })
		.from(images)
		.where(
			and(
				sql`not exists (select 1 from ${recipes} where ${recipes.imageId} = ${images.id})`,
				sql`${images.createdAt} < now() - make_interval(mins => ${olderThanMinutes})`
			)
		)
		.limit(500);
	const store = storage();
	let removed = 0;
	for (const row of rows) {
		await db.delete(images).where(eq(images.id, row.id));
		for (const variant of Object.keys(IMAGE_VARIANTS) as ImageVariant[]) {
			await store.delete(variantKey(row.objectKey, variant)).catch(() => {});
		}
		removed++;
	}
	return removed;
}
