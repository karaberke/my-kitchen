import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { assertMember, householdActor } from '$lib/server/access';
import { AppError, notFound } from '$lib/server/errors';
import {
	GROCERY_LINE_NAME_MAX,
	getListLines,
	type LineFields,
	type LineView
} from '$lib/server/grocery';
import type { ListStatus } from '$lib/server/db/schema';
import { parseAmount } from '$lib/shared/amount-parse';
import { Dec } from '$lib/shared/decimal';
import {
	GROCERY_CATEGORIES,
	OTHER_CATEGORY,
	isGroceryCategory
} from '$lib/shared/grocery-categories';
import { QUANTITY_PATTERN } from '$lib/shared/ingredient-line';
import { normalizeUnitInput } from '$lib/shared/units';
import { match as isUuid } from '../../../params/uuid';
import { cleanChatText } from '$lib/shared/text';
import { claimLlmCall, completeJson, type LlmCallOptions } from './client';
import { GROCERY_TIDY_SYSTEM, GROCERY_TIDY_TASK } from './prompts';

/** The most lines one tidy request sends; the rest wait for the next press. */
export const GROCERY_TIDY_MAX_LINES = 25;
/** Room for one `{ id, name, amount, unit, aisle }` entry in the reply. */
export const GROCERY_TIDY_TOKENS_PER_LINE = 40;
/** Room for the JSON around the entries. */
export const GROCERY_TIDY_BASE_TOKENS = 30;

/**
 * One line as the model sees it. `ref` is its number in the request: a short
 * number instead of the line's uuid keeps the reply inside the token budget.
 * `amount` is what `updateLine` edits: the requested amount on a draft, the
 * remaining amount while shopping, as a `Dec` string, or null when unknown.
 */
export interface TidySource {
	ref: number;
	lineId: string;
	revision: number;
	kind: LineView['kind'];
	name: string;
	amount: string | null;
	unit: string | null;
	category: string;
	/** "400 g chopped tomatoes": what the model reads, and where an amount must come from. */
	text: string;
}

export const tidyReplySchema = z.object({
	lines: z.array(
		z.object({
			id: z.number().int(),
			name: z.string(),
			amount: z.string(),
			unit: z.string(),
			aisle: z.enum(GROCERY_CATEGORIES)
		})
	)
});

/** One entry of the reply; `aisle` is a plain string here so the checks cover any value. */
export interface TidyReplyLine {
	id: number;
	name: string;
	amount: string;
	unit: string;
	aisle: string;
}

export interface TidyValues {
	name: string;
	/** a `Dec` string, or null when unknown */
	amount: string | null;
	unit: string | null;
	category: string;
}

export type TidyField = keyof TidyValues;

/** A proposed change to one line. Nothing is saved until the user applies it. */
export interface TidyProposal {
	lineId: string;
	/** pass back as `expectedRevision`, so a line changed meanwhile is a conflict */
	revision: number;
	kind: LineView['kind'];
	before: TidyValues;
	after: TidyValues;
	/** the fields where `after` differs from `before`; never empty */
	changed: TidyField[];
}

function lineAmount(line: LineFields, status: ListStatus): string | null {
	const raw = status === 'draft' ? line.demandAmount : line.remaining;
	return raw === null ? null : Dec.from(raw).toString();
}

/**
 * The pending lines that need help, in list order, at most
 * `GROCERY_TIDY_MAX_LINES`: manual lines with a number in the name or no
 * amount, and any line in "Other" that is not linked to the catalog.
 */
export function tidyLinesToSend(lines: readonly LineFields[], status: ListStatus): TidySource[] {
	return lines
		.filter((l) => l.status === 'pending')
		.filter(
			(l) =>
				(l.kind === 'manual' &&
					(/\d/.test(l.name) || (l.demandAmount === null && l.targetAmount === null))) ||
				(l.category === OTHER_CATEGORY && !l.ingredientId)
		)
		.slice(0, GROCERY_TIDY_MAX_LINES)
		.map((l, i) => {
			const amount = lineAmount(l, status);
			const head = [amount, amount !== null ? l.unit : null].filter(Boolean).join(' ');
			return {
				ref: i + 1,
				lineId: l.id,
				revision: l.revision,
				kind: l.kind,
				name: l.name,
				amount,
				unit: l.unit,
				category: l.category,
				text: cleanChatText(head ? `${head} ${l.name}` : l.name, GROCERY_LINE_NAME_MAX * 2)
			};
		});
}

