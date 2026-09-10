import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import { formatQuantity, type Convention } from './units';
import {
	UNIT_SYSTEMS,
	UNIT_SYSTEM_LABEL,
	displayQuantity,
	isUnitSystem,
	type UnitSystem
} from './display-units';

const d = (v: string) => Dec.from(v);
const text = (
	v: string | null,
	unit: string | null,
	sys: UnitSystem,
	conv: Convention = 'metric'
) => displayQuantity(v === null ? null : d(v), unit, sys, conv).text;

describe('unit system catalog', () => {
	it('lists the three systems and guards unknown values', () => {
		expect(UNIT_SYSTEMS).toEqual(['as-written', 'metric', 'us']);
		expect(isUnitSystem('metric')).toBe(true);
		expect(isUnitSystem('us')).toBe(true);
		expect(isUnitSystem('as-written')).toBe(true);
		expect(isUnitSystem('imperial')).toBe(false);
		expect(isUnitSystem('')).toBe(false);
		expect(UNIT_SYSTEM_LABEL['us']).toBeTruthy();
	});
});

describe('as-written is a pure passthrough', () => {
	it('matches formatQuantity exactly for every kind of unit', () => {
		for (const [amount, unit] of [
			['250', 'g'],
			['1500', 'g'],
			['1.5', 'cup'],
			['3', 'clove'],
			['2', 'piece'],
			['0.5', null]
		] as const) {
			expect(text(amount, unit, 'as-written')).toBe(formatQuantity(Dec.from(amount), unit));
		}
	});

	it('never marks a passthrough as approximate', () => {
		expect(displayQuantity(d('137'), 'g', 'as-written', 'metric').approx).toBe(false);
	});
});

describe('values that must never be converted', () => {
	it('keeps an unknown amount unknown in every system', () => {
		for (const sys of UNIT_SYSTEMS) {
			expect(text(null, 'g', sys)).toBe('unknown amount');
			expect(displayQuantity(null, 'g', sys, 'metric').amount).toBeNull();
		}
	});

	it('leaves package units alone because they have no known size', () => {
		expect(text('3', 'clove', 'us')).toBe('3 cloves');
		expect(text('1', 'can', 'metric')).toBe('1 can');
		expect(text('2', 'pinch', 'us')).toBe('2 pinches');
		expect(displayQuantity(d('3'), 'clove', 'us', 'metric').approx).toBe(false);
	});

	it('leaves counts alone', () => {
		expect(text('2', 'piece', 'us')).toBe('2 pieces');
		expect(text('1', 'piece', 'metric')).toBe('1 piece');
	});

	it('leaves amounts with no unit, or an unrecognised unit, alone', () => {
		expect(text('0.5', null, 'us')).toBe('0.5');
		expect(text('2', 'furlong', 'us')).toBe('2 furlong');
	});

	it('is exact when the target unit is the one already written', () => {
		expect(text('137', 'g', 'metric')).toBe('137 g');
		expect(text('237', 'ml', 'metric')).toBe('237 ml');
		expect(displayQuantity(d('137'), 'g', 'metric', 'metric').approx).toBe(false);
	});
});

describe('mass converts to mass, never to volume', () => {
	it('climbs the metric ladder', () => {
		expect(text('0.5', 'g', 'metric')).toBe('500 mg');
		expect(text('500', 'g', 'metric')).toBe('500 g');
		expect(text('1500', 'g', 'metric')).toBe('1.5 kg');
		expect(text('2', 'kg', 'metric')).toBe('2 kg');
	});

	it('climbs the US ladder', () => {
		expect(text('200', 'g', 'us')).toBe('~7 oz');
		expect(text('137', 'g', 'us')).toBe('~4.75 oz');
		expect(text('500', 'g', 'us')).toBe('~1.1 lb');
		expect(text('1', 'kg', 'us')).toBe('~2.2 lb');
	});

	it('converts US mass back to metric', () => {
		expect(text('1', 'lb', 'metric')).toBe('~455 g');
		expect(text('8', 'oz', 'metric')).toBe('~225 g');
	});

	it('does not reach for cups even when the ingredient is a dry good', () => {
		expect(text('250', 'g', 'us')).not.toContain('cup');
	});
});

