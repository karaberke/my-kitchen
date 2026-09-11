import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import { stockStatus, STOCK_STATUS_LABEL } from './stock-status';

const d = (s: string) => Dec.from(s);
const input = (over: Partial<Parameters<typeof stockStatus>[0]> = {}) => ({
	hasPantry: true,
	hasIdentity: true,
	scaledAmount: d('500'),
	available: d('800'),
	otherStockCount: 0,
	...over
});

describe('stockStatus', () => {
	it('is available when the pantry holds enough', () => {
		expect(stockStatus(input({ available: d('800') }))).toBe('available');
		expect(stockStatus(input({ available: d('500') }))).toBe('available');
	});

	it('is partial when the pantry holds less than the recipe needs', () => {
		expect(stockStatus(input({ available: d('300') }))).toBe('partial');
	});

	it('is missing when the pantry holds none of the ingredient', () => {
		expect(stockStatus(input({ available: null }))).toBe('missing');
		expect(stockStatus(input({ available: d('0') }))).toBe('missing');
	});

	it('is available when the recipe gives no amount but the pantry holds some', () => {
		expect(stockStatus(input({ scaledAmount: null, available: d('9') }))).toBe('available');
	});

	it('is missing when the recipe gives no amount and the pantry holds none', () => {
		expect(stockStatus(input({ scaledAmount: null, available: null }))).toBe('missing');
	});

	it('is unknown when stock exists only in units that do not convert', () => {
		expect(stockStatus(input({ available: null, otherStockCount: 1 }))).toBe('unknown');
		expect(stockStatus(input({ available: d('0'), otherStockCount: 1 }))).toBe('unknown');
	});

	it('is unknown when the ingredient has no pantry identity', () => {
		expect(stockStatus(input({ hasIdentity: false, available: null }))).toBe('unknown');
	});

	it('is unknown when the viewer has no pantry', () => {
		expect(stockStatus(input({ hasPantry: false, available: null }))).toBe('unknown');
		expect(stockStatus(input({ hasPantry: false, available: d('800') }))).toBe('unknown');
	});
});

describe('STOCK_STATUS_LABEL', () => {
	it('names a missing ingredient as absent from the pantry', () => {
		expect(STOCK_STATUS_LABEL.missing).toBe('Not in pantry');
	});
});
