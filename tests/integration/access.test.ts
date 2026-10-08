import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import type { RequestEvent } from '@sveltejs/kit';
import {
	catalogIngredientId,
	createUser,
	d,
	makeChickenRecipe,
	recipeInput,
	requestAs,
	resetDb
} from './helpers';
import {
	createRecipe,
	getRecipeDetail,
	listRecipes,
	parseListParams,
	setRecipeShare,
	updateRecipe
} from '$lib/server/recipes';
import {
	acceptInvite,
	createInvite,
	listMembers,
	peekInvite,
	removeMember,
	revokeInvite,
	setMemberRole
} from '$lib/server/households';
import { assertMember } from '$lib/server/access';
import { asAppError, isInvalidTextRepresentation } from '$lib/server/errors';
import { getPantryOverview } from '$lib/server/pantry';
import { searchIngredients, createCustomIngredient } from '$lib/server/ingredients';
import { load as cookLoad } from '../../src/routes/(app)/recipes/[id=uuid]/cook/+page.server';
import { actions as settingsActions } from '../../src/routes/(app)/settings/+page.server';

describe('identity, ownership and isolation', () => {
	beforeEach(resetDb);

	it('creates a personal household with owner role on registration', async () => {
		const alice = await createUser('Alice');
		const members = await listMembers(db, alice.householdId);
		expect(members).toHaveLength(1);
		expect(members[0].role).toBe('owner');
	});

	it('denies direct access to another user’s private recipe and allows it once shared with a common household', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const recipeId = await makeChickenRecipe(alice, 'Alice roast', '500');
		await expect(getRecipeDetail(db, bob.id, recipeId, bob.householdId)).rejects.toMatchObject({
			status: 404
		});

		const invite = await createInvite(db, alice.id, alice.householdId);
		expect((await peekInvite(db, invite.token))?.valid).toBe(true);
		await acceptInvite(bob.id, invite.token);
		await expect(acceptInvite(bob.id, invite.token)).rejects.toMatchObject({ status: 410 });

		await setRecipeShare(alice.id, recipeId, alice.householdId, true);
		const detail = await getRecipeDetail(db, bob.id, recipeId, alice.householdId);
		expect(detail.title).toBe('Alice roast');
		expect(detail.isOwner).toBe(false);
		// members can view but not edit
		await expect(
			updateRecipe(
				bob.id,
				recipeId,
				{ ...(await import('./helpers')).recipeInput({ ingredients: [] }), title: 'hacked' },
				null
			)
		).rejects.toMatchObject({ status: 404 });
		const listed = await listRecipes(
			db,
			bob.id,
			parseListParams(new URL('http://x/recipes')),
			null
		);
		expect(listed.items.map((r) => r.id)).toContain(recipeId);

		await setRecipeShare(alice.id, recipeId, alice.householdId, false);
		await expect(getRecipeDetail(db, bob.id, recipeId, alice.householdId)).rejects.toMatchObject({
			status: 404
		});
	});

	it('revoking membership denies subsequent household reads and writes', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const invite = await createInvite(db, alice.id, alice.householdId);
		await acceptInvite(bob.id, invite.token);
		await expect(assertMember(db, alice.householdId, bob.id)).resolves.toBe('member');
		await getPantryOverview(db, alice.householdId, { q: '', location: null, filter: 'all' });
		await removeMember(alice.id, alice.householdId, bob.id);
		await expect(assertMember(db, alice.householdId, bob.id)).rejects.toMatchObject({
			status: 403
		});
	});

	it('protects the final owner and supports ownership transfer', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const invite = await createInvite(db, alice.id, alice.householdId);
		await acceptInvite(bob.id, invite.token);
		await expect(removeMember(alice.id, alice.householdId, alice.id)).rejects.toMatchObject({
			status: 409
		});
		await expect(
			setMemberRole(alice.id, alice.householdId, alice.id, 'member')
		).rejects.toMatchObject({ status: 409 });
		await expect(setMemberRole(bob.id, alice.householdId, bob.id, 'owner')).rejects.toMatchObject({
			status: 403
		});
		await setMemberRole(alice.id, alice.householdId, bob.id, 'owner');
		await removeMember(alice.id, alice.householdId, alice.id);
		const members = await listMembers(db, alice.householdId);
		expect(members.map((m) => m.userId)).toEqual([bob.id]);
	});

	it('revoked and expired invites cannot be used', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const invite = await createInvite(db, alice.id, alice.householdId);
		await revokeInvite(db, alice.id, alice.householdId, invite.id);
		await expect(acceptInvite(bob.id, invite.token)).rejects.toMatchObject({ status: 410 });
		await expect(createInvite(db, bob.id, alice.householdId)).rejects.toMatchObject({
			status: 403
		});
	});

	it('autocomplete never exposes another user’s private custom ingredient names', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		await createCustomIngredient(db, alice.id, 'Grandma Zsuzsa secret paprika blend');
		const forAlice = await searchIngredients(db, alice.id, 'grandma');
		const forBob = await searchIngredients(db, bob.id, 'grandma');
		expect(forAlice.map((s) => s.name)).toContain('Grandma Zsuzsa secret paprika blend');
		expect(forBob).toHaveLength(0);
		const catalog = await searchIngredients(db, bob.id, 'scall');
		expect(catalog[0]?.name).toBe('green onion');
		expect(catalog[0]?.matchedAlias).toBe('scallion');
	});

	it('maps a malformed uuid to a 404 instead of leaking a driver error', async () => {
		const alice = await createUser('Alice');
		const err = await assertMember(db, 'not-a-uuid', alice.id).catch((e) => e);
		expect(isInvalidTextRepresentation(err)).toBe(true);
		expect(asAppError(err)?.status).toBe(404);
	});
});

describe('a stale active household in locals', () => {
	beforeEach(resetDb);

	it('cook page: checks membership before it reads the pantry stock', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		// No servings: not cookable, so the load does not call previewCooking.
		const recipeId = await createRecipe(
			bob.id,
			recipeInput({
				title: 'Bob soup',
				baseServings: null,
				ingredients: [
					{
						position: 0,
						name: 'chicken breast',
						ingredientId: await catalogIngredientId('chicken breast'),
						amount: d('200'),
						unit: 'g',
						preparation: '',
						groupName: '',
						optional: false,
						createIdentity: false
					}
				]
			})
		);
		const event = {
			...requestAs(bob, alice.householdId),
			params: { id: recipeId },
			url: new URL(`http://localhost/recipes/${recipeId}/cook`),
			depends: () => {}
		} as unknown as RequestEvent;
		await expect(cookLoad(event as never)).rejects.toMatchObject({ status: 403 });
	});

	it('settings consistency check: checks membership before it reads the report', async () => {
		const alice = await createUser('Alice');
		const bob = await createUser('Bob');
		const event = {
			...requestAs(bob, alice.householdId),
			request: new Request('http://localhost/settings?/consistency', { method: 'POST' })
		} as unknown as RequestEvent;
		const out = (await settingsActions.consistency!(event as never)) as unknown as {
			status?: number;
			data?: { form?: string };
		};
		expect(out.status).toBe(403);
		expect(out.data?.form).toBe('consistency');
	});
});
