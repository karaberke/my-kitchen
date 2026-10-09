import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import { recipeIngredients, recipeSteps, recipes, user } from '$lib/server/db/schema';
import { recipeReadableBy } from '$lib/server/access';
import { getIngredientMeta } from '$lib/server/ingredients';
import { notFound } from '$lib/server/errors';
import { Dec } from '$lib/shared/decimal';
import { UNITS } from '$lib/shared/units';
import { ingredientLine } from '$lib/shared/ingredient-line';
import { scaleAmount } from '$lib/shared/scaling';
import { prepareStepIngredients, scaledStepLine } from '$lib/shared/step-amounts';
import { recipeColumns, recipeRevisionColumns, type RecipeDetail } from './detail';

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
		.select({ ...recipeColumns, ...recipeRevisionColumns })
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

/** A recipe ready to print as plain text: every amount is already the text to show. */
interface PlainRecipe {
	title: string;
	description: string;
	/** The servings to show, or empty when the recipe has none. */
	servings: string;
	yieldNote: string;
	prepMinutes: string;
	cookMinutes: string;
	ingredients: {
		quantity: string;
		name: string;
		preparation: string;
		group: string;
		optional: boolean;
	}[];
	steps: { section: string; text: string }[];
	notes: string;
	source: string;
	sourceAttribution: string;
}

/** The text of a `PlainRecipe`, with the title in capitals as a printed heading. */
function renderPlainRecipe(r: PlainRecipe): string {
	const lines: string[] = [r.title.toUpperCase(), ''];
	if (r.description) lines.push(r.description, '');
	const meta: string[] = [];
	if (r.servings) meta.push(`Serves ${r.servings}${r.yieldNote ? ` (${r.yieldNote})` : ''}`);
	else if (r.yieldNote) meta.push(`Makes ${r.yieldNote}`);
	if (r.prepMinutes) meta.push(`Prep ${r.prepMinutes} min`);
	if (r.cookMinutes) meta.push(`Cook ${r.cookMinutes} min`);
	if (meta.length) lines.push(meta.join(' · '), '');
	lines.push('INGREDIENTS');
	let group = '';
	for (const i of r.ingredients) {
		if (i.group && i.group !== group) {
			group = i.group;
			lines.push(`  ${group}:`);
		}
		const line = ingredientLine({
			quantity: i.quantity,
			name: i.name,
			preparation: i.preparation
		});
		lines.push(`  - ${line}${i.optional ? ' (optional)' : ''}`);
	}
	lines.push('', 'STEPS');
	let section = '';
	r.steps.forEach((s, idx) => {
		if (s.section && s.section !== section) {
			section = s.section;
			lines.push(`  ${section}:`);
		}
		lines.push(`  ${idx + 1}. ${s.text}`);
	});
	if (r.notes) lines.push('', 'NOTES', r.notes);
	if (r.source) lines.push('', `Source: ${r.source}`);
	if (r.sourceAttribution) lines.push(r.sourceAttribution);
	return lines.join('\n') + '\n';
}

/**
 * The recipe as plain text. With `servings` (positive) and a recipe that has
 * base servings, the amounts are scaled in code to those servings and the text
 * says so; without it the amounts are as stored.
 */
export function recipeToPlainText(r: RecipeDetail, servings?: Dec): string {
	const base = r.baseServings ? Dec.from(r.baseServings) : null;
	const target = base?.isPositive() && servings?.isPositive() ? servings : null;
	const stepIngredients = base && target ? prepareStepIngredients(r.ingredients) : null;
	return renderPlainRecipe({
		title: r.title,
		description: r.description,
		servings: base ? (target ?? base).toHuman() : '',
		// Shown only beside the servings, as before.
		yieldNote: base ? r.yieldNote : '',
		prepMinutes: r.prepMinutes ? String(r.prepMinutes) : '',
		cookMinutes: r.cookMinutes ? String(r.cookMinutes) : '',
		ingredients: r.ingredients.map((i) => {
			const amount = i.amount ? Dec.from(i.amount) : null;
			const shown = base && target ? scaleAmount(amount, base, target) : amount;
			return {
				quantity: shown ? `${shown.toHuman()}${i.unit ? ' ' + i.unit : ''}` : '',
				name: i.name,
				preparation: i.preparation,
				group: i.groupName,
				optional: i.optional
			};
		}),
		steps: r.steps.map((s) => ({
			section: s.sectionTitle,
			text:
				base && target && stepIngredients
					? scaledStepLine(s.text, stepIngredients, base, target)
					: s.text
		})),
		notes: r.notes,
		source: r.source,
		sourceAttribution: r.sourceAttribution
	});
}
