import { Dec } from '$lib/shared/decimal';
import { formatQuantity, type Convention } from '$lib/shared/units';
import { parseDbTimestamp } from '$lib/shared/time';
import { scaleAmount } from '$lib/shared/scaling';
import { displayQuantity, type UnitSystem } from '$lib/shared/display-units';
import { ingredientLine } from '$lib/shared/ingredient-line';

export { parseDbTimestamp };

export function fmtQty(amount: string | null | undefined, unit: string | null | undefined): string {
	if (amount === null || amount === undefined) return 'unknown amount';
	return formatQuantity(Dec.from(amount), unit ?? null);
}

export function fmtNum(amount: string | null | undefined): string {
	if (amount === null || amount === undefined) return '';
	return Dec.from(amount).toHuman();
}

export function fmtDateTime(value: string | null | undefined): string {
	if (!value) return '';
	const d = parseDbTimestamp(value);
	return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtDate(value: string | null | undefined): string {
	if (!value) return '';
	const d = value.length === 10 ? new Date(value + 'T00:00:00') : parseDbTimestamp(value);
	return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function fmtMinutes(min: number | null | undefined): string {
	if (!min) return '';
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * The owner's one-line share status. Every new recipe is shared with the active
 * household, so a household the owner is alone in says nothing: naming it is
 * noise, and calling the recipe private would be a lie once someone joins.
 */
export function ownerShareLabel(
	shares: { name: string; shared: boolean; memberCount: number }[]
): string {
	const withOthers = shares.filter((s) => s.shared && s.memberCount > 1);
	if (withOthers.length) return `Yours · shared with ${withOthers.map((s) => s.name).join(', ')}`;
	return shares.some((s) => s.shared) ? 'Yours' : 'Yours · private';
}

/**
 * "40 min prep · 1 h cook · 4 servings" — a recipe's line-two summary,
 * falling back to its yield note when there is no numeric serving count.
 * Blank parts are dropped.
 */
export function recipeMetaLine(r: {
	prepMinutes: number | null;
	cookMinutes: number | null;
	baseServings: string | null;
	yieldNote: string | null;
}): string {
	return [
		r.prepMinutes ? `${fmtMinutes(r.prepMinutes)} prep` : '',
		r.cookMinutes ? `${fmtMinutes(r.cookMinutes)} cook` : '',
		r.baseServings ? `${fmtNum(r.baseServings)} servings` : (r.yieldNote ?? '')
	]
		.filter(Boolean)
		.join(' · ');
}

/**
 * One ingredient scaled to the current servings and rendered as a single
 * line: scale the base amount, format it for the chosen unit system, then
 * compose it with the name and preparation. Returns the scaled amount too,
 * since some callers also need it to compare against pantry stock.
 */
export function scaledIngredientLine(
	ing: { amount: string | null; unit: string | null; name: string; preparation: string },
	base: Dec,
	servings: Dec,
	system: UnitSystem,
	convention: Convention
): { amount: Dec | null; line: string } {
	const amount = ing.amount ? scaleAmount(Dec.from(ing.amount), base, servings) : null;
	const quantity = amount ? displayQuantity(amount, ing.unit, system, convention).text : '';
	const line = ingredientLine({ quantity, name: ing.name, preparation: ing.preparation });
	return { amount, line };
}

export function initials(name: string): string {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase())
		.join('');
}
