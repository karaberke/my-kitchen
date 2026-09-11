import { eq, isNull, or } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import { ingredientAliases, ingredients } from '$lib/server/db/schema';
import { matchCandidates } from '$lib/shared/ingredient-name';

export interface IngredientMatch {
	ingredientId: string;
	name: string;
	matchedOn: 'name' | 'alias';
	/** the cleaned-up name that found the hit, for "matched through …" wording */
	matchedText: string;
}

/** Same words in any order, so "sea salt fine" reaches the alias "fine sea salt". */
const wordKey = (normalized: string) => normalized.split(' ').sort().join(' ');

interface Entry {
	ingredientId: string;
	name: string;
	text: string;
	matchedOn: 'name' | 'alias';
	fromCatalog: boolean;
}

/** A catalog entry beats a private one, and a name beats an alias. */
function better(a: Entry, b: Entry): Entry {
	if (a.fromCatalog !== b.fromCatalog) return a.fromCatalog ? a : b;
	if (a.matchedOn !== b.matchedOn) return a.matchedOn === 'name' ? a : b;
	return a;
}

function add(index: Map<string, Entry>, key: string, entry: Entry) {
	if (!key) return;
	const held = index.get(key);
	index.set(key, held ? better(held, entry) : entry);
}

/**
 * Looks each recipe ingredient name up in the shared catalog and in the
 * caller's own identities. Every comparison is exact on a cleaned-up name —
 * never a prefix, which would turn "chicken" into "chicken breast".
 *
 * The catalog is small (a few hundred rows), so the two queries below read it
 * whole and the comparison happens here; that is what allows the word-order
 * rule, which SQL cannot index for.
 */
export async function matchIngredientNames(
	dbx: DbOrTx,
	userId: string,
	names: string[]
): Promise<Map<string, IngredientMatch | null>> {
	const out = new Map<string, IngredientMatch | null>(names.map((n) => [n, null]));
	if (!names.length) return out;
	const scope = or(isNull(ingredients.ownerUserId), eq(ingredients.ownerUserId, userId));
	const [nameRows, aliasRows] = await Promise.all([
		dbx
			.select({
				id: ingredients.id,
				name: ingredients.name,
				normalized: ingredients.nameNormalized,
				ownerUserId: ingredients.ownerUserId
			})
			.from(ingredients)
			.where(scope),
		dbx
			.select({
				id: ingredients.id,
				name: ingredients.name,
				normalized: ingredientAliases.aliasNormalized,
				ownerUserId: ingredients.ownerUserId
			})
			.from(ingredientAliases)
			.innerJoin(ingredients, eq(ingredients.id, ingredientAliases.ingredientId))
			.where(scope)
	]);

	const exact = new Map<string, Entry>();
	const byWords = new Map<string, Entry>();
	for (const [rows, matchedOn] of [
		[nameRows, 'name'],
		[aliasRows, 'alias']
	] as const) {
		for (const r of rows) {
			const entry: Entry = {
				ingredientId: r.id,
				name: r.name,
				text: r.normalized,
				matchedOn,
				fromCatalog: !r.ownerUserId
			};
			add(exact, r.normalized, entry);
			add(byWords, wordKey(r.normalized), entry);
		}
	}

	for (const raw of names) {
		for (const candidate of matchCandidates(raw)) {
			const hit = exact.get(candidate) ?? byWords.get(wordKey(candidate));
			if (!hit) continue;
			out.set(raw, {
				ingredientId: hit.ingredientId,
				name: hit.name,
				matchedOn: hit.matchedOn,
				matchedText: hit.text
			});
			break;
		}
	}
	return out;
}

/** Unlinked names are grouped by this key, so one confirmation serves every row. */
export function groupKey(name: string): string {
	return matchCandidates(name)[0] ?? '';
}
