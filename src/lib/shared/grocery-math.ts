import { Dec } from './decimal';
import { scaleAmount } from './scaling';
import { normalizeName } from './text';
import { convertAmount, unitInfo, unitsCompatible, type Convention } from './units';

export interface PlanRequirement {
	ingredientId: string | null;
	name: string;
	baseAmount: Dec | null;
	unit: string | null;
	optional: boolean;
	include: boolean;
}

export interface PlanBatch {
	batchId: string;
	recipeTitle: string;
	baseServings: Dec;
	servings: Dec;
	fulfilledServings?: Dec;
	convention: Convention;
	requirements: PlanRequirement[];
}

export interface StockLotInput {
	lotId: string;
	ingredientId: string;
	quantity: Dec;
	unit: string;
}

export interface ManualLineInput {
	lineId: string;
	ingredientId: string | null;
	name: string;
	unit: string | null;
	requested: Dec | null;
	subtractPantry: boolean;
}

export interface PlanOptions {
	/** grams per ml by ingredient id, enabling volume<->mass merging */
	densities?: Record<string, Dec>;
	/** convention used to convert pantry lot units */
	stockConvention?: Convention;
}

export type UnresolvedReason = 'unknown_amount' | 'no_identity' | 'incompatible_stock_units';

export interface PlanSource {
	batchId: string;
	recipeTitle: string;
	amount: string | null;
	unit: string | null;
}

export interface OtherStock {
	quantity: string;
	unit: string;
}

export interface PlanLine {
	key: string;
	ingredientId: string | null;
	name: string;
	unit: string | null;
	demand: Dec | null;
	stockConsidered: Dec | null;
	suggested: Dec | null;
	unresolvedReason: UnresolvedReason | null;
	otherStock: OtherStock[];
	sources: PlanSource[];
}

export interface ManualPlanLine {
	lineId: string;
	stockConsidered: Dec | null;
	suggested: Dec | null;
	otherStock: OtherStock[];
}

export interface PlanResult {
	lines: PlanLine[];
	manual: ManualPlanLine[];
	skippedOptional: { batchId: string; name: string }[];
}

function dimensionKey(unit: string): string {
	const info = unitInfo(unit);
	if (!info) return `unit:${unit}`;
	return info.dimension === 'package' ? `unit:${unit}` : `dim:${info.dimension}`;
}

interface StockView {
	considered: Dec;
	other: OtherStock[];
}

function stockFor(
	ingredientId: string,
	unit: string,
	stock: StockLotInput[],
	options: PlanOptions
): StockView {
	const convention = options.stockConvention ?? 'metric';
	const density = options.densities?.[ingredientId] ?? null;
	let considered = Dec.zero;
	const other: OtherStock[] = [];
	for (const lot of stock) {
		if (lot.ingredientId !== ingredientId) continue;
		if (!lot.quantity.isPositive()) continue;
		let converted: Dec | null = null;
		if (unitsCompatible(lot.unit, unit)) {
			converted = convertAmount(lot.quantity, lot.unit, unit, convention);
		} else if (density) {
			converted = convertAmount(lot.quantity, lot.unit, unit, convention, { gramsPerMl: density });
		}
		if (converted) considered = considered.add(converted);
		else other.push({ quantity: lot.quantity.toString(), unit: lot.unit });
	}
	return { considered, other };
}

/**
 * Pure grocery planning: aggregate every batch's remaining demand first, then
 * subtract current stock exactly once per line. Unknown amounts, rows without
 * a confirmed identity and incompatible units are preserved for review.
 */
