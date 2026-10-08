import { afterEach, describe, expect, it } from 'vitest';
import type { LineView } from '$lib/server/grocery';
import { GROCERY_CATEGORIES } from '$lib/shared/grocery-categories';
import { stubLlm, unstubLlm } from '../../../../tests/llm-stub';
import {
	GROCERY_TIDY_BASE_TOKENS,
	GROCERY_TIDY_MAX_LINES,
	GROCERY_TIDY_TOKENS_PER_LINE,
	checkTidy,
	requestTidy,
	tidyLinesToSend,
	type TidyReplyLine,
	type TidySource
} from './grocery';
import { GROCERY_TIDY_SYSTEM, GROCERY_TIDY_TASK } from './prompts';

afterEach(unstubLlm);

let seq = 0;
const line = (over: Partial<LineView> = {}): LineView => ({
	id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
	kind: 'manual',
	ingredientId: null,
	name: 'bananas',
	category: 'Other',
	unit: null,
	demandAmount: null,
	stockConsidered: null,
	targetAmount: null,
	purchasedAmount: '0',
	remaining: null,
	status: 'pending',
	unresolvedReason: null,
	otherStock: [],
	subtractPantry: false,
	note: '',
	position: seq,
	revision: 3,
	sources: [],
	...over
});

const source = (over: Partial<TidySource> = {}): TidySource => ({
	ref: 1,
	lineId: 'line-1',
	revision: 3,
	kind: 'manual',
	name: '2x tins chopped tomatoes 400g',
	amount: null,
	unit: null,
	category: 'Other',
	text: '2x tins chopped tomatoes 400g',
	...over
});

const reply = (over: Partial<TidyReplyLine> = {}): TidyReplyLine => ({
	id: 1,
	name: 'chopped tomatoes',
	amount: '400',
	unit: 'g',
	aisle: 'Pantry',
	...over
});

describe('tidyLinesToSend', () => {
	it('picks pending manual lines with a number or no amount, and unlinked lines in Other', () => {
		const withNumber = line({
			name: 'tins 400g',
			demandAmount: '2',
			targetAmount: '2',
			category: 'Pantry'
		});
		const noAmount = line({ name: 'bread', category: 'Bakery' });
		const unlinkedRecipe = line({ kind: 'recipe', name: 'saffron', demandAmount: '1' });
		const tidy = line({
			name: 'milk',
			demandAmount: '1',
			targetAmount: '1',
			unit: 'l',
			category: 'Dairy & eggs'
		});
		const linkedOther = line({
			kind: 'recipe',
			name: 'salt',
			ingredientId: 'ing-1',
			demandAmount: '1'
		});
		const bought = line({ name: '2 lemons', status: 'purchased' });
		const sent = tidyLinesToSend(
			[withNumber, noAmount, unlinkedRecipe, tidy, linkedOther, bought],
			'draft'
		);
		expect(sent.map((s) => s.lineId)).toEqual([withNumber.id, noAmount.id, unlinkedRecipe.id]);
		expect(sent.map((s) => s.ref)).toEqual([1, 2, 3]);
		expect(sent[0]).toMatchObject({ amount: '2', text: '2 tins 400g', revision: 3 });
		expect(sent[1].text).toBe('bread');
	});

	it('reads the remaining amount while shopping, with its unit', () => {
		const l = line({
			name: 'rice 1kg bag',
			unit: 'g',
			demandAmount: '500.000000',
			targetAmount: '500.000000',
			remaining: '300.000000'
		});
		expect(tidyLinesToSend([l], 'shopping')[0]).toMatchObject({
			amount: '300',
			text: '300 g rice 1kg bag'
		});
		expect(tidyLinesToSend([l], 'draft')[0].amount).toBe('500');
	});

	it(`sends at most ${GROCERY_TIDY_MAX_LINES} lines`, () => {
		const lines = Array.from({ length: GROCERY_TIDY_MAX_LINES + 5 }, () => line());
		expect(tidyLinesToSend(lines, 'draft')).toHaveLength(GROCERY_TIDY_MAX_LINES);
	});
});

