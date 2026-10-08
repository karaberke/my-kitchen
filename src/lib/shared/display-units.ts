import { Dec } from './decimal';
import { convertAmount, formatQuantity, unitInfo, unitLabel, type Convention } from './units';

/**
 * A display-time unit system. This is deliberately NOT the same thing as
 * `Convention`: a convention says how big a cup is (250 ml metric, 236.588 ml
 * US) and is stored per recipe, whereas a system says which units the reader
 * wants to *see* right now. Conversions below take the convention as an input
 * and never change it.
 *
 * `as-written` renders exactly what was entered and is the default, so a
 * recipe always has an untouched representation to fall back to.
 */
export type UnitSystem = 'as-written' | 'metric' | 'us';

export const UNIT_SYSTEMS: readonly UnitSystem[] = ['as-written', 'metric', 'us'];

export const UNIT_SYSTEM_LABEL: Record<UnitSystem, string> = {
	'as-written': 'As written',
	metric: 'Metric',
	us: 'US'
};

export function isUnitSystem(value: string): value is UnitSystem {
	return (UNIT_SYSTEMS as readonly string[]).includes(value);
}

export interface DisplayQuantity {
	/** Ready to render, e.g. "~1 1/8 cups". */
	text: string;
	/** The snapped amount actually shown, in `unit`. Null when unknown. */
	amount: Dec | null;
	/** The unit actually shown. Null when the amount has no unit. */
	unit: string | null;
	/** The unrounded conversion, kept for tests and for exact-value tooltips. */
	exact: Dec | null;
	/** True when snapping moved the value, i.e. the text is approximate. */
	approx: boolean;
}

/**
 * Ladders are ordered smallest-first. The first rung whose upper bound the
 * value fits under wins, so quantities land on the unit a cook would reach
 * for rather than on 0.004 l or 37 tsp.
 */
interface Rung {
	unit: string;
	/** Use this rung while the amount expressed in it is below `below`. */
	below?: Dec;
}

const LADDERS: Record<'metric' | 'us', Record<'mass' | 'volume', Rung[]>> = {
	metric: {
		mass: [
			{ unit: 'mg', below: Dec.from('1000') },
			{ unit: 'g', below: Dec.from('1000') },
			{ unit: 'kg' }
		],
		volume: [{ unit: 'ml', below: Dec.from('1000') }, { unit: 'l' }]
	},
	us: {
		mass: [{ unit: 'oz', below: Dec.from('16') }, { unit: 'lb' }],
		volume: [
			{ unit: 'tsp', below: Dec.from('3') },
			{ unit: 'tbsp', below: Dec.from('4') },
			{ unit: 'cup' }
		]
	}
};

/**
 * Fractions a physical measuring set can actually produce. Snapping to these
 * is why "1/3 cup" appears at all — a plain eighths grid would round it to
 * 3/8 and read wrong to anyone holding a measuring cup.
 */
const FRACTION_PAIRS: Record<string, ReadonlyArray<readonly [number, number]>> = {
	cup: [
		[0, 1],
		[1, 8],
		[1, 4],
		[1, 3],
		[1, 2],
		[2, 3],
		[3, 4],
		[7, 8],
		[1, 1]
	],
	tsp: [
		[0, 1],
		[1, 8],
		[1, 4],
		[1, 2],
		[3, 4],
		[1, 1]
	],
	tbsp: [
		[0, 1],
		[1, 2],
		[1, 1]
	]
};

interface Fraction {
	num: number;
	den: number;
	/** num / den, parsed one time */
	value: Dec;
}

const NO_FRACTION: Fraction = { num: 0, den: 1, value: Dec.zero };

const FRACTION_SETS: Record<string, readonly Fraction[]> = Object.fromEntries(
	Object.entries(FRACTION_PAIRS).map(([unit, pairs]) => [
		unit,
		pairs.map(([num, den]) => ({ num, den, value: Dec.from(num).div(Dec.from(den)) }))
	])
);

/** Decimal snap steps for units that are measured on a scale, not in a cup. */
const STEPS: Record<string, ReadonlyArray<readonly [Dec, Dec]>> = {
	// [above, step] — first matching row from the top wins.
	mg: [[Dec.zero, Dec.from('1')]],
	g: [
		[Dec.from('100'), Dec.from('5')],
		[Dec.from('10'), Dec.from('1')],
		[Dec.zero, Dec.from('0.5')]
	],
	kg: [[Dec.zero, Dec.from('0.01')]],
	oz: [
		[Dec.one, Dec.from('0.25')],
		[Dec.zero, Dec.from('0.05')]
	],
	lb: [[Dec.zero, Dec.from('0.05')]],
	ml: [
		[Dec.from('100'), Dec.from('5')],
		[Dec.from('10'), Dec.from('1')],
		[Dec.zero, Dec.from('0.5')]
	],
	l: [[Dec.zero, Dec.from('0.1')]]
};

