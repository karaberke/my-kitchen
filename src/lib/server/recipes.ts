import { and, asc, desc, eq, exists, inArray, ne, sql } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '$lib/server/db';
import {
	householdMembers,
	images,
	recipeFavorites,
	recipeIngredients,
	recipeShares,
	recipeSteps,
	recipeAttachments,
	recipes,
	stockLots,
	user
} from '$lib/server/db/schema';
import { assertRecipeOwner, assertRecipeReadable, recipeReadableBy } from '$lib/server/access';
import { assertIngredientsVisible, getIngredientMeta } from '$lib/server/ingredients';
import { AppError, ReviewConflict, notFound } from '$lib/server/errors';
import { Dec } from '$lib/shared/decimal';
import { UNITS, convertAmount, unitsCompatible, type Convention } from '$lib/shared/units';
import type { ValidRecipe } from '$lib/shared/recipe-input';
import { withTransaction } from '$lib/server/operations';

export const RECIPES_PER_PAGE = 24;
export const RECIPES_PER_PAGE_MAX = 100;

export interface RecipeListParams {
	page: number;
	perPage: number;
	q: string;
	tag: string | null;
	favorites: boolean;
	scope: 'all' | 'mine' | 'shared';
	status: 'active' | 'draft' | 'archived' | 'all';
}

export interface RecipeCard {
	id: string;
	title: string;
	description: string;
	baseServings: string | null;
	yieldNote: string;
	prepMinutes: number | null;
	cookMinutes: number | null;
	tags: string[];
	status: string;
	isOwner: boolean;
	ownerName: string;
	isFavorite: boolean;
	image: { id: string; version: number; thumb: { width: number; height: number } } | null;
	updatedAt: string;
}

function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function parseListParams(url: URL): RecipeListParams {
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const perPage = Math.min(
		RECIPES_PER_PAGE_MAX,
		Math.max(1, Number(url.searchParams.get('perPage') ?? RECIPES_PER_PAGE) || RECIPES_PER_PAGE)
	);
	const scopeRaw = url.searchParams.get('scope');
	const statusRaw = url.searchParams.get('status');
	return {
		page,
		perPage,
		q: (url.searchParams.get('q') ?? '').trim().slice(0, 100),
		tag: (url.searchParams.get('tag') ?? '').trim().slice(0, 40) || null,
		favorites: url.searchParams.get('favorites') === '1',
		scope: scopeRaw === 'mine' || scopeRaw === 'shared' ? scopeRaw : 'all',
		status:
			statusRaw === 'draft' || statusRaw === 'archived' || statusRaw === 'all'
				? statusRaw
				: 'active'
	};
}

export async function listRecipes(dbx: DbOrTx, userId: string, params: RecipeListParams) {
	const conds = [recipeReadableBy(userId)];
	if (params.q) conds.push(sql`${recipes.title} ilike ${'%' + escapeLike(params.q) + '%'}`);
	if (params.tag) conds.push(sql`${recipes.tags} @> array[${params.tag}]::text[]`);
	if (params.favorites)
		conds.push(
			exists(
				sql`(select 1 from ${recipeFavorites} f where f.recipe_id = ${recipes.id} and f.user_id = ${userId})`
			)
		);
	if (params.scope === 'mine') conds.push(eq(recipes.ownerUserId, userId));
	if (params.scope === 'shared') conds.push(ne(recipes.ownerUserId, userId));
	if (params.status === 'active') conds.push(inArray(recipes.status, ['active', 'draft']));
	else if (params.status !== 'all') conds.push(eq(recipes.status, params.status));
	const where = and(...conds);
	const offset = (params.page - 1) * params.perPage;

	const [rows, [{ total }]] = await Promise.all([
		dbx
			.select({
				id: recipes.id,
				title: recipes.title,
				description: recipes.description,
				baseServings: recipes.baseServings,
				yieldNote: recipes.yieldNote,
				prepMinutes: recipes.prepMinutes,
				cookMinutes: recipes.cookMinutes,
				tags: recipes.tags,
				status: recipes.status,
				ownerUserId: recipes.ownerUserId,
				ownerName: user.name,
				updatedAt: recipes.updatedAt,
				isFavorite: sql<boolean>`exists (select 1 from ${recipeFavorites} f where f.recipe_id = ${recipes.id} and f.user_id = ${userId})`,
				imageId: images.id,
				imageVersion: images.version,
				imageVariants: images.variants
			})
			.from(recipes)
			.innerJoin(user, eq(user.id, recipes.ownerUserId))
			.leftJoin(images, eq(images.id, recipes.imageId))
			.where(where)
			.orderBy(desc(recipes.updatedAt), desc(recipes.id))
			.limit(params.perPage)
			.offset(offset),
		dbx
			.select({ total: sql<number>`count(*)::int` })
			.from(recipes)
			.where(where)
	]);

	const items: RecipeCard[] = rows.map((r) => ({
		id: r.id,
		title: r.title,
		description: r.description.length > 140 ? r.description.slice(0, 137) + '…' : r.description,
		baseServings: r.baseServings,
		yieldNote: r.yieldNote,
		prepMinutes: r.prepMinutes,
		cookMinutes: r.cookMinutes,
		tags: r.tags,
		status: r.status,
		isOwner: r.ownerUserId === userId,
		ownerName: r.ownerName,
		isFavorite: r.isFavorite,
		image:
			r.imageId && r.imageVariants?.thumb
				? {
						id: r.imageId,
						version: r.imageVersion ?? 1,
						thumb: { width: r.imageVariants.thumb.width, height: r.imageVariants.thumb.height }
					}
				: null,
		updatedAt: r.updatedAt
	}));
	return {
		items,
		total,
		page: params.page,
		perPage: params.perPage,
		pageCount: Math.max(1, Math.ceil(total / params.perPage))
	};
}

