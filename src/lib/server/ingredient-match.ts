import { eq, isNull, or } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import { db, type DbOrTx } from '$lib/server/db';
import { requireUserApi } from '$lib/server/access';
import { ingredientAliases, ingredients } from '$lib/server/db/schema';
import { INGREDIENT_NAME_MAX } from '$lib/server/ingredients';
import { matchCandidates } from '$lib/shared/ingredient-name';
import { isAttributeWord } from '$lib/shared/ingredient-attributes';
import { normalizeName } from '$lib/shared/text';

export interface IngredientMatch {
	ingredientId: string;
	name: string;
	matchedOn: 'name' | 'alias';
	/** the cleaned-up name that found the hit, for "matched through …" wording */
	matchedText: string;
}

/** Same words in any order, so "sea salt fine" reaches the alias "fine sea salt". */
const wordKey = (normalized: string) => normalized.split(' ').sort().join(' ');

/** One canonical name or curated alias of an identity the user can see. */
export interface IdentityRow {
	id: string;
	name: string;
	/** the normalized name or alias */
	text: string;
	matchedOn: 'name' | 'alias';
	fromCatalog: boolean;
}

/** An identity chosen for the user, with its canonical name. */
export interface IdentityHit {
	ingredientId: string;
	name: string;
}

/**
 * Every name and alias of the catalog and of the user's own identities. The
 * catalog is small (a few hundred rows), so callers read it whole and compare
 * here; that allows rules SQL cannot index for.
 */
export async function loadIdentities(dbx: DbOrTx, userId: string): Promise<IdentityRow[]> {
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
	const rows: IdentityRow[] = [];
	for (const [list, matchedOn] of [
		[nameRows, 'name'],
		[aliasRows, 'alias']
	] as const) {
		for (const r of list)
			rows.push({
				id: r.id,
				name: r.name,
				text: r.normalized,
				matchedOn,
				fromCatalog: !r.ownerUserId
			});
	}
	return rows;
}

/** A catalog entry beats a private one, and a name beats an alias. */
function better(a: IdentityRow, b: IdentityRow): IdentityRow {
	if (a.fromCatalog !== b.fromCatalog) return a.fromCatalog ? a : b;
	if (a.matchedOn !== b.matchedOn) return a.matchedOn === 'name' ? a : b;
	return a;
}

function add(index: Map<string, IdentityRow>, key: string, entry: IdentityRow) {
	if (!key) return;
	const held = index.get(key);
	index.set(key, held ? better(held, entry) : entry);
}

/** The catalog match proposed for one written name, or null; the remote `ingredientMatch` query. */
export async function matchIngredient(event: RequestEvent, arg: { name: string }) {
	const user = requireUserApi(event);
	const name = arg.name.slice(0, INGREDIENT_NAME_MAX);
	if (!name.trim()) return { match: null };
	const matches = await matchIngredientNames(db, user.id, [name]);
	return { match: matches.get(name) ?? null };
}

/**
 * Looks each recipe ingredient name up in the shared catalog and in the
 * caller's own identities. Every comparison is exact on a cleaned-up name —
 * never a prefix, which would turn "chicken" into "chicken breast".
 *
 * `loadIdentities` reads the catalog whole, which is what allows the
 * word-order rule, which SQL cannot index for.
 */
export async function matchIngredientNames(
	dbx: DbOrTx,
	userId: string,
	names: string[]
): Promise<Map<string, IngredientMatch | null>> {
	const out = new Map<string, IngredientMatch | null>(names.map((n) => [n, null]));
	if (!names.length) return out;
	const exact = new Map<string, IdentityRow>();
	const byWords = new Map<string, IdentityRow>();
	for (const entry of await loadIdentities(dbx, userId)) {
		add(exact, entry.text, entry);
		add(byWords, wordKey(entry.text), entry);
	}

	for (const raw of names) {
		for (const candidate of matchCandidates(raw)) {
			const hit = exact.get(candidate) ?? byWords.get(wordKey(candidate));
			if (!hit) continue;
			out.set(raw, {
				ingredientId: hit.id,
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

/**
 * The identity a typed name stands for, only when there is no doubt: one of
 * its `matchCandidates` equals a canonical name or curated alias, and all the
 * equal texts belong to one identity. Where a private identity has the same
 * text as a catalog one, the catalog wins. No word order, containment or typo
 * rule applies here, because a wrong stored link is worse than a new one.
 */
export async function resolveIngredientName(
	dbx: DbOrTx,
	userId: string,
	name: string
): Promise<IdentityHit | null> {
	// Too long to be a name; the caller's own validation rejects it.
	if (name.trim().length > INGREDIENT_NAME_MAX) return null;
	const candidates = matchCandidates(name);
	if (!candidates.length) return null;
	const rows = await loadIdentities(dbx, userId);
	const found = new Map<string, IdentityRow>();
	for (const candidate of candidates) {
		const equal = rows.filter((r) => r.text === candidate);
		const catalog = equal.filter((r) => r.fromCatalog);
		for (const r of catalog.length ? catalog : equal) found.set(r.id, r);
	}
	if (found.size !== 1) return null;
	const [hit] = found.values();
	return { ingredientId: hit.id, name: hit.name };
}

/** Where `run` appears in `words` as a contiguous sequence, or -1. */
function indexOfRun(words: string[], run: string[]): number {
	for (let i = 0; i + run.length <= words.length; i++) {
		if (run.every((w, j) => words[i + j] === w)) return i;
	}
	return -1;
}

/** The title without the brand: the whole brand phrase if printed, else each brand word. */
function withoutBrand(title: string[], brand: string[]): string[] {
	if (!brand.length) return title;
	const at = indexOfRun(title, brand);
	if (at >= 0) return [...title.slice(0, at), ...title.slice(at + brand.length)];
	const drop = new Set(brand);
	return title.filter((w) => !drop.has(w));
}

/**
 * The identity a provider's product title names, as a proposal the user can
 * remove. The longest name or alias printed as a contiguous run in the title
 * (brand removed) is taken, and only when every other word is a harmless
 * attribute from `ingredient-attributes.ts`. Two different identities with an
 * equally long run make no proposal.
 */
export async function proposeFromProductTitle(
	dbx: DbOrTx,
	userId: string,
	title: string,
	brand: string
): Promise<IdentityHit | null> {
	const brandWords = normalizeName(brand).split(' ').filter(Boolean);
	const words = withoutBrand(normalizeName(title).split(' ').filter(Boolean), brandWords);
	if (!words.length) return null;

	let best: { row: IdentityRow; at: number; length: number } | null = null;
	let tied = false;
	for (const row of await loadIdentities(dbx, userId)) {
		const run = row.text.split(' ');
		const at = indexOfRun(words, run);
		if (at < 0) continue;
		if (!best || run.length > best.length) {
			best = { row, at, length: run.length };
			tied = false;
		} else if (run.length === best.length && row.id !== best.row.id) {
			const sameText = row.text === best.row.text;
			if (sameText && row.fromCatalog && !best.row.fromCatalog)
				best = { row, at, length: run.length };
			else if (!(sameText && best.row.fromCatalog)) tied = true;
		}
	}
	if (!best || tied) return null;

	const { row, at, length } = best;
	const rest = [...words.slice(0, at), ...words.slice(at + length)];
	if (!rest.every((w) => isAttributeWord(w, row.name))) return null;
	return { ingredientId: row.id, name: row.name };
}
