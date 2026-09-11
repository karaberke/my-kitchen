import { Dec } from './decimal';

export type StockStatus = 'available' | 'partial' | 'missing' | 'unknown';

/**
 * Availability indicator for one recipe ingredient at the current scale.
 * - missing: the pantry holds none of this ingredient
 * - unknown: no pantry, no identity, or stock only in incompatible units
 */
export function stockStatus(input: {
	hasPantry: boolean;
	hasIdentity: boolean;
	scaledAmount: Dec | null;
	available: Dec | null;
	otherStockCount: number;
}): StockStatus {
	if (!input.hasPantry || !input.hasIdentity) return 'unknown';
	const none = input.otherStockCount ? 'unknown' : 'missing';
	if (input.available === null) return none;
	if (!input.available.isPositive()) return none;
	if (input.scaledAmount === null) return 'available';
	return input.available.gte(input.scaledAmount) ? 'available' : 'partial';
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
	available: 'In pantry',
	partial: 'Partly in pantry',
	missing: 'Not in pantry',
	unknown: 'Check while cooking'
};