/** The user message: the fixed task line, then one `ref: text` line per item. */
export function tidyUserText(sent: readonly TidySource[]): string {
	return GROCERY_TIDY_TASK + sent.map((s) => `${s.ref}: ${s.text}`).join('\n');
}

const QUANTITY_ANYWHERE = new RegExp(QUANTITY_PATTERN, 'g');

/** Every amount written in `text`, as `Dec` strings; both ends of a range count. */
function amountsInText(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(QUANTITY_ANYWHERE))
		for (const part of m[1].split(/\s*[-–—]\s*/)) {
			const parsed = parseAmount(part);
			if (parsed.ok && parsed.value) out.add(parsed.value.toString());
		}
	return out;
}

/**
 * Check the model's reply against the lines sent and keep only what passes.
 *
 * - An unknown or repeated `id` is dropped.
 * - The aisle must be one of `GROCERY_CATEGORIES`, or it stays.
 * - The amount must parse, be positive, and be written in the line's own text
 *   ("800" for "2x tins 400g" is not), and the unit must be empty or a known
 *   unit. Otherwise amount and unit both stay as they are. An empty amount
 *   never clears one the line has.
 * - The name must be 1..`GROCERY_LINE_NAME_MAX` characters, or it stays.
 * - A recipe line takes only the aisle: its name and amount come from recipes.
 *
 * Lines with no change are left out.
 */
export function checkTidy(
	sent: readonly TidySource[],
	reply: readonly TidyReplyLine[]
): TidyProposal[] {
	const byRef = new Map(sent.map((s) => [s.ref, s]));
	const seen = new Set<number>();
	const out: TidyProposal[] = [];
	for (const r of reply) {
		const src = byRef.get(r.id);
		if (!src || seen.has(r.id)) continue;
		seen.add(r.id);
		const before: TidyValues = {
			name: src.name,
			amount: src.amount,
			unit: src.unit,
			category: src.category
		};
		const after: TidyValues = { ...before };
		if (isGroceryCategory(r.aisle)) after.category = r.aisle;
		if (src.kind === 'manual') {
			const name = cleanChatText(r.name, GROCERY_LINE_NAME_MAX + 1);
			if (name && name.length <= GROCERY_LINE_NAME_MAX) after.name = name;
			const amount = parseAmount(r.amount);
			const unit = r.unit.trim() ? normalizeUnitInput(r.unit) : null;
			const unitOk = !r.unit.trim() || unit !== null;
			if (
				amount.ok &&
				amount.value?.isPositive() &&
				unitOk &&
				amountsInText(src.text).has(amount.value.toString())
			) {
				after.amount = amount.value.toString();
				after.unit = unit;
			}
		}
		const changed = (Object.keys(before) as TidyField[]).filter((k) => before[k] !== after[k]);
		if (changed.length)
			out.push({
				lineId: src.lineId,
				revision: src.revision,
				kind: src.kind,
				before,
				after,
				changed
			});
	}
	return out;
}

/** One request for the lines in `sent`; the reply is checked by `checkTidy`. */
export async function requestTidy(
	sent: readonly TidySource[],
	call: LlmCallOptions = {}
): Promise<TidyProposal[]> {
	if (!sent.length) return [];
	const reply = await completeJson(tidyReplySchema, GROCERY_TIDY_SYSTEM, tidyUserText(sent), {
		maxTokens: GROCERY_TIDY_BASE_TOKENS + GROCERY_TIDY_TOKENS_PER_LINE * sent.length,
		name: 'grocery_tidy',
		...call
	});
	return checkTidy(sent, reply.lines);
}

/**
 * Propose a tidier name, amount, unit and aisle for the lines of a grocery
 * list that need it. The list must belong to the caller's household and not be
 * completed; both are checked before any quota is spent. Nothing is saved:
 * the `applyTidy` action saves the proposals the user keeps.
 */
export async function tidyGroceryList(
	event: RequestEvent,
	arg: { listId: string }
): Promise<{ proposals: TidyProposal[]; sent: number }> {
	if (!isUuid(arg.listId)) throw notFound('Grocery list not found');
	const ctx = householdActor(event);
	await assertMember(db, ctx.householdId, ctx.userId);
	const list = await getListLines(db, ctx.householdId, arg.listId);
	if (list.status === 'completed') throw new AppError(409, 'This trip is completed');
	const sent = tidyLinesToSend(list.lines, list.status);
	if (!sent.length) return { proposals: [], sent: 0 };
	claimLlmCall(ctx.userId);
	return {
		proposals: await requestTidy(sent, { signal: event.request.signal }),
		sent: sent.length
	};
}