/** The meal picker needs no images, favorites, owner join or pagination count. */
export async function listRecipeOptions(dbx: DbOrTx, userId: string) {
	return dbx
		.select({
			id: recipes.id,
			title: recipes.title,
			prepMinutes: recipes.prepMinutes,
			cookMinutes: recipes.cookMinutes,
			baseServings: recipes.baseServings
		})
		.from(recipes)
		.where(and(recipeReadableBy(userId), inArray(recipes.status, ['active', 'draft'])))
		.orderBy(desc(recipes.updatedAt), desc(recipes.id))
		.limit(100);
}

export async function listUserTags(dbx: DbOrTx, userId: string, limit = 40): Promise<string[]> {
	const rows = await dbx
		.select({ tag: sql<string>`t.tag`, n: sql<number>`count(*)::int` })
		.from(sql`${recipes}, unnest(${recipes.tags}) as t(tag)`)
		.where(recipeReadableBy(userId))
		.groupBy(sql`t.tag`)
		.orderBy(sql`count(*) desc`, sql`t.tag asc`)
		.limit(limit);
	return rows.map((r) => r.tag);
}

export interface RecipeIngredientView {
	id: string;
	position: number;
	groupName: string;
	ingredientId: string | null;
	name: string;
	amount: string | null;
	unit: string | null;
	preparation: string;
	optional: boolean;
	ingredientCategory: string | null;
	/** stock of this ingredient in the household expressed in the ingredient's unit, null when not convertible/untracked */
	stockAvailable: string | null;
	stockOther: { quantity: string; unit: string }[];
}

export interface RecipeDetail {
	id: string;
	title: string;
	description: string;
	baseServings: string | null;
	yieldNote: string;
	prepMinutes: number | null;
	cookMinutes: number | null;
	source: string;
	notes: string;
	tags: string[];
	convention: Convention;
	status: string;
	revision: number;
	isOwner: boolean;
	ownerName: string;
	isFavorite: boolean;
	sourceAttribution: string;
	/** the imported file this recipe was read from, openable by anyone who can read the recipe */
	sourceFile: { id: string; filename: string; pageCount: number | null } | null;
	image: {
		id: string;
		version: number;
		variants: Record<string, { width: number; height: number }>;
	} | null;
	ingredients: RecipeIngredientView[];
	steps: { id: string; position: number; sectionTitle: string; text: string }[];
	/** households the viewer belongs to, with share flag (owner only) */
	shares: { householdId: string; name: string; shared: boolean }[];
	createdAt: string;
	updatedAt: string;
	cookable: boolean;
}

