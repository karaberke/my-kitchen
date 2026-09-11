import { describe, expect, it } from 'vitest';
import { matchCandidates } from './ingredient-name';

describe('matchCandidates', () => {
	it('starts with the normalized name', () => {
		expect(matchCandidates('Sea Salt')[0]).toBe('sea salt');
	});

	it('offers the name without the text in brackets', () => {
		expect(matchCandidates('sea salt (fine)')).toContain('sea salt');
	});

	it('offers the name cut at the first comma', () => {
		expect(matchCandidates('heavy cream, cold')).toContain('heavy cream');
	});

	it('offers the name with brackets and comma both removed', () => {
		expect(matchCandidates('flour (plain), sifted')).toContain('flour');
	});

	it('offers the singular form', () => {
		expect(matchCandidates('apples')).toContain('apple');
		expect(matchCandidates('tomatoes')).toContain('tomato');
		expect(matchCandidates('berries')).toContain('berry');
	});

	it('keeps a name that ends in double s', () => {
		expect(matchCandidates('cress')).toEqual(['cress']);
	});

	it('gives no candidate for a name without letters or numbers', () => {
		expect(matchCandidates('   ')).toEqual([]);
		expect(matchCandidates('()')).toEqual([]);
	});

	it('lists each candidate one time only', () => {
		const out = matchCandidates('milk');
		expect(out).toEqual([...new Set(out)]);
	});

	it('does not split a name that holds a choice', () => {
		expect(matchCandidates('sugar or honey')).not.toContain('sugar');
	});
});
