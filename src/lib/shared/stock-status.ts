import { Dec } from './decimal';

export type StockStatus = 'available' | 'partial' | 'missing' | 'untracked' | 'unknown';

/**
 * Availability indicator for one recipe ingredient at the current scale.
 * - unknown: no identity, no amount, or stock only in incompatible units
 * - untracked: identity known but nothing in the pantry
 */
export function stockStatus(input: {
	hasIdentity: boolean;
	scaledAmount: Dec | null;
	available: Dec | null;
	tracked: boolean;
	otherStockCount: number;
}): StockStatus {
	if (!input.hasIdentity || input.scaledAmount === null) return 'unknown';
	if (!input.tracked) return 'untracked';
	if (input.available === null) return input.otherStockCount ? 'unknown' : 'untracked';
	if (input.available.gte(input.scaledAmount)) return 'available';
	if (input.available.isPositive()) return 'partial';
	return input.otherStockCount ? 'unknown' : 'missing';
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
	available: 'In pantry',
	partial: 'Partly in pantry',
	missing: 'Missing',
	untracked: 'Not tracked in pantry',
	unknown: 'Check while cooking'
};