describe('volume converts to volume', () => {
	it('picks tsp, tbsp or cup by magnitude', () => {
		// Under a metric convention these land exactly, so no tilde.
		expect(text('5', 'ml', 'us')).toBe('1 tsp');
		expect(text('15', 'ml', 'us')).toBe('1 tbsp');
		expect(text('250', 'ml', 'us')).toBe('1 cup');
	});

	it('uses the cup size the recipe convention specifies', () => {
		// 295.735 ml is exactly 1 1/4 US cups, but only 1.18 metric cups.
		expect(text('295.735', 'ml', 'us', 'us')).toBe('1 1/4 cups');
		expect(text('295.735', 'ml', 'us', 'metric')).toBe('~1 1/8 cups');
	});

	it('snaps cups to the fractions a measuring set actually has', () => {
		expect(text('125', 'ml', 'us')).toBe('1/2 cup');
		expect(text('80', 'ml', 'us')).toBe('~1/3 cup');
		expect(text('300', 'ml', 'us')).toBe('~1 1/4 cups');
		expect(text('160', 'ml', 'us')).toBe('~2/3 cup');
	});

	it('never invents a fraction a measuring cup does not have', () => {
		for (const ml of ['60', '90', '110', '140', '175', '200', '220', '290']) {
			const t = text(ml, 'ml', 'us');
			const frac = /(\d+)\/(\d+)/.exec(t);
			if (frac) expect(['1/8', '1/4', '1/3', '1/2', '2/3', '3/4', '7/8']).toContain(frac[0]);
		}
	});

	it('snaps spoons to spoon fractions', () => {
		expect(text('2', 'ml', 'us')).toBe('~1/2 tsp');
	});

	it('converts US volume back to metric', () => {
		expect(text('1', 'cup', 'metric')).toBe('250 ml');
		expect(text('1', 'tsp', 'metric')).toBe('5 ml');
		expect(text('1', 'tbsp', 'metric')).toBe('15 ml');
		expect(text('2', 'l', 'metric')).toBe('2 l');
		expect(text('1200', 'ml', 'metric')).toBe('1.2 l');
	});

	it('honours the recipe convention for cup and spoon sizes', () => {
		expect(text('1', 'cup', 'metric', 'metric')).toBe('250 ml');
		expect(text('1', 'cup', 'metric', 'us')).toBe('~235 ml');
		expect(displayQuantity(d('1'), 'tbsp', 'metric', 'metric').approx).toBe(false);
	});
});

describe('the approximate flag is honest', () => {
	it('is false when the conversion lands exactly', () => {
		const r = displayQuantity(d('1'), 'tsp', 'metric', 'metric');
		expect(r.approx).toBe(false);
		expect(r.text).toBe('5 ml');
	});

	it('is true whenever snapping moved the value', () => {
		expect(displayQuantity(d('80'), 'ml', 'us', 'metric').approx).toBe(true);
		expect(displayQuantity(d('200'), 'g', 'us', 'metric').approx).toBe(true);
		expect(displayQuantity(d('250'), 'ml', 'us', 'us').approx).toBe(true);
	});

	it('prefixes approximate text with a tilde and exact text without one', () => {
		expect(text('80', 'ml', 'us').startsWith('~')).toBe(true);
		expect(text('1', 'tsp', 'metric').startsWith('~')).toBe(false);
	});
});

describe('pluralisation reads like English', () => {
	it('uses the singular at or below one and the plural above it', () => {
		expect(text('125', 'ml', 'us')).toBe('1/2 cup');
		expect(text('250', 'ml', 'us')).toBe('1 cup');
		expect(text('300', 'ml', 'us')).toContain('cups');
	});
});

const SAMPLES = ['7', '23.5', '80', '137', '250', '500', '1200'];

function drift(amount: string, unit: string, sys: 'metric' | 'us') {
	const r = displayQuantity(d(amount), unit, sys, 'metric');
	expect(r.amount).not.toBeNull();
	expect(r.unit).not.toBeNull();
	expect(r.amount!.isPositive()).toBe(true);
	return r.exact!.sub(r.amount!).abs().div(r.exact!);
}

describe('conversion stays close to the exact value', () => {
	it('keeps mass within 3%, since scales are decimal', () => {
		for (const s of SAMPLES) {
			for (const sys of ['metric', 'us'] as const) {
				expect(drift(s, 'g', sys).lte(Dec.from('0.03'))).toBe(true);
			}
		}
	});

	it('keeps volume within 15%, the price of real measuring-cup fractions', () => {
		for (const s of SAMPLES) {
			for (const sys of ['metric', 'us'] as const) {
				expect(drift(s, 'ml', sys).lte(Dec.from('0.15'))).toBe(true);
			}
		}
	});

	it('is monotonic: more of an ingredient never displays as less', () => {
		for (const unit of ['g', 'ml']) {
			for (const sys of ['metric', 'us'] as const) {
				let prev: { unit: string; amount: Dec } | null = null;
				for (let n = 5; n <= 1000; n += 5) {
					const r = displayQuantity(d(String(n)), unit, sys, 'metric');
					// Only comparable while the displayed unit holds; a rung change
					// (g to kg, tbsp to cup) restarts the sequence.
					if (prev && prev.unit === r.unit) {
						expect(r.amount!.gte(prev.amount)).toBe(true);
					}
					prev = { unit: r.unit!, amount: r.amount! };
				}
			}
		}
	});

	it('never renders a positive amount as zero', () => {
		expect(text('0.01', 'ml', 'us')).not.toMatch(/^~?0 /);
		expect(text('0.001', 'g', 'us')).not.toMatch(/^~?0 /);
	});
});