export async function getRecipeDetail(
	dbx: DbOrTx,
	userId: string,
	recipeId: string,
	householdId: string | null
): Promise<RecipeDetail> {
	const [row] = await dbx
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
			revision: recipes.revision,
			sourceAttribution: recipes.sourceAttribution,
			createdAt: recipes.createdAt,
			updatedAt: recipes.updatedAt,
			imageId: images.id,
			imageVersion: images.version,
			imageVariants: images.variants,
			attachmentId: recipeAttachments.id,
			attachmentName: recipeAttachments.filename,
			attachmentPages: recipeAttachments.pageCount
		})
		.from(recipes)
		.innerJoin(user, eq(user.id, recipes.ownerUserId))
		.leftJoin(images, eq(images.id, recipes.imageId))
		.leftJoin(recipeAttachments, eq(recipeAttachments.id, recipes.sourceAttachmentId))
		.where(and(eq(recipes.id, recipeId), recipeReadableBy(userId)))
		.limit(1);
	if (!row) throw notFound('Recipe not found');
	const isOwner = row.ownerUserId === userId;

	const [ingRows, stepRows, favRows, shareRows] = await Promise.all([
		dbx
			.select({
				id: recipeIngredients.id,
				position: recipeIngredients.position,
				groupName: recipeIngredients.groupName,
				ingredientId: recipeIngredients.ingredientId,
				name: recipeIngredients.name,
				amount: recipeIngredients.amount,
				unit: recipeIngredients.unit,
				preparation: recipeIngredients.preparation,
				optional: recipeIngredients.optional
			})
			.from(recipeIngredients)
			.where(eq(recipeIngredients.recipeId, recipeId))
			.orderBy(asc(recipeIngredients.position)),
		dbx
			.select({
				id: recipeSteps.id,
				position: recipeSteps.position,
				sectionTitle: recipeSteps.sectionTitle,
				text: recipeSteps.text
			})
			.from(recipeSteps)
			.where(eq(recipeSteps.recipeId, recipeId))
			.orderBy(asc(recipeSteps.position)),
		dbx
			.select({ recipeId: recipeFavorites.recipeId })
			.from(recipeFavorites)
			.where(and(eq(recipeFavorites.recipeId, recipeId), eq(recipeFavorites.userId, userId)))
			.limit(1),
		isOwner
			? dbx
					.select({
						householdId: householdMembers.householdId,
						name: sql<string>`(select h.name from household h where h.id = ${householdMembers.householdId})`,
						shared: sql<boolean>`exists (select 1 from ${recipeShares} rs where rs.recipe_id = ${recipeId} and rs.household_id = ${householdMembers.householdId})`
					})
					.from(householdMembers)
					.where(eq(householdMembers.userId, userId))
			: Promise.resolve([] as { householdId: string; name: string; shared: boolean }[])
	]);

	const ingredientIds = ingRows.map((r) => r.ingredientId).filter((x): x is string => !!x);
	const [meta, lots] = await Promise.all([
		getIngredientMeta(dbx, ingredientIds),
		householdId && ingredientIds.length
			? dbx
					.select({
						ingredientId: stockLots.ingredientId,
						quantity: stockLots.quantity,
						unit: stockLots.unit
					})
					.from(stockLots)
					.where(
						and(
							eq(stockLots.householdId, householdId),
							inArray(stockLots.ingredientId, ingredientIds),
							sql`${stockLots.quantity} > 0`
						)
					)
			: Promise.resolve([] as { ingredientId: string; quantity: string; unit: string }[])
	]);

	const convention: Convention = row.convention === 'us' ? 'us' : 'metric';
	const ingredients: RecipeIngredientView[] = ingRows.map((r) => {
		const m = r.ingredientId ? meta.get(r.ingredientId) : undefined;
		let stockAvailable: string | null = null;
		const stockOther: { quantity: string; unit: string }[] = [];
		if (r.ingredientId) {
			let sum = Dec.zero;
			let any = false;
			for (const lot of lots) {
				if (lot.ingredientId !== r.ingredientId) continue;
				const q = Dec.from(lot.quantity);
				if (r.unit) {
					const density = m?.gramsPerMl ? Dec.from(m.gramsPerMl) : null;
					const conv = unitsCompatible(lot.unit, r.unit)
						? convertAmount(q, lot.unit, r.unit, convention)
						: convertAmount(q, lot.unit, r.unit, convention, { gramsPerMl: density });
					if (conv) {
						sum = sum.add(conv);
						any = true;
						continue;
					}
				}
				stockOther.push({ quantity: q.toString(), unit: lot.unit });
			}
			if (any) stockAvailable = sum.toString();
		}
		return {
			id: r.id,
			position: r.position,
			groupName: r.groupName,
			ingredientId: r.ingredientId,
			name: r.name,
			amount: r.amount ? Dec.from(r.amount).toString() : null,
			unit: r.unit,
			preparation: r.preparation,
			optional: r.optional,
			ingredientCategory: m?.category ?? null,
			stockAvailable,
			stockOther
		};
	});

	return {
		id: row.id,
		title: row.title,
		description: row.description,
		baseServings: row.baseServings ? Dec.from(row.baseServings).toString() : null,
		yieldNote: row.yieldNote,
		prepMinutes: row.prepMinutes,
		cookMinutes: row.cookMinutes,
		source: row.source,
		notes: row.notes,
		tags: row.tags,
		convention,
		status: row.status,
		revision: row.revision,
		isOwner,
		ownerName: row.ownerName,
		isFavorite: favRows.length > 0,
		sourceAttribution: row.sourceAttribution,
		sourceFile: row.attachmentId
			? {
					id: row.attachmentId,
					filename: row.attachmentName ?? 'source file',
					pageCount: row.attachmentPages
				}
			: null,
		image:
			row.imageId && row.imageVariants
				? {
						id: row.imageId,
						version: row.imageVersion ?? 1,
						variants: Object.fromEntries(
							Object.entries(row.imageVariants).map(([k, v]) => [
								k,
								{ width: v.width, height: v.height }
							])
						)
					}
				: null,
		ingredients,
		steps: stepRows,
		shares: shareRows,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		cookable:
			row.status === 'active' &&
			!!row.baseServings &&
			Dec.from(row.baseServings).isPositive() &&
			ingRows.length > 0
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
		return row.id;
	});
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

