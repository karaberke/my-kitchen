import { and, eq, sql } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '$lib/server/db';
import {
	householdMembers,
	recipeFavorites,
	recipeIngredients,
	recipeShares,
	recipeSteps,
	recipes,
	user
} from '$lib/server/db/schema';
import { assertRecipeOwner, assertRecipeReadable, recipeReadableBy } from '$lib/server/access';
import { getActiveHouseholdId } from '$lib/server/households';
import { assertIngredientsVisible } from '$lib/server/ingredients';
import { AppError, ReviewConflict, notFound } from '$lib/server/errors';
import { Dec } from '$lib/shared/decimal';
import type { RecipeFormInput, ValidRecipe } from '$lib/shared/recipe-input';
import { withTransaction } from '$lib/server/operations';
import type { RecipeDetail } from './detail';

/** A stored recipe as the edit form's input, ready to save back unchanged. */
export function recipeToFormInput(recipe: RecipeDetail): RecipeFormInput {
	return {
		title: recipe.title,
		description: recipe.description,
		baseServings: recipe.baseServings ? Dec.from(recipe.baseServings).toHuman() : '',
		yieldNote: recipe.yieldNote,
		prepMinutes: recipe.prepMinutes?.toString() ?? '',
		cookMinutes: recipe.cookMinutes?.toString() ?? '',
		source: recipe.source,
		notes: recipe.notes,
		tags: recipe.tags.join(', '),
		convention: recipe.convention,
		ingredients: recipe.ingredients.map((i) => ({
			name: i.name,
			ingredientId: i.ingredientId,
			amount: i.amount ? Dec.from(i.amount).toString() : '',
			unit: i.unit ?? '',
			preparation: i.preparation,
			group: i.groupName,
			optional: i.optional,
			createIdentity: false
		})),
		steps: recipe.steps.map((s) => ({ section: s.sectionTitle, text: s.text })),
		intent: 'save',
		expectedRevision: recipe.revision,
		removeImage: false,
		// Always empty: the picture the recipe has is shown as a picture, not as a
		// link, and a link left here would be downloaded again on every save.
		imageUrl: ''
	};
}

async function writeRows(tx: Tx, recipeId: string, value: ValidRecipe) {
	await tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, recipeId));
	await tx.delete(recipeSteps).where(eq(recipeSteps.recipeId, recipeId));
	if (value.ingredients.length) {
		await tx.insert(recipeIngredients).values(
			value.ingredients.map((i) => ({
				recipeId,
				position: i.position,
				groupName: i.groupName,
				ingredientId: i.ingredientId,
				name: i.name,
				amount: i.amount ? i.amount.toDb() : null,
				unit: i.unit,
				preparation: i.preparation,
				optional: i.optional
			}))
		);
	}
	if (value.steps.length) {
		await tx.insert(recipeSteps).values(
			value.steps.map((s) => ({
				recipeId,
				position: s.position,
				sectionTitle: s.sectionTitle,
				text: s.text
			}))
		);
	}
}

export async function createRecipe(
	userId: string,
	value: ValidRecipe,
	imageId: string | null = null
): Promise<string> {
	return withTransaction(async (tx) => {
		await assertIngredientsVisible(
			tx,
			userId,
			value.ingredients.map((i) => i.ingredientId).filter((x): x is string => !!x)
		);
		const [row] = await tx
			.insert(recipes)
			.values({
				ownerUserId: userId,
				title: value.title,
				description: value.description,
				baseServings: value.baseServings ? value.baseServings.toDb() : null,
				yieldNote: value.yieldNote,
				prepMinutes: value.prepMinutes,
				cookMinutes: value.cookMinutes,
				source: value.source,
				notes: value.notes,
				tags: value.tags,
				convention: value.convention,
				status: value.status,
				imageId
			})
			.returning({ id: recipes.id });
		await writeRows(tx, row.id, value);
		await shareWithActiveHousehold(tx, userId, row.id);
		return row.id;
	});
}

/**
 * A recipe belongs to the kitchen its author was standing in: every new recipe is
 * shared with the author's active household at birth. Sharing later remains the
 * owner's call — an edit never re-shares what they unshared.
 */
async function shareWithActiveHousehold(tx: DbOrTx, userId: string, recipeId: string) {
	const householdId = await getActiveHouseholdId(tx, userId);
	if (!householdId) return;
	await tx.insert(recipeShares).values({ recipeId, householdId }).onConflictDoNothing();
}

/** Update with optimistic concurrency: the expected revision must match. */
export async function updateRecipe(
	userId: string,
	recipeId: string,
	value: ValidRecipe,
	expectedRevision: number | null,
	image: { set?: string | null } = {}
): Promise<{ revision: number; previousImageId: string | null }> {
	return withTransaction(async (tx) => {
		const [current] = await tx
			.select({
				id: recipes.id,
				revision: recipes.revision,
				imageId: recipes.imageId,
				status: recipes.status
			})
			.from(recipes)
			.where(and(eq(recipes.id, recipeId), eq(recipes.ownerUserId, userId)))
			.for('update');
		if (!current) throw notFound('Recipe not found');
		if (expectedRevision !== null && expectedRevision !== current.revision) {
			throw new ReviewConflict(
				'This recipe was changed elsewhere since you opened it. Review the latest version before saving again.',
				{
					currentRevision: current.revision
				}
			);
		}
		await assertIngredientsVisible(
			tx,
			userId,
			value.ingredients.map((i) => i.ingredientId).filter((x): x is string => !!x)
		);
		const status =
			current.status === 'archived' && value.status === 'draft' ? 'draft' : value.status;
		const [updated] = await tx
			.update(recipes)
			.set({
				title: value.title,
				description: value.description,
				baseServings: value.baseServings ? value.baseServings.toDb() : null,
				yieldNote: value.yieldNote,
				prepMinutes: value.prepMinutes,
				cookMinutes: value.cookMinutes,
				source: value.source,
				notes: value.notes,
				tags: value.tags,
				convention: value.convention,
				status,
				imageId: image.set === undefined ? current.imageId : image.set,
				revision: sql`${recipes.revision} + 1`,
				updatedAt: sql`now()`
			})
			.where(eq(recipes.id, recipeId))
			.returning({ revision: recipes.revision });
		await writeRows(tx, recipeId, value);
		return {
			revision: updated.revision,
			previousImageId: image.set === undefined ? null : current.imageId
		};
	});
}

