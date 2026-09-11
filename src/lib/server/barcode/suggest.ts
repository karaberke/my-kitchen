/**
 * Turn a lookup into the values the confirmation screen starts from.
 *
 * Nothing here decides anything: every field is a suggestion the user edits
 * and then confirms. What the household saved before always wins over what a
 * provider says, so a correction is never undone by a refresh.
 */

import { Dec } from '$lib/shared/decimal';
import {
	packageSizeSuggestion,
	type PackageSizeReason,
	type PackageSizeSuggestion
} from '$lib/shared/package-size';
import type { BarcodeLookup } from './lookup';

export interface ScanSuggestion {
	/** The ingredient this household linked before, if any. */
	ingredientId: string | null;
	/** The name to show, and to prefill a new ingredient with. */
	name: string;
	brand: string;
	/** What one package holds. Null means the user must type it. */
	packageQuantity: string | null;
	packageUnit: string | null;
	packageCount: number;
	/** The net contents exactly as the label states them. */
	packageLabelText: string;
	/** Where these values came from, for the badge beside them. */
	from: 'household' | 'usda' | 'off' | 'none';
	/** Why no package size is offered, when none is. */
	sizeReason?: PackageSizeReason;
}

function fromProvider(lookup: BarcodeLookup): {
	size: PackageSizeSuggestion;
	name: string;
	brand: string;
} {
	const p = lookup.product;
	if (!p)
		return {
			size: packageSizeSuggestion(null, ''),
			name: '',
			brand: ''
		};
	return {
		size: packageSizeSuggestion(
			{ amount: p.packageAmount === null ? null : Dec.from(p.packageAmount), unit: p.packageUnit },
			p.packageLabelText
		),
		name: p.name,
		brand: p.brand
	};
}

export function suggestionFor(lookup: BarcodeLookup): ScanSuggestion {
	const provider = fromProvider(lookup);
	const link = lookup.link;

	if (link) {
		return {
			ingredientId: link.ingredientId,
			name: link.displayName || link.ingredientName,
			brand: link.brand,
			packageQuantity: link.defaultQuantity,
			packageUnit: link.defaultUnit,
			packageCount: link.defaultPackageCount,
			// Prefer what the household recorded; fall back to the provider's text.
			packageLabelText: link.packageLabelText || provider.size.labelText,
			from: 'household'
		};
	}

	return {
		ingredientId: null,
		name: provider.name,
		brand: provider.brand,
		packageQuantity: provider.size.size ? provider.size.size.amount.toString() : null,
		packageUnit: provider.size.size?.unit ?? null,
		packageCount: provider.size.packagesInLabel,
		packageLabelText: provider.size.labelText,
		from: lookup.product ? lookup.product.source : 'none',
		sizeReason: provider.size.size ? undefined : provider.size.reason
	};
}