describe('checkTidy', () => {
	it('keeps an amount written in the text, with its unit, name and aisle', () => {
		const [p] = checkTidy([source()], [reply()]);
		expect(p).toEqual({
			lineId: 'line-1',
			revision: 3,
			kind: 'manual',
			before: {
				name: '2x tins chopped tomatoes 400g',
				amount: null,
				unit: null,
				category: 'Other'
			},
			after: { name: 'chopped tomatoes', amount: '400', unit: 'g', category: 'Pantry' },
			changed: ['name', 'amount', 'unit', 'category']
		});
		expect(checkTidy([source()], [reply({ amount: '2', unit: 'tins' })])[0].after).toMatchObject({
			amount: '2',
			unit: 'can'
		});
	});

	it('drops an amount that is not in the text, together with its unit', () => {
		const [p] = checkTidy([source()], [reply({ amount: '800' })]);
		expect(p.after).toMatchObject({ name: 'chopped tomatoes', amount: null, unit: null });
		expect(p.changed).toEqual(['name', 'category']);
		// "40" is part of "400", not an amount of its own.
		expect(checkTidy([source()], [reply({ amount: '40' })])[0].after.amount).toBeNull();
		expect(checkTidy([source()], [reply({ amount: 'lots' })])[0].after.amount).toBeNull();
	});

	it('drops an amount whose unit is not known', () => {
		const [p] = checkTidy([source()], [reply({ unit: 'barrels' })]);
		expect(p.after).toMatchObject({ amount: null, unit: null });
	});

	it('never clears an amount the line has', () => {
		const src = source({ name: 'rice', amount: '2', unit: 'kg', text: '2 kg rice' });
		expect(
			checkTidy([src], [reply({ name: 'rice', amount: '', unit: '', aisle: 'Other' })])
		).toEqual([]);
	});

	it('drops an unknown or repeated id', () => {
		const out = checkTidy(
			[source()],
			[reply({ id: 7 }), reply({ id: 1, aisle: 'Pantry' }), reply({ id: 1, aisle: 'Frozen' })]
		);
		expect(out).toHaveLength(1);
		expect(out[0].after.category).toBe('Pantry');
	});

	it('keeps the aisle when it is outside the list', () => {
		const [p] = checkTidy([source()], [reply({ aisle: 'Snacks' })]);
		expect(p.after.category).toBe('Other');
		expect(p.changed).not.toContain('category');
	});

	it('keeps the name when it is blank or too long', () => {
		expect(checkTidy([source()], [reply({ name: '  ' })])[0].after.name).toBe(source().name);
		expect(checkTidy([source()], [reply({ name: 'x'.repeat(121) })])[0].after.name).toBe(
			source().name
		);
	});

	it('changes only the aisle of a recipe line', () => {
		const src = source({ kind: 'recipe', name: 'saffron 1g', text: 'saffron 1g' });
		const [p] = checkTidy(
			[src],
			[reply({ name: 'saffron', amount: '1', unit: 'g', aisle: 'Spices' })]
		);
		expect(p.after).toEqual({ ...p.before, category: 'Spices' });
		expect(p.changed).toEqual(['category']);
	});

	it('leaves out lines with no change', () => {
		const src = source({ name: 'bananas', text: 'bananas', category: 'Produce' });
		expect(
			checkTidy([src], [reply({ name: 'bananas', amount: '', unit: '', aisle: 'Produce' })])
		).toEqual([]);
	});
});

describe('requestTidy', () => {
	it('sends the fixed prompt, numbered lines last, max_tokens and the aisle enum', async () => {
		const { requests } = stubLlm([JSON.stringify({ lines: [reply()] })]);
		const sent = [source(), source({ ref: 2, lineId: 'line-2', name: 'bananas', text: 'bananas' })];
		const out = await requestTidy(sent);
		expect(out.map((p) => p.lineId)).toEqual(['line-1']);
		expect(requests).toHaveLength(1);
		const req = requests[0];
		expect(req.max_tokens).toBe(GROCERY_TIDY_BASE_TOKENS + 2 * GROCERY_TIDY_TOKENS_PER_LINE);
		expect(req.messages[0]).toEqual({ role: 'system', content: GROCERY_TIDY_SYSTEM });
		expect(req.messages.at(-1)!.content).toBe(
			`${GROCERY_TIDY_TASK}1: 2x tins chopped tomatoes 400g\n2: bananas`
		);
		expect(JSON.stringify(req.response_format?.json_schema?.schema)).toContain(
			JSON.stringify([...GROCERY_CATEGORIES])
		);
	});

	it('makes no request when there is nothing to send', async () => {
		const { requests } = stubLlm([JSON.stringify({ lines: [] })]);
		expect(await requestTidy([])).toEqual([]);
		expect(requests).toHaveLength(0);
	});
});
