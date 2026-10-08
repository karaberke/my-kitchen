import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { assertMember, requireUserApi } from '$lib/server/access';
import {
	INGREDIENT_NAME_MAX,
	searchIngredients,
	type IngredientSuggestion
} from '$lib/server/ingredients';
import { INGREDIENT_MATCH_MAX_NAMES } from '$lib/shared/assistant-limits';
import { cleanChatText } from '$lib/shared/text';
import { claimLlmCall, completeJson, type LlmCallOptions } from './client';
import { INGREDIENT_PICK_SYSTEM, INGREDIENT_PICK_TASK } from './prompts';

/** Catalog candidates shown to the model for each name. */
export const INGREDIENT_MATCH_CANDIDATES = 5;
/** Room for one `{ name, pick }` entry in the reply. */
export const INGREDIENT_MATCH_TOKENS_PER_NAME = 30;
/** Room for the JSON around the entries. */
export const INGREDIENT_MATCH_BASE_TOKENS = 20;

export const pickReplySchema = z.object({
	picks: z.array(z.object({ name: z.string(), pick: z.int().nullable() }))
});

export interface PickReplyLine {
	name: string;
	pick: number | null;
}

export type IngredientPicks = Record<string, IngredientSuggestion | null>;

/** The names as the model sees them: cleaned, blank and repeated ones removed, at most the limit. */
export function cleanMatchNames(names: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of names) {
		const name = cleanChatText(raw, INGREDIENT_NAME_MAX);
		if (name && !out.includes(name)) out.push(name);
		if (out.length === INGREDIENT_MATCH_MAX_NAMES) break;
	}
	return out;
}

/** The user message: the task line, then each name with its numbered candidates. */
export function pickUserText(asked: ReadonlyMap<string, readonly IngredientSuggestion[]>): string {
	const blocks = [...asked].map(
		([name, candidates], i) =>
			`${i + 1}. ${name}\n` + candidates.map((c, j) => `   ${j + 1}) ${c.name}`).join('\n')
	);
	return INGREDIENT_PICK_TASK + blocks.join('\n');
}

/**
 * Check the model's picks: a pick must be a 1-based index into that name's
 * candidates, and the name must be one that was asked. Anything else, and
 * every name the reply leaves out, is null. Repeated names keep the first answer.
 */
export function checkPicks(
	asked: ReadonlyMap<string, readonly IngredientSuggestion[]>,
	reply: readonly PickReplyLine[]
): IngredientPicks {
	const out: IngredientPicks = {};
	for (const name of asked.keys()) out[name] = null;
	const answered = new Set<string>();
	for (const r of reply) {
		const candidates = asked.get(r.name);
		if (!candidates || answered.has(r.name)) continue;
		answered.add(r.name);
		const pick = r.pick;
		if (pick !== null && Number.isInteger(pick) && pick >= 1 && pick <= candidates.length)
			out[r.name] = candidates[pick - 1];
	}
	return out;
}

/**
 * Ask the model which candidate, if any, is the same food as each name.
 * Names with no candidates are null without asking; when no name has any, no
 * request is made and no quota is spent. `claim` runs just before the request.
 */
export async function pickMatches(
	candidates: ReadonlyMap<string, readonly IngredientSuggestion[]>,
	claim: () => void,
	call: LlmCallOptions = {}
): Promise<IngredientPicks> {
	const asked = new Map([...candidates].filter(([, c]) => c.length > 0));
	const out: IngredientPicks = {};
	for (const name of candidates.keys()) out[name] = null;
	if (!asked.size) return out;
	claim();
	const reply = await completeJson(pickReplySchema, INGREDIENT_PICK_SYSTEM, pickUserText(asked), {
		maxTokens: INGREDIENT_MATCH_BASE_TOKENS + INGREDIENT_MATCH_TOKENS_PER_NAME * asked.size,
		name: 'ingredient_pick',
		...call
	});
	return { ...out, ...checkPicks(asked, reply.picks) };
}

/**
 * A suggested catalog ingredient for each name the strict matcher could not
 * link, picked by the model from the same trigram candidates the dropdown
 * shows. Only a suggestion: nothing is stored or linked here. The result is
 * keyed by the cleaned name.
 */
export async function suggestIngredientMatch(
	event: RequestEvent,
	arg: { names: string[] }
): Promise<{ picks: IngredientPicks }> {
	const user = requireUserApi(event);
	// The household only reorders the candidates; a caller without one still gets them.
	const household = event.locals.household;
	if (household) await assertMember(db, household.id, user.id);
	const names = cleanMatchNames(arg.names);
	const found = await Promise.all(
		names.map((name) =>
			searchIngredients(db, user.id, name, INGREDIENT_MATCH_CANDIDATES, household?.id ?? null)
		)
	);
	const candidates = new Map(names.map((name, i) => [name, found[i]]));
	return {
		picks: await pickMatches(candidates, () => claimLlmCall(user.id), {
			signal: event.request.signal
		})
	};
}
