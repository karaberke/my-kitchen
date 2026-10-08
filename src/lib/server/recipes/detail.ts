import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import {
	householdMembers,
	images,
	ingredients as catalogIngredients,
	recipeFavorites,
	recipeIngredients,
	recipeSteps,
	recipeAttachments,
	recipes,
	stockLots,
	user
} from '$lib/server/db/schema';
import { recipeReadableBy } from '$lib/server/access';
import { notFound } from '$lib/server/errors';
import { Dec } from '$lib/shared/decimal';
import { convertAmount, unitsCompatible, type Convention } from '$lib/shared/units';

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
	shares: { householdId: string; name: string; shared: boolean; memberCount: number }[];
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

	const [ingRows, stepRows, favRows, shareRows, lots] = await Promise.all([
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
				optional: recipeIngredients.optional,
				category: catalogIngredients.category,
				gramsPerMl: catalogIngredients.gramsPerMl
			})
			.from(recipeIngredients)
			.leftJoin(catalogIngredients, eq(catalogIngredients.id, recipeIngredients.ingredientId))
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
						// The outer column is spelled out: interpolating householdMembers.householdId
						// renders it unqualified, and inside the subquery that name binds to the
						// inner table instead — rs.household_id = rs.household_id, true for every
						// household as soon as the recipe was shared with any one of them.
						name: sql<string>`(select h.name from household h where h.id = household_member.household_id)`,
						shared: sql<boolean>`exists (select 1 from recipe_share rs where rs.recipe_id = ${recipeId} and rs.household_id = household_member.household_id)`,
						memberCount: sql<number>`(select count(*)::int from household_member m2 where m2.household_id = household_member.household_id)`
					})
					.from(householdMembers)
					.where(eq(householdMembers.userId, userId))
			: Promise.resolve(
					[] as { householdId: string; name: string; shared: boolean; memberCount: number }[]
				),
		// The household's stock of this recipe's ingredients, in the same round trip.
		householdId
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
							inArray(
								stockLots.ingredientId,
								dbx
									.select({ id: recipeIngredients.ingredientId })
									.from(recipeIngredients)
									.where(eq(recipeIngredients.recipeId, recipeId))
							),
							sql`${stockLots.quantity} > 0`
						)
					)
			: Promise.resolve([] as { ingredientId: string; quantity: string; unit: string }[])
	]);
	const lotsByIngredient = new Map<string, typeof lots>();
	for (const lot of lots) {
		const held = lotsByIngredient.get(lot.ingredientId);
		if (held) held.push(lot);
		else lotsByIngredient.set(lot.ingredientId, [lot]);
	}

	const convention: Convention = row.convention === 'us' ? 'us' : 'metric';
	const ingredients: RecipeIngredientView[] = ingRows.map((r) => {
		let stockAvailable: string | null = null;
		const stockOther: { quantity: string; unit: string }[] = [];
		if (r.ingredientId) {
			let sum = Dec.zero;
			let any = false;
			for (const lot of lotsByIngredient.get(r.ingredientId) ?? []) {
				const q = Dec.from(lot.quantity);
				if (r.unit) {
					const density = r.gramsPerMl ? Dec.from(r.gramsPerMl) : null;
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
			ingredientCategory: r.category,
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
