import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngredientSuggestion } from '$lib/server/ingredients';
import { stubLlm, unstubLlm } from '../../../../tests/llm-stub';
import {
	INGREDIENT_MATCH_BASE_TOKENS,
	INGREDIENT_MATCH_MAX_NAMES,
	INGREDIENT_MATCH_TOKENS_PER_NAME,
	checkPicks,
	cleanMatchNames,
	pickMatches,
	pickUserText
} from './match';
import { INGREDIENT_PICK_SYSTEM, INGREDIENT_PICK_TASK } from './prompts';

afterEach(unstubLlm);

const suggestion = (name: string): IngredientSuggestion => ({
	id: `id-${name}`,
	name,
	category: 'Dairy & eggs',
	scope: 'catalog',
	matchedAlias: null
});

const milkCandidates = [suggestion('milk'), suggestion('milk powder'), suggestion('almond milk')];

describe('cleanMatchNames', () => {
	it('trims, removes blanks and repeats, and caps the count', () => {
		expect(cleanMatchNames([' whole  milk ', '', 'whole milk', 'eggs'])).toEqual([
			'whole milk',
			'eggs'
		]);
		const many = Array.from({ length: INGREDIENT_MATCH_MAX_NAMES + 3 }, (_, i) => `name ${i}`);
		expect(cleanMatchNames(many)).toHaveLength(INGREDIENT_MATCH_MAX_NAMES);
	});
});

describe('checkPicks', () => {
	const asked = new Map([
		['whole milk', milkCandidates],
		['oat drink', milkCandidates]
	]);

	it('keeps a pick in range and maps it to the candidate', () => {
		expect(checkPicks(asked, [{ name: 'whole milk', pick: 1 }])).toEqual({
			'whole milk': milkCandidates[0],
			'oat drink': null
		});
	});

	it('makes an out-of-range pick, a null pick and an unknown name null', () => {
		expect(
			checkPicks(asked, [
				{ name: 'whole milk', pick: 4 },
				{ name: 'oat drink', pick: 0 },
				{ name: 'cream', pick: 1 }
			])
		).toEqual({ 'whole milk': null, 'oat drink': null });
		expect(checkPicks(asked, [{ name: 'whole milk', pick: null }])['whole milk']).toBeNull();
	});

	it('keeps the first answer for a repeated name', () => {
		const out = checkPicks(asked, [
			{ name: 'whole milk', pick: null },
			{ name: 'whole milk', pick: 1 }
		]);
		expect(out['whole milk']).toBeNull();
	});
});

describe('pickMatches', () => {
	it('makes no request and claims no quota when no name has candidates', async () => {
		const { requests } = stubLlm([JSON.stringify({ picks: [] })]);
		const claim = vi.fn();
		const out = await pickMatches(new Map([['dragon fruit', []]]), claim);
		expect(out).toEqual({ 'dragon fruit': null });
		expect(claim).not.toHaveBeenCalled();
		expect(requests).toHaveLength(0);
	});

	it('asks only about names with candidates, with max_tokens set', async () => {
		const { requests } = stubLlm([JSON.stringify({ picks: [{ name: 'whole milk', pick: 1 }] })]);
		const claim = vi.fn();
		const out = await pickMatches(
			new Map([
				['whole milk', milkCandidates],
				['dragon fruit', []]
			]),
			claim
		);
		expect(claim).toHaveBeenCalledTimes(1);
		expect(out).toEqual({ 'whole milk': milkCandidates[0], 'dragon fruit': null });
		expect(requests).toHaveLength(1);
		expect(requests[0].max_tokens).toBe(
			INGREDIENT_MATCH_BASE_TOKENS + INGREDIENT_MATCH_TOKENS_PER_NAME
		);
		expect(requests[0].messages[0].content).toBe(INGREDIENT_PICK_SYSTEM);
		const text = requests[0].messages.at(-1)!.content;
		expect(text).toBe(pickUserText(new Map([['whole milk', milkCandidates]])));
		expect(text).toBe(
			`${INGREDIENT_PICK_TASK}1. whole milk\n   1) milk\n   2) milk powder\n   3) almond milk`
		);
		expect(text).not.toContain('dragon fruit');
	});
});