function passthrough(amount: Dec | null, unit: string | null): DisplayQuantity {
	return {
		text: formatQuantity(amount, unit),
		amount,
		unit,
		exact: amount,
		approx: false
	};
}

function roundToStep(value: Dec, step: Dec): Dec {
	const snapped = value.div(step).round().mul(step);
	// A positive amount must never display as nothing at all.
	return snapped.isZero() && value.isPositive() ? step : snapped;
}

function pickRung(exactBase: Dec, ladder: Rung[], convention: Convention, from: string): Rung {
	for (const rung of ladder) {
		if (!rung.below) return rung;
		const inRung = convertAmount(exactBase, from, rung.unit, convention);
		if (inRung && inRung.abs().lt(rung.below)) return rung;
	}
	return ladder[ladder.length - 1]!;
}

interface Snapped {
	value: Dec;
	/** Rendered number, e.g. "1 1/4" or "4.75". */
	text: string;
}

function snapToFractions(value: Dec, set: readonly Fraction[]): Snapped | null {
	// Only positive values reach this, so truncation is the floor.
	const whole = value.trunc();
	const frac = value.sub(whole);
	let best: Fraction | null = null;
	let bestDiff: Dec | null = null;
	for (const cand of set) {
		const diff = frac.sub(cand.value).abs();
		if (bestDiff === null || diff.lt(bestDiff)) {
			best = cand;
			bestDiff = diff;
		}
	}
	if (!best) return null;
	let pick = best;
	let intPart = whole;
	if (pick.num === pick.den) {
		// Rounded up to the next whole unit.
		intPart = intPart.add(Dec.one);
		pick = NO_FRACTION;
	}
	// A positive amount must never display as nothing at all.
	if (intPart.isZero() && pick.num === 0 && value.isPositive()) {
		pick = set.find((c) => c.num !== 0)!;
	}
	const { num, den } = pick;
	const snappedValue = intPart.add(pick.value);
	let text: string;
	if (num === 0) text = intPart.toHuman();
	else if (intPart.isZero()) text = `${num}/${den}`;
	else text = `${intPart.toHuman()} ${num}/${den}`;
	return { value: snappedValue, text };
}

function snapDecimal(value: Dec, unit: string): Snapped {
	const rows = STEPS[unit];
	if (!rows) return { value, text: value.toHuman() };
	const abs = value.abs();
	let step = rows[rows.length - 1]![1];
	for (const [above, candidate] of rows) {
		if (abs.gte(above)) {
			step = candidate;
			break;
		}
	}
	const snapped = roundToStep(value, step);
	return { value: snapped, text: snapped.toHuman() };
}

/**
 * Render an amount in the reader's chosen unit system.
 *
 * Conversion stays inside its dimension: mass becomes mass, volume becomes
 * volume. Volume is never turned into mass, because that needs an
 * ingredient-specific density that most ingredients do not have, and a
 * half-populated recipe reads worse than a consistent one. Package units
 * (can, clove, pinch) and counts have no known size and are never touched.
 */
export function displayQuantity(
	amount: Dec | null | undefined,
	unit: string | null | undefined,
	system: UnitSystem,
	convention: Convention = 'metric'
): DisplayQuantity {
	const value = amount ?? null;
	const from = unit ?? null;

	if (value === null) {
		return {
			text: formatQuantity(null, from),
			amount: null,
			unit: from,
			exact: null,
			approx: false
		};
	}
	if (system === 'as-written' || from === null) return passthrough(value, from);

	const info = unitInfo(from);
	if (!info) return passthrough(value, from);
	if (info.dimension === 'package' || info.dimension === 'count') return passthrough(value, from);
	if (!value.isPositive()) return passthrough(value, from);

	const ladder = LADDERS[system][info.dimension];
	const rung = pickRung(value, ladder, convention, from);

	// Selecting the system a recipe was written in must not re-round a value
	// that is already in the target unit: 137 g stays 137 g, never 135 g.
	// Cup and spoon amounts are the exception, because their fraction rendering
	// is exact rather than lossy — 0.25 cup and 1/4 cup are the same number,
	// one is just the one you can measure.
	if (rung.unit === from && !FRACTION_SETS[rung.unit]) return passthrough(value, from);

	const exact = convertAmount(value, from, rung.unit, convention);
	if (!exact) return passthrough(value, from);

	const fractions = FRACTION_SETS[rung.unit];
	const snapped = (fractions && snapToFractions(exact, fractions)) ?? snapDecimal(exact, rung.unit);

	const approx = !snapped.value.eq(exact);
	const text = `${approx ? '~' : ''}${snapped.text} ${unitLabel(rung.unit, snapped.value)}`;
	return { text, amount: snapped.value, unit: rung.unit, exact, approx };
}
