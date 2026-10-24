import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { client, db } from '$lib/server/db';
import { images, recipeAttachments, recipes } from '$lib/server/db/schema';
import {
	acceptInvite,
	createInvite,
	listMembers,
	removeMember,
	setMemberRole
} from '$lib/server/households';
import { createRecipe, duplicateRecipe } from '$lib/server/recipes';
import {
	cleanupUnreferencedImages,
	deleteImageIfUnreferenced,
	IMAGE_VARIANTS,
	storeRecipeImage,
	variantKey
} from '$lib/server/media/images';
import { cleanupUnreferencedAttachments, storeAttachment } from '$lib/server/media/attachments';
import { storage } from '$lib/server/media/storage';
import {
	createUser,
	holdDatabaseTransaction,
	makeChickenRecipe,
	recipeInput,
	resetDb
} from './helpers';

beforeEach(resetDb);

describe('household owner invariants under concurrent writes', () => {
	it.each([
		['demote', 'demote'],
		['leave', 'leave'],
		['demote', 'leave']
	] as const)('keeps an owner during concurrent %s and %s', async (first, second) => {
		expect(
			client.options.max,
			'concurrency tests need at least two app connections'
		).toBeGreaterThanOrEqual(2);
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		await setMemberRole(alice.id, alice.householdId, bob.id, 'owner');
		const gate = await holdDatabaseTransaction(
			(tx) => tx`lock table household_member in share mode`
		);
		const mutate = (id: string, action: 'demote' | 'leave') =>
			action === 'demote'
				? setMemberRole(id, alice.householdId, id, 'member')
				: removeMember(id, alice.householdId, id);
		const results = Promise.allSettled([mutate(alice.id, first), mutate(bob.id, second)]);
		try {
			await gate.waitForBlocked(2);
		} finally {
			await gate.release();
			await results;
		}
		const outcomes = await results;
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
		expect(failures).toHaveLength(1);
		expect(failures[0].reason).toMatchObject({ status: 409 });
		expect(
			(await listMembers(db, alice.householdId)).filter((m) => m.role === 'owner')
		).toHaveLength(1);
	});
});

describe('recipe authorization while source locks are in flight', () => {
	it('refuses a copy after sharing is revoked while waiting for the source lock', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await acceptInvite(bob.id, (await createInvite(db, alice.id, alice.householdId)).token);
		const recipeId = await makeChickenRecipe(alice, 'Originally shared roast', '500');
		const gate = await holdDatabaseTransaction(async (tx) => {
			await tx`update recipe set title = 'PRIVATE COPY TITLE', revision = revision + 1
				where id = ${recipeId}`;
			await tx`delete from recipe_share where recipe_id = ${recipeId}`;
			await tx`update recipe_ingredient set name = 'PRIVATE COPY INGREDIENT',
				ingredient_id = null, amount = 99 where recipe_id = ${recipeId}`;
		});
		const copying = duplicateRecipe(bob.id, recipeId);
		const settled = Promise.allSettled([copying]);
		try {
			await gate.waitForBlocked();
		} finally {
			await gate.release();
			await settled;
		}
		await expect(copying).rejects.toMatchObject({ status: 404 });
	});
});

