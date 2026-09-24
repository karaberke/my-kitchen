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
import type { IdentityHit } from '$lib/server/ingredient-match';
import type { IngredientSuggestion } from '$lib/server/ingredients';
import type { BarcodeLookup } from './lookup';

/** What the provider's title points at, found by `scanBarcode`. */
export interface ScanMatch {
	/** An identity the title names with only harmless words around it. */
	proposal: IdentityHit | null;
	/** Choices to list when there is no proposal; nothing is preselected. */
	candidates: IngredientSuggestion[];
}

export const NO_SCAN_MATCH: ScanMatch = { proposal: null, candidates: [] };

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
	/** The identity proposed from the provider's title. Null with a household link. */
	proposal: IdentityHit | null;
	/** Identities to choose from when nothing is proposed. Empty with a household link. */
	candidates: IngredientSuggestion[];
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
			p.packageLabelText,
			p.servingBasis
		),
		name: p.name,
		brand: p.brand
	};
}

/**
 * The confirmation screen's starting values. `match` comes from the caller,
 * so this stays a pure function of its arguments.
 */
export function suggestionFor(
	lookup: BarcodeLookup,
	match: ScanMatch = NO_SCAN_MATCH
): ScanSuggestion {
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
			from: 'household',
			...NO_SCAN_MATCH
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
		sizeReason: provider.size.size ? undefined : provider.size.reason,
		proposal: match.proposal,
		candidates: match.proposal ? [] : match.candidates
	};
}
