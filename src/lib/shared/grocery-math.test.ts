import { describe, expect, it } from 'vitest';
import { Dec } from './decimal';
import { computePlan, remainingTarget, type PlanBatch, type StockLotInput } from './grocery-math';

const d = (s: string) => Dec.from(s);

function batch(
	partial: Partial<PlanBatch> & { requirements: PlanBatch['requirements'] }
): PlanBatch {
	return {
		batchId: 'b1',
		recipeTitle: 'Test recipe',
		baseServings: d('4'),
		servings: d('4'),
		convention: 'metric',
		...partial
	};
}

const chicken = 'ing-chicken';

describe('computePlan', () => {
	it('aggregates all batches before subtracting pantry once', () => {
		const batches = [
			batch({
				batchId: 'b1',
				recipeTitle: 'Roast',
				requirements: [
					{
						ingredientId: chicken,
						name: 'chicken breast',
						baseAmount: d('500'),
						unit: 'g',
						optional: false,
						include: true
					}
				]
			}),
			batch({
				batchId: 'b2',
				recipeTitle: 'Curry',
				requirements: [
					{
						ingredientId: chicken,
						name: 'chicken breast',
						baseAmount: d('300'),
						unit: 'g',
						optional: false,
						include: true
					}
				]
			})
		];
		const stock: StockLotInput[] = [
			{ lotId: 'l1', ingredientId: chicken, quantity: d('300'), unit: 'g' }
		];
		const plan = computePlan(batches, stock, []);
		expect(plan.lines).toHaveLength(1);
		const line = plan.lines[0];
		expect(line.demand?.toString()).toBe('800');
		expect(line.stockConsidered?.toString()).toBe('300');
		expect(line.suggested?.toString()).toBe('500');
		expect(line.unit).toBe('g');
		expect(line.sources.map((s) => s.batchId).sort()).toEqual(['b1', 'b2']);
	});

	it('scales requirements by servings', () => {
		const plan = computePlan(
			[
				batch({
					servings: d('8'),
					requirements: [
						{
							ingredientId: chicken,
							name: 'chicken',
							baseAmount: d('500'),
							unit: 'g',
							optional: false,
							include: true
						}
					]
				})
			],
			[],
			[]
		);
		expect(plan.lines[0].demand?.toString()).toBe('1000');
		expect(plan.lines[0].suggested?.toString()).toBe('1000');
	});

	it('converts compatible units into the first entered unit', () => {
		const plan = computePlan(
			[
				batch({
					batchId: 'b1',
					requirements: [
						{
							ingredientId: chicken,
							name: 'chicken',
							baseAmount: d('500'),
							unit: 'g',
							optional: false,
							include: true
						}
					]
				}),
				batch({
					batchId: 'b2',
					requirements: [
						{
							ingredientId: chicken,
							name: 'chicken',
							baseAmount: d('1'),
							unit: 'kg',
							optional: false,
							include: true
						}
					]
				})
			],
			[{ lotId: 'l1', ingredientId: chicken, quantity: d('0.25'), unit: 'kg' }],
			[]
		);
		expect(plan.lines).toHaveLength(1);
		expect(plan.lines[0].unit).toBe('g');
		expect(plan.lines[0].demand?.toString()).toBe('1500');
		expect(plan.lines[0].stockConsidered?.toString()).toBe('250');
		expect(plan.lines[0].suggested?.toString()).toBe('1250');
	});

	it('keeps incompatible units as separate lines and reports other stock for review', () => {
		const milk = 'ing-milk';
		const plan = computePlan(
			[
				batch({
					batchId: 'b1',
					requirements: [
						{
							ingredientId: milk,
							name: 'coconut milk',
							baseAmount: d('400'),
							unit: 'ml',
							optional: false,
							include: true
						}
					]
				}),
				batch({
					batchId: 'b2',
					requirements: [
						{
							ingredientId: milk,
							name: 'coconut milk',
							baseAmount: d('1'),
							unit: 'can',
							optional: false,
							include: true
						}
					]
				})
			],
			[{ lotId: 'l1', ingredientId: milk, quantity: d('2'), unit: 'can' }],
			[]
		);
		expect(plan.lines).toHaveLength(2);
		const ml = plan.lines.find((l) => l.unit === 'ml')!;
		const can = plan.lines.find((l) => l.unit === 'can')!;
		expect(ml.suggested?.toString()).toBe('400');
		expect(ml.stockConsidered?.toString()).toBe('0');
		expect(ml.otherStock).toEqual([{ quantity: '2', unit: 'can' }]);
		expect(ml.unresolvedReason).toBe('incompatible_stock_units');
		expect(can.stockConsidered?.toString()).toBe('2');
		expect(can.suggested?.toString()).toBe('0');
	});

	it('uses ingredient density to merge volume into mass', () => {
		const flour = 'ing-flour';
		const plan = computePlan(
			[
				batch({
					batchId: 'b1',
					requirements: [
						{
							ingredientId: flour,
							name: 'flour',
							baseAmount: d('500'),
							unit: 'g',
							optional: false,
							include: true
						}
					]
				}),
				batch({
					batchId: 'b2',
					requirements: [
						{
							ingredientId: flour,
							name: 'flour',
							baseAmount: d('1'),
							unit: 'cup',
							optional: false,
							include: true
						}
					]
				})
			],
			[],
			[],
			{ densities: { [flour]: d('0.6') } }
		);
		expect(plan.lines).toHaveLength(1);
		expect(plan.lines[0].demand?.toString()).toBe('650');
	});

	it('keeps unknown amounts visible and outside arithmetic', () => {
		const salt = 'ing-salt';
		const plan = computePlan(
			[
				batch({
					requirements: [
						{
							ingredientId: salt,
							name: 'flaky salt',
							baseAmount: null,
							unit: null,
							optional: false,
							include: true
						},
						{
							ingredientId: salt,
							name: 'salt',
							baseAmount: d('10'),
							unit: 'g',
							optional: false,
							include: true
						}
					]
				})
			],
			[{ lotId: 'l1', ingredientId: salt, quantity: d('900'), unit: 'g' }],
			[]
		);
		const unknown = plan.lines.find((l) => l.unresolvedReason === 'unknown_amount')!;
		expect(unknown).toBeDefined();
		expect(unknown.demand).toBeNull();
		expect(unknown.suggested).toBeNull();
		const known = plan.lines.find((l) => l.unit === 'g')!;
		expect(known.suggested?.toString()).toBe('0');
	});

	it('skips optional ingredients unless explicitly included', () => {
		const plan = computePlan(
			[
				batch({
					requirements: [
						{
							ingredientId: 'a',
							name: 'parsley',
							baseAmount: d('1'),
							unit: 'bunch',
							optional: true,
							include: false
						},
						{
							ingredientId: 'b',
							name: 'onion',
							baseAmount: d('1'),
							unit: 'piece',
							optional: true,
							include: true
						}
					]
				})
			],
			[],
			[]
		);
		expect(plan.lines.map((l) => l.name)).toEqual(['onion']);
		expect(plan.skippedOptional).toEqual([{ batchId: 'b1', name: 'parsley' }]);
	});

	it('keeps rows without a confirmed identity separate and never subtracts pantry', () => {
		const plan = computePlan(
			[
				batch({
					requirements: [
						{
							ingredientId: null,
							name: 'Grandma’s spice mix',
							baseAmount: d('2'),
							unit: 'tbsp',
							optional: false,
							include: true
						}
					]
				})
			],
			[],
			[]
		);
		expect(plan.lines[0].unresolvedReason).toBe('no_identity');
		expect(plan.lines[0].suggested?.toString()).toBe('2');
		expect(plan.lines[0].stockConsidered).toBeNull();
	});

	it('does not subtract pantry from manual lines unless requested', () => {
		const plan = computePlan(
			[],
			[{ lotId: 'l1', ingredientId: 'rice', quantity: d('1000'), unit: 'g' }],
			[
				{
					lineId: 'm1',
					ingredientId: 'rice',
					name: 'rice',
					unit: 'g',
					requested: d('500'),
					subtractPantry: false
				},
				{
					lineId: 'm2',
					ingredientId: 'rice',
					name: 'rice',
					unit: 'g',
					requested: d('500'),
					subtractPantry: true
				}
			]
		);
		const m1 = plan.manual.find((m) => m.lineId === 'm1')!;
		const m2 = plan.manual.find((m) => m.lineId === 'm2')!;
		expect(m1.suggested?.toString()).toBe('500');
		expect(m1.stockConsidered).toBeNull();
		expect(m2.suggested?.toString()).toBe('0');
		expect(m2.stockConsidered?.toString()).toBe('1000');
	});

	it('excludes fully fulfilled batches and scales partially fulfilled ones by remaining servings', () => {
		const req = [
			{
				ingredientId: chicken,
				name: 'chicken',
				baseAmount: d('400'),
				unit: 'g',
				optional: false,
				include: true
			}
		];
		const plan = computePlan(
			[
				batch({ batchId: 'b1', servings: d('4'), fulfilledServings: d('4'), requirements: req }),
				batch({ batchId: 'b2', servings: d('4'), fulfilledServings: d('2'), requirements: req })
			],
			[],
			[]
		);
		expect(plan.lines).toHaveLength(1);
		expect(plan.lines[0].demand?.toString()).toBe('200');
		expect(plan.lines[0].sources).toEqual([
			{ batchId: 'b2', recipeTitle: 'Test recipe', amount: '200', unit: 'g' }
		]);
	});
});

describe('remainingTarget', () => {
	it('never goes below zero', () => {
		expect(remainingTarget(d('500'), d('200'))!.toString()).toBe('300');
		expect(remainingTarget(d('500'), d('1200'))!.toString()).toBe('0');
		expect(remainingTarget(null, d('1'))).toBeNull();
	});
});
