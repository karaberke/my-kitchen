import { and, desc, eq, exists, inArray, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import { images, recipeFavorites, recipeCategoryItems, recipes, user } from '$lib/server/db/schema';
import { recipeReadableBy } from '$lib/server/access';
import { CATEGORIES_PER_HOUSEHOLD_MAX } from '$lib/server/recipe-categories';
import { match as isUuid } from '../../../params/uuid';

export const RECIPES_PER_PAGE = 24;
export const RECIPES_PER_PAGE_MAX = 100;

export interface RecipeListParams {
	page: number;
	perPage: number;
	q: string;
	tag: string | null;
	favorites: boolean;
	/** empty or both = every readable recipe */
	scope: RecipeScope[];
	/** empty = active and draft; `'all'` = no status filter */
	status: RecipeStatusFilter[] | 'all';
	/** household category ids, OR-ed; ignored without a household */
	categoryIds: string[];
}

const RECIPE_SCOPES = ['mine', 'shared'] as const;
const RECIPE_STATUS_FILTERS = ['draft', 'archived'] as const;
type RecipeScope = (typeof RECIPE_SCOPES)[number];
type RecipeStatusFilter = (typeof RECIPE_STATUS_FILTERS)[number];

/** The distinct values of a repeated query parameter that are in `allowed`, in order. */
function pickAll<T extends string>(url: URL, name: string, allowed: readonly T[]): T[] {
	const wanted = new Set(url.searchParams.getAll(name));
	return allowed.filter((v) => wanted.has(v));
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
	const categoryIds = [...new Set(url.searchParams.getAll('cat').map((c) => c.toLowerCase()))]
		.filter((c) => isUuid(c))
		.slice(0, CATEGORIES_PER_HOUSEHOLD_MAX);
	return {
		page,
		perPage,
		q: (url.searchParams.get('q') ?? '').trim().slice(0, 100),
		tag: (url.searchParams.get('tag') ?? '').trim().slice(0, 40) || null,
		favorites: url.searchParams.get('favorites') === '1',
		scope: pickAll(url, 'scope', RECIPE_SCOPES),
		status: url.searchParams.getAll('status').includes('all')
			? 'all'
			: pickAll(url, 'status', RECIPE_STATUS_FILTERS),
		categoryIds
	};
}

export async function listRecipes(
	dbx: DbOrTx,
	userId: string,
	params: RecipeListParams,
	householdId: string | null
) {
	const conds = [recipeReadableBy(userId)];
	if (params.q) conds.push(sql`${recipes.title} ilike ${'%' + escapeLike(params.q) + '%'}`);
	if (params.tag) conds.push(sql`${recipes.tags} @> array[${params.tag}]::text[]`);
	if (params.favorites)
		conds.push(
			exists(
				sql`(select 1 from ${recipeFavorites} f where f.recipe_id = ${recipes.id} and f.user_id = ${userId})`
			)
		);
	// mine ∪ shared is exactly recipeReadableBy, which is always applied
	if (params.scope.length === 1)
		conds.push(
			params.scope[0] === 'mine' ? eq(recipes.ownerUserId, userId) : ne(recipes.ownerUserId, userId)
		);
	if (params.status !== 'all')
		conds.push(inArray(recipes.status, params.status.length ? params.status : ['active', 'draft']));
	if (householdId && params.categoryIds.length)
		conds.push(
			exists(
				dbx
					.select({ one: sql`1` })
					.from(recipeCategoryItems)
					.where(
						and(
							eq(recipeCategoryItems.recipeId, recipes.id),
							eq(recipeCategoryItems.householdId, householdId),
							inArray(recipeCategoryItems.categoryId, params.categoryIds)
						)
					)
			)
		);
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
			baseServings: recipes.baseServings,
			yieldNote: recipes.yieldNote
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