describe('media claimed while cleanup is in flight', () => {
	it.each(['delete', 'sweep'] as const)('keeps image data claimed during %s', async (kind) => {
		const alice = await createUser('Alice');
		const bytes = await sharp({
			create: { width: 8, height: 8, channels: 3, background: '#35875a' }
		})
			.png()
			.toBuffer();
		const imageId = await storeRecipeImage(
			alice.id,
			new File([new Uint8Array(bytes)], 'photo.png')
		);
		const [image] = await db.select().from(images).where(eq(images.id, imageId));
		await db
			.update(images)
			.set({ createdAt: sql`now() - interval '2 hours'` })
			.where(eq(images.id, imageId));
		const recipeId = await createRecipe(alice.id, recipeInput({ ingredients: [] }));
		const gate = await holdDatabaseTransaction(
			(tx) => tx`update recipe set image_id = ${imageId} where id = ${recipeId}`
		);
		let completed = false;
		const removal = (
			kind === 'delete'
				? deleteImageIfUnreferenced(alice.id, imageId)
				: cleanupUnreferencedImages(60)
		).finally(() => {
			completed = true;
		});
		const settled = Promise.allSettled([removal]);
		try {
			await gate.waitForBlocked(1, () => completed);
		} finally {
			await gate.release();
			await settled;
		}
		await expect(removal).resolves.toBe(kind === 'delete' ? false : 0);
		const [recipe] = await db.select().from(recipes).where(eq(recipes.id, recipeId));
		expect(recipe.imageId).toBe(imageId);
		expect(await db.select().from(images).where(eq(images.id, imageId))).toHaveLength(1);
		for (const variant of Object.keys(IMAGE_VARIANTS) as (keyof typeof IMAGE_VARIANTS)[]) {
			const object = await storage().get(variantKey(image.objectKey, variant));
			expect(object).not.toBeNull();
			if (object)
				expect((await new Response(object.stream).arrayBuffer()).byteLength).toBeGreaterThan(0);
		}
	});

	it('keeps an attachment claimed while its sweep is in flight', async () => {
		const alice = await createUser('Alice');
		const attachmentId = await storeAttachment(alice.id, {
			bytes: Buffer.from('<html>saved source</html>'),
			filename: 'source.html',
			kind: 'html'
		});
		const [attachment] = await db
			.select()
			.from(recipeAttachments)
			.where(eq(recipeAttachments.id, attachmentId));
		await db
			.update(recipeAttachments)
			.set({ createdAt: sql`now() - interval '2 hours'` })
			.where(eq(recipeAttachments.id, attachmentId));
		const recipeId = await createRecipe(alice.id, recipeInput({ ingredients: [] }));
		const gate = await holdDatabaseTransaction(
			(tx) => tx`update recipe set source_attachment_id = ${attachmentId} where id = ${recipeId}`
		);
		let completed = false;
		const removal = cleanupUnreferencedAttachments(60).finally(() => {
			completed = true;
		});
		const settled = Promise.allSettled([removal]);
		try {
			await gate.waitForBlocked(1, () => completed);
		} finally {
			await gate.release();
			await settled;
		}
		await expect(removal).resolves.toBe(0);
		const [recipe] = await db.select().from(recipes).where(eq(recipes.id, recipeId));
		expect(recipe.sourceAttachmentId).toBe(attachmentId);
		expect(
			await db.select().from(recipeAttachments).where(eq(recipeAttachments.id, attachmentId))
		).toHaveLength(1);
		const object = await storage().get(attachment.objectKey);
		expect(object).not.toBeNull();
		if (object) expect(await new Response(object.stream).text()).toBe('<html>saved source</html>');
	});

	it('does not delete missing, foreign, or already-referenced images', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await expect(deleteImageIfUnreferenced(alice.id, crypto.randomUUID())).resolves.toBe(false);
		const [image] = await db
			.insert(images)
			.values({
				ownerUserId: alice.id,
				backend: 'local',
				objectKey: `images/test/${crypto.randomUUID()}`,
				mime: 'image/webp',
				sizeBytes: 100,
				width: 1,
				height: 1,
				variants: {}
			})
			.returning();
		await expect(deleteImageIfUnreferenced(bob.id, image.id)).resolves.toBe(false);
		const recipeId = await createRecipe(alice.id, recipeInput({ ingredients: [] }), image.id);
		const [recipe] = await db.select().from(recipes).where(eq(recipes.id, recipeId));
		expect(recipe.imageId).toBe(image.id);
		await expect(deleteImageIfUnreferenced(alice.id, image.id)).resolves.toBe(false);
		expect(await db.select().from(images).where(eq(images.id, image.id))).toHaveLength(1);
	});
});
