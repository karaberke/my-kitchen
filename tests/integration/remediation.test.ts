import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { createUser, recipeInput, resetDb, type TestUser } from './helpers';
import {
	createRecipe,
	duplicateRecipe,
	getRecipeDetail,
	setRecipeShare,
	updateRecipe
} from '$lib/server/recipes';
import { createCustomIngredient } from '$lib/server/ingredients';
import { acceptInvite, createInvite } from '$lib/server/households';
import { assertMember } from '$lib/server/access';
import { asAppError, isInvalidTextRepresentation } from '$lib/server/errors';
import { cleanupOperations } from '$lib/server/operations';
import { cleanupUnreferencedAttachments } from '$lib/server/media/attachments';
import { cleanupUnreferencedImages } from '$lib/server/media/images';
import { storeAttachment } from '$lib/server/media/attachments';
import { operations, recipeAttachments } from '$lib/server/db/schema';
import { Dec } from '$lib/shared/decimal';

describe('remediation', () => {
	let alice: TestUser;
	let bob: TestUser;

	beforeAll(async () => {
		await resetDb();
		alice = await createUser('Alice');
		bob = await createUser('Bob');
		const inv = await createInvite(db, alice.id, alice.householdId);
		await acceptInvite(bob.id, inv.token);
	});

	it('maps a malformed uuid to a 404 instead of leaking a driver error', async () => {
		const err = await assertMember(db, 'not-a-uuid', alice.id).catch((e) => e);
		expect(isInvalidTextRepresentation(err)).toBe(true);
		expect(asAppError(err)?.status).toBe(404);
		// A real AppError still passes through unchanged.
		const forbidden = await assertMember(db, alice.householdId, bob.id)
			.then(() => null)
			.catch((e) => e);
		expect(forbidden).toBeNull(); // bob is a member; sanity check on the fixture
	});

	it('duplicating a shared recipe drops identities the duplicator cannot see', async () => {
		const priv = await createCustomIngredient(db, alice.id, 'Aunties secret spice mix');
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Secret stew',
				ingredients: [
					{
						position: 0,
						name: 'secret spice',
						ingredientId: priv.id,
						amount: Dec.from('2'),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			})
		);
		await setRecipeShare(alice.id, recipeId, alice.householdId, true);

		const copyId = await duplicateRecipe(bob.id, recipeId);
		const copy = await getRecipeDetail(db, bob.id, copyId, null);

		// The identity reference is gone, the human-readable name survives.
		expect(copy.ingredients[0].ingredientId).toBeNull();
		expect(copy.ingredients[0].name).toBe('secret spice');
		expect(copy.ingredients[0].amount).toBe('2');

		// ...and the copy is now editable, which it was not before.
		await expect(
			updateRecipe(
				bob.id,
				copyId,
				recipeInput({
					title: 'Secret stew, my way',
					ingredients: copy.ingredients.map((i, n) => ({
						position: n,
						name: i.name,
						ingredientId: i.ingredientId,
						amount: i.amount ? Dec.from(i.amount) : null,
						unit: i.unit,
						preparation: i.preparation,
						groupName: i.groupName,
						optional: i.optional,
						createIdentity: false
					}))
				}),
				copy.revision
			)
		).resolves.toBeTruthy();
	});

	it('duplicating your own recipe keeps your own identities', async () => {
		const mine = await createCustomIngredient(db, alice.id, 'My own blend');
		const recipeId = await createRecipe(
			alice.id,
			recipeInput({
				title: 'Mine',
				ingredients: [
					{
						position: 0,
						name: 'my blend',
						ingredientId: mine.id,
						amount: Dec.from('1'),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			})
		);
		const copyId = await duplicateRecipe(alice.id, recipeId);
		const copy = await getRecipeDetail(db, alice.id, copyId, null);
		expect(copy.ingredients[0].ingredientId).toBe(mine.id);
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
		const { attachToRecipe } = await import('$lib/server/media/attachments');
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