/* ---------------------------- export ---------------------------- */

export const EXPORT_SCHEMA_VERSION = 1;

export async function exportRecipes(
	dbx: DbOrTx,
	userId: string,
	opts: { recipeIds?: string[]; scope: 'mine' | 'all' }
) {
	const conds = [recipeReadableBy(userId)];
	if (opts.scope === 'mine') conds.push(eq(recipes.ownerUserId, userId));
	if (opts.recipeIds) conds.push(inArray(recipes.id, opts.recipeIds));
	const rows = await dbx
		.select({
			id: recipes.id,
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
			revision: recipes.revision,
			sourceAttribution: recipes.sourceAttribution,
			ownerUserId: recipes.ownerUserId,
			ownerName: user.name,
			createdAt: recipes.createdAt,
			updatedAt: recipes.updatedAt
		})
		.from(recipes)
		.innerJoin(user, eq(user.id, recipes.ownerUserId))
		.where(and(...conds))
		.orderBy(asc(recipes.createdAt), asc(recipes.id))
		.limit(2000);
	const ids = rows.map((r) => r.id);
	if (opts.recipeIds && ids.length !== new Set(opts.recipeIds).size)
		throw notFound('Recipe not found');
	const [ingRows, stepRows] = ids.length
		? await Promise.all([
				dbx
					.select({
						recipeId: recipeIngredients.recipeId,
						position: recipeIngredients.position,
						groupName: recipeIngredients.groupName,
						ingredientId: recipeIngredients.ingredientId,
						name: recipeIngredients.name,
						amount: recipeIngredients.amount,
						unit: recipeIngredients.unit,
						preparation: recipeIngredients.preparation,
						optional: recipeIngredients.optional
					})
					.from(recipeIngredients)
					.where(inArray(recipeIngredients.recipeId, ids))
					.orderBy(asc(recipeIngredients.recipeId), asc(recipeIngredients.position)),
				dbx
					.select({
						recipeId: recipeSteps.recipeId,
						position: recipeSteps.position,
						sectionTitle: recipeSteps.sectionTitle,
						text: recipeSteps.text
					})
					.from(recipeSteps)
					.where(inArray(recipeSteps.recipeId, ids))
					.orderBy(asc(recipeSteps.recipeId), asc(recipeSteps.position))
			])
		: [[], []];
	const meta = await getIngredientMeta(
		dbx,
		ingRows.map((i) => i.ingredientId).filter((x): x is string => !!x)
	);
	const byRecipeIng = new Map<string, typeof ingRows>();
	for (const i of ingRows)
		(byRecipeIng.get(i.recipeId) ?? byRecipeIng.set(i.recipeId, []).get(i.recipeId)!).push(i);
	const byRecipeStep = new Map<string, typeof stepRows>();
	for (const s of stepRows)
		(byRecipeStep.get(s.recipeId) ?? byRecipeStep.set(s.recipeId, []).get(s.recipeId)!).push(s);

	return {
		schemaVersion: EXPORT_SCHEMA_VERSION,
		application: 'my-kitchen',
		exportedAt: new Date().toISOString(),
		exportedBy: userId,
		notes: [
			'Amounts are decimal strings; null means the recipe gives no amount.',
			'Units are canonical ids from the units table below; conversions follow the recipe convention (metric or us).',
			'ingredients and steps are ordered by position (0-based).'
		],
		units: UNITS.map((u) => ({
			id: u.id,
			dimension: u.dimension,
			singular: u.singular,
			plural: u.plural,
			toBase: u.toBase ?? null
		})),
		recipes: rows.map((r) => ({
			id: r.id,
			title: r.title,
			description: r.description,
			baseServings: r.baseServings ? Dec.from(r.baseServings).toString() : null,
			yieldNote: r.yieldNote,
			prepMinutes: r.prepMinutes,
			cookMinutes: r.cookMinutes,
			source: r.source,
			notes: r.notes,
			tags: r.tags,
			convention: r.convention,
			status: r.status,
			revision: r.revision,
			owner: r.ownerUserId === userId ? 'me' : r.ownerName,
			sourceAttribution: r.sourceAttribution,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			ingredients: (byRecipeIng.get(r.id) ?? []).map((i) => ({
				position: i.position,
				group: i.groupName,
				name: i.name,
				identity: i.ingredientId
					? {
							id: i.ingredientId,
							name: meta.get(i.ingredientId)?.name ?? null,
							category: meta.get(i.ingredientId)?.category ?? null
						}
					: null,
				amount: i.amount ? Dec.from(i.amount).toString() : null,
				unit: i.unit,
				preparation: i.preparation,
				optional: i.optional
			})),
			steps: (byRecipeStep.get(r.id) ?? []).map((s) => ({
				position: s.position,
				section: s.sectionTitle,
				text: s.text
			}))
		}))
	};
}