export function computePlan(
	batches: PlanBatch[],
	stock: StockLotInput[],
	manualLines: ManualLineInput[],
	options: PlanOptions = {}
): PlanResult {
	const lines = new Map<string, PlanLine & { _convention: Convention }>();
	const skippedOptional: { batchId: string; name: string }[] = [];

	for (const batch of batches) {
		const remainingServings = batch.servings.sub(batch.fulfilledServings ?? Dec.zero);
		if (!remainingServings.isPositive()) continue;
		for (const req of batch.requirements) {
			if (req.optional && !req.include) {
				skippedOptional.push({ batchId: batch.batchId, name: req.name });
				continue;
			}
			const scaled = scaleAmount(req.baseAmount, batch.baseServings, remainingServings);
			const source: PlanSource = {
				batchId: batch.batchId,
				recipeTitle: batch.recipeTitle,
				amount: scaled ? scaled.toString() : null,
				unit: req.unit
			};

			if (!req.ingredientId) {
				const key = `name:${normalizeName(req.name)}|${req.unit ?? ''}`;
				const line = lines.get(key) ?? {
					key,
					ingredientId: null,
					name: req.name,
					unit: req.unit,
					demand: scaled ? Dec.zero : null,
					stockConsidered: null,
					suggested: null,
					unresolvedReason: 'no_identity' as UnresolvedReason,
					otherStock: [],
					sources: [],
					_convention: batch.convention
				};
				if (scaled && line.demand) line.demand = line.demand.add(scaled);
				line.sources.push(source);
				lines.set(key, line);
				continue;
			}

			if (scaled === null || req.unit === null) {
				const key = `unknown:${req.ingredientId}`;
				const line = lines.get(key) ?? {
					key,
					ingredientId: req.ingredientId,
					name: req.name,
					unit: null,
					demand: null,
					stockConsidered: null,
					suggested: null,
					unresolvedReason: 'unknown_amount' as UnresolvedReason,
					otherStock: [],
					sources: [],
					_convention: batch.convention
				};
				line.sources.push(source);
				lines.set(key, line);
				continue;
			}

			const density = options.densities?.[req.ingredientId] ?? null;
			let dim = dimensionKey(req.unit);
			// Merge volume into an existing mass line (or vice versa) when density is known.
			if (density) {
				const info = unitInfo(req.unit);
				if (info?.dimension === 'volume' && lines.has(`${req.ingredientId}|dim:mass`))
					dim = 'dim:mass';
				if (info?.dimension === 'mass' && lines.has(`${req.ingredientId}|dim:volume`)) {
					// Fold the existing volume line into a new mass line.
					const volumeKey = `${req.ingredientId}|dim:volume`;
					const volumeLine = lines.get(volumeKey)!;
					lines.delete(volumeKey);
					const massKey = `${req.ingredientId}|dim:mass`;
					const merged = {
						...volumeLine,
						key: massKey,
						unit: req.unit,
						demand: Dec.zero,
						sources: [] as PlanSource[]
					};
					lines.set(massKey, merged);
					for (const s of volumeLine.sources) {
						const amt = s.amount ? Dec.from(s.amount) : null;
						const conv =
							amt && s.unit
								? convertAmount(amt, s.unit, req.unit, volumeLine._convention, {
										gramsPerMl: density
									})
								: null;
						if (conv) merged.demand = merged.demand!.add(conv);
						merged.sources.push(s);
					}
					dim = 'dim:mass';
				}
			}
			const key = `${req.ingredientId}|${dim}`;
			const line = lines.get(key) ?? {
				key,
				ingredientId: req.ingredientId,
				name: req.name,
				unit: req.unit,
				demand: Dec.zero,
				stockConsidered: Dec.zero,
				suggested: Dec.zero,
				unresolvedReason: null,
				otherStock: [],
				sources: [],
				_convention: batch.convention
			};
			const converted = convertAmount(scaled, req.unit, line.unit!, batch.convention, {
				gramsPerMl: density
			});
			if (converted === null) {
				// Should not happen (same dimension), but keep the row visible rather than dropping it.
				const fallbackKey = `${req.ingredientId}|unit:${req.unit}`;
				const fb = lines.get(fallbackKey) ?? {
					...line,
					key: fallbackKey,
					unit: req.unit,
					demand: Dec.zero,
					sources: []
				};
				fb.demand = fb.demand!.add(scaled);
				fb.sources.push(source);
				lines.set(fallbackKey, fb);
				continue;
			}
			line.demand = line.demand!.add(converted);
			line.sources.push(source);
			lines.set(key, line);
		}
	}

	const result: PlanLine[] = [];
	for (const line of lines.values()) {
		if (line.ingredientId && line.unit && line.demand) {
			const view = stockFor(line.ingredientId, line.unit, stock, options);
			line.stockConsidered = view.considered;
			line.otherStock = view.other;
			line.suggested = Dec.max(Dec.zero, line.demand.sub(view.considered));
			if (view.other.length && !line.unresolvedReason)
				line.unresolvedReason = 'incompatible_stock_units';
		} else if (line.unresolvedReason === 'no_identity') {
			line.suggested = line.demand;
		}
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { _convention, ...pub } = line;
		result.push(pub);
	}

	const manual: ManualPlanLine[] = manualLines.map((m) => {
		if (m.requested === null)
			return { lineId: m.lineId, stockConsidered: null, suggested: null, otherStock: [] };
		if (m.subtractPantry && m.ingredientId && m.unit) {
			const view = stockFor(m.ingredientId, m.unit, stock, options);
			return {
				lineId: m.lineId,
				stockConsidered: view.considered,
				suggested: Dec.max(Dec.zero, m.requested.sub(view.considered)),
				otherStock: view.other
			};
		}
		return { lineId: m.lineId, stockConsidered: null, suggested: m.requested, otherStock: [] };
	});

	return { lines: result, manual, skippedOptional };
}

/** remaining = max(0, committed target - net credited purchases) */
export function remainingTarget(target: Dec | null, purchased: Dec): Dec | null {
	if (target === null) return null;
	return Dec.max(Dec.zero, target.sub(purchased));
}
