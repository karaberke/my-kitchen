import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { createUser, recipeInput, resetDb, type TestUser } from './helpers';
import { createRecipe } from '$lib/server/recipes';
import { cleanupOperations } from '$lib/server/operations';
import {
	attachToRecipe,
	cleanupUnreferencedAttachments,
	storeAttachment
} from '$lib/server/media/attachments';
import { cleanupUnreferencedImages } from '$lib/server/media/images';
import { images, operations, recipeAttachments, recipes } from '$lib/server/db/schema';

/* The hourly sweep of unreferenced images, attachments and operation records. */
describe('sweep', () => {
	let alice: TestUser;

	beforeAll(async () => {
		await resetDb();
		alice = await createUser('Alice');
	});

	it('sweeps unreferenced attachments but never referenced ones', async () => {
		const orphan = await storeAttachment(alice.id, {
			bytes: Buffer.from('<html>abandoned import</html>'),
			filename: 'abandoned.html',
			kind: 'html'
		});
		const kept = await storeAttachment(alice.id, {
			bytes: Buffer.from('<html>kept</html>'),
			filename: 'kept.html',
			kind: 'html'
		});
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({ title: 'Has a source', ingredients: [] })
		);
		await attachToRecipe(db, alice.id, recipeId, kept);

		// Backdate both past the grace window.
		await db
			.update(recipeAttachments)
			.set({ createdAt: sql`now() - interval '2 hours'` })
			.where(eq(recipeAttachments.ownerUserId, alice.id));

		await cleanupUnreferencedAttachments(60);

		const left = await db
			.select({ id: recipeAttachments.id })
			.from(recipeAttachments)
			.where(eq(recipeAttachments.ownerUserId, alice.id));
		const ids = left.map((r) => r.id);
		expect(ids).toContain(kept);
		expect(ids).not.toContain(orphan);
	});

	it('sweeps old unreferenced images and keeps referenced or recent ones', async () => {
		const row = (key: string) => ({
			ownerUserId: alice.id,
			backend: 'local' as const,
			objectKey: `images/test/${key}`,
			mime: 'image/webp',
			sizeBytes: 100,
			width: 1,
			height: 1,
			variants: {}
		});
		const [orphan, used, fresh] = await db
			.insert(images)
			.values([row('orphan'), row('used'), row('fresh')])
			.returning({ id: images.id });
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({ title: 'Has a photo', ingredients: [] })
		);
		await db.update(recipes).set({ imageId: used.id }).where(eq(recipes.id, recipeId));
		await db
			.update(images)
			.set({ createdAt: sql`now() - interval '2 hours'` })
			.where(sql`${images.id} in (${orphan.id}, ${used.id})`);

		expect(await cleanupUnreferencedImages(60)).toBeGreaterThanOrEqual(1);

		const ids = (
			await db.select({ id: images.id }).from(images).where(eq(images.ownerUserId, alice.id))
		).map((r) => r.id);
		expect(ids).not.toContain(orphan.id);
		expect(ids).toContain(used.id);
		expect(ids).toContain(fresh.id);
		const [recipe] = await db
			.select({ imageId: recipes.imageId })
			.from(recipes)
			.where(eq(recipes.id, recipeId));
		expect(recipe.imageId).toBe(used.id);
	});

	it('sweeps images and operations without touching recent rows', async () => {
		await expect(cleanupUnreferencedImages(60)).resolves.toBeGreaterThanOrEqual(0);

		await db.insert(operations).values({
			id: crypto.randomUUID(),
			userId: alice.id,
			kind: 'test',
			fingerprint: 'old',
			result: {}
		});
		const fresh = crypto.randomUUID();
		await db
			.insert(operations)
			.values({ id: fresh, userId: alice.id, kind: 'test', fingerprint: 'fresh', result: {} });
		await db
			.update(operations)
			.set({ createdAt: sql`now() - interval '90 days'` })
			.where(eq(operations.fingerprint, 'old'));

		const removed = await cleanupOperations(30);
		expect(removed).toBe(1);
		const survivor = await db.select().from(operations).where(eq(operations.id, fresh));
		expect(survivor).toHaveLength(1);
	});
});