export async function duplicateRecipe(userId: string, recipeId: string): Promise<string> {
	return withTransaction(async (tx) => {
		const [src] = await tx
			.select({
				id: recipes.id,
				ownerUserId: recipes.ownerUserId,
				ownerName: user.name,
				title: recipes.title,
				description: recipes.description,
				baseServings: recipes.baseServings,
				yieldNote: recipes.yieldNote,
				prepMinutes: recipes.prepMinutes,
				cookMinutes: recipes.cookMinutes,
				source: recipes.source,
				notes: recipes.notes,
				tags: recipes.tags,
				convention: recipes.convention,
				status: recipes.status,
				imageId: recipes.imageId
			})
			.from(recipes)
			.innerJoin(user, eq(user.id, recipes.ownerUserId))
			.where(and(eq(recipes.id, recipeId), recipeReadableBy(userId)))
			.limit(1);
		if (!src) throw notFound('Recipe not found');
		const own = src.ownerUserId === userId;
		const [created] = await tx
			.insert(recipes)
			.values({
				ownerUserId: userId,
				title: own ? `${src.title} (copy)` : src.title,
				description: src.description,
				baseServings: src.baseServings,
				yieldNote: src.yieldNote,
				prepMinutes: src.prepMinutes,
				cookMinutes: src.cookMinutes,
				source: src.source,
				notes: src.notes,
				tags: src.tags,
				convention: src.convention,
				status: src.status === 'archived' ? 'active' : src.status,
				imageId: own ? src.imageId : null,
				sourceRecipeId: src.id,
				sourceAttribution: own ? '' : `Duplicated from “${src.title}” shared by ${src.ownerName}`
			})
			.returning({ id: recipes.id });
		// Identities the duplicator cannot see are dropped, keeping the ingredient's
		// name (which the recipe stores by value). Copying the id verbatim pointed the
		// new recipe at the sharer's private identity, and assertIngredientsVisible
		// then refused every later save — a copy that could never be edited.
		await tx.execute(sql`insert into recipe_ingredient (recipe_id, position, group_name, ingredient_id, name, amount, unit, preparation, optional)
			select ${created.id}, position, group_name,
				case when ingredient_id in (
					select id from ingredient where owner_user_id is null or owner_user_id = ${userId}
				) then ingredient_id end,
				name, amount, unit, preparation, optional
			from recipe_ingredient where recipe_id = ${src.id}`);
		await tx.execute(sql`insert into recipe_step (recipe_id, position, section_title, text)
			select ${created.id}, position, section_title, text from recipe_step where recipe_id = ${src.id}`);
		await shareWithActiveHousehold(tx, userId, created.id);
		return created.id;
	});
}

export async function deleteRecipe(userId: string, recipeId: string): Promise<void> {
	await assertRecipeOwner(db, recipeId, userId);
	await db.delete(recipes).where(and(eq(recipes.id, recipeId), eq(recipes.ownerUserId, userId)));
}

export async function setRecipeArchived(
	userId: string,
	recipeId: string,
	archived: boolean
): Promise<void> {
	const current = await assertRecipeOwner(db, recipeId, userId);
	const status = archived ? 'archived' : current.status === 'archived' ? 'active' : current.status;
	await db
		.update(recipes)
		.set({ status, updatedAt: sql`now()` })
		.where(eq(recipes.id, recipeId));
}

export async function setRecipeShare(
	userId: string,
	recipeId: string,
	householdId: string,
	shared: boolean
): Promise<void> {
	await withTransaction(async (tx) => {
		await assertRecipeOwner(tx, recipeId, userId);
		const [member] = await tx
			.select({ role: householdMembers.role })
			.from(householdMembers)
			.where(
				and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId))
			)
			.limit(1);
		if (!member) throw new AppError(403, 'You can only share with households you belong to');
		if (shared)
			await tx.insert(recipeShares).values({ recipeId, householdId }).onConflictDoNothing();
		else
			await tx
				.delete(recipeShares)
				.where(and(eq(recipeShares.recipeId, recipeId), eq(recipeShares.householdId, householdId)));
	});
}

export async function setFavorite(
	userId: string,
	recipeId: string,
	favorite: boolean
): Promise<void> {
	await assertRecipeReadable(db, recipeId, userId);
	if (favorite) await db.insert(recipeFavorites).values({ userId, recipeId }).onConflictDoNothing();
	else
		await db
			.delete(recipeFavorites)
			.where(and(eq(recipeFavorites.userId, userId), eq(recipeFavorites.recipeId, recipeId)));
}