/** Plain printable text for one recipe. */
export function recipeToPlainText(r: RecipeDetail): string {
	const lines: string[] = [r.title.toUpperCase(), ''];
	if (r.description) lines.push(r.description, '');
	const meta: string[] = [];
	if (r.baseServings)
		meta.push(
			`Serves ${Dec.from(r.baseServings).toHuman()}${r.yieldNote ? ` (${r.yieldNote})` : ''}`
		);
	if (r.prepMinutes) meta.push(`Prep ${r.prepMinutes} min`);
	if (r.cookMinutes) meta.push(`Cook ${r.cookMinutes} min`);
	if (meta.length) lines.push(meta.join(' · '), '');
	lines.push('INGREDIENTS');
	let group = '';
	for (const i of r.ingredients) {
		if (i.groupName && i.groupName !== group) {
			group = i.groupName;
			lines.push(`  ${group}:`);
		}
		const amt = i.amount ? `${Dec.from(i.amount).toHuman()}${i.unit ? ' ' + i.unit : ''} ` : '';
		lines.push(
			`  - ${amt}${i.name}${i.preparation ? ', ' + i.preparation : ''}${i.optional ? ' (optional)' : ''}`
		);
	}
	lines.push('', 'STEPS');
	let section = '';
	r.steps.forEach((s, idx) => {
		if (s.sectionTitle && s.sectionTitle !== section) {
			section = s.sectionTitle;
			lines.push(`  ${section}:`);
		}
		lines.push(`  ${idx + 1}. ${s.text}`);
	});
	if (r.notes) lines.push('', 'NOTES', r.notes);
	if (r.source) lines.push('', `Source: ${r.source}`);
	if (r.sourceAttribution) lines.push(r.sourceAttribution);
	return lines.join('\n') + '\n';
}
