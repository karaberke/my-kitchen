import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import { stockStatus } from './stock-status';

const d = (s: string) => Dec.from(s);
describe('stockStatus', () => {
	it('classifies availability', () => {
		expect(
			stockStatus({
				hasIdentity: true,
				scaledAmount: d('500'),
				available: d('800'),
				tracked: true,
				otherStockCount: 0
			})
		).toBe('available');
		expect(
			stockStatus({
				hasIdentity: true,
				scaledAmount: d('500'),
				available: d('300'),
				tracked: true,
				otherStockCount: 0
			})
		).toBe('partial');
		expect(
			stockStatus({
				hasIdentity: true,
				scaledAmount: d('500'),
				available: d('0'),
				tracked: true,
				otherStockCount: 0
			})
		).toBe('missing');
		expect(
			stockStatus({
				hasIdentity: true,
				scaledAmount: d('500'),
				available: null,
				tracked: false,
				otherStockCount: 0
			})
		).toBe('untracked');
		expect(
			stockStatus({
				hasIdentity: true,
				scaledAmount: d('500'),
				available: null,
				tracked: true,
				otherStockCount: 1
			})
		).toBe('unknown');
		expect(
			stockStatus({
				hasIdentity: false,
				scaledAmount: d('1'),
				available: null,
				tracked: false,
				otherStockCount: 0
			})
		).toBe('unknown');
		expect(
			stockStatus({
				hasIdentity: true,
				scaledAmount: null,
				available: d('9'),
				tracked: true,
				otherStockCount: 0
			})
		).toBe('unknown');
	});
});
