#!/usr/bin/env node
/** Read-only verification of the real, recorded cooking and shopping workflow. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import sharp from 'sharp';
import { assertPromoDatabase, PROMO_BASE_URL, PROMO_OUTPUT_DIR } from './utils.mjs';

const { values } = parseArgs({
	options: {
		output: { type: 'string', default: PROMO_OUTPUT_DIR },
		runtime: { type: 'string', default: path.join(PROMO_OUTPUT_DIR, 'runtime.json') },
		fixture: { type: 'string' },
		timeline: { type: 'string' }
	}
});
const outputDir = path.resolve(values.output);
const runtime = JSON.parse(await readFile(path.resolve(values.runtime), 'utf8'));
const fixture = JSON.parse(
	await readFile(path.resolve(values.fixture ?? path.join(outputDir, 'fixture.json')), 'utf8')
);
const timeline = JSON.parse(
	await readFile(path.resolve(values.timeline ?? path.join(outputDir, 'timeline.json')), 'utf8')
);
const database = assertPromoDatabase(runtime.databaseUrl);
if (
	fixture.synthetic !== true ||
	fixture.baseUrl !== PROMO_BASE_URL ||
	runtime.baseUrl !== PROMO_BASE_URL ||
	runtime.databaseName !== database.pathname.slice(1)
) {
	throw new Error('Verification requires synthetic data and the dedicated local promo runtime.');
}

const result = {
	checkedAt: new Date().toISOString(),
	synthetic: true,
	recipeTitle: fixture.recipeTitle,
	checks: []
};
function check(name, passed, details = {}) {
	result.checks.push({ name, passed: Boolean(passed), ...details });
}

check('recording completed', timeline.status === 'complete');
check('genuine assistant answer recorded', Boolean(timeline.assistant?.answer?.trim()));
const substituteAmount = timeline.verification?.substituteAmount;
if (!/^\d+(?:\.\d+)?$/.test(substituteAmount ?? '') || Number(substituteAmount) <= 0) {
	throw new Error('A positive weighed substitute amount must be recorded before verification.');
}

const sql = postgres(runtime.databaseUrl, { max: 1, onnotice: () => {} });
let photo;
try {
	await sql.begin('read only', async (tx) => {
		const [identity] = await tx`
			select r.id, r.base_servings, h.name as household_name
			from recipe r
			join household_member hm on hm.user_id = r.owner_user_id
			join household h on h.id = hm.household_id
			where r.id = ${fixture.recipeId} and hm.household_id = ${fixture.householdId}
				and r.owner_user_id = ${fixture.userId}`;
		check('fixture recipe belongs to the fictional household', Boolean(identity));
		const weekMeals = fixture.weekMeals ?? [];
		const dates = [...new Set(weekMeals.map((meal) => meal.date))].sort();
		const validWeek =
			weekMeals.length === 7 &&
			dates.length === 7 &&
			dates.every(
				(date, index) =>
					/^\d{4}-\d{2}-\d{2}$/.test(date) &&
					(index === 0 || Date.parse(date) - Date.parse(dates[index - 1]) === 86_400_000)
			);
		const plannedMeals = validWeek
			? await tx`
				select planned_on::text as date, title, recipe_id from meal_plan_entry
				where household_id = ${fixture.householdId}
					and planned_on between ${dates[0]}::date and ${dates[6]}::date`
			: [];
		check(
			'seven consecutive week days have their expected meals',
			validWeek &&
				weekMeals.every(
					(expected) =>
						expected.title?.trim() &&
						plannedMeals.some(
							(actual) =>
								actual.date === expected.date &&
								actual.title === expected.title &&
								actual.recipe_id === expected.recipeId
						)
				),
			{ dates, mealCount: plannedMeals.length }
		);
		check(
			"today's meal opens the featured recipe",
			weekMeals.some(
				(meal) =>
					meal.date === fixture.today &&
					meal.recipeId === fixture.recipeId &&
					meal.title === fixture.recipeTitle
			) &&
				plannedMeals.some(
					(meal) =>
						meal.date === fixture.today &&
						meal.recipe_id === fixture.recipeId &&
						meal.title === fixture.recipeTitle
				)
		);
		[photo] = await tx`
			select i.id, i.backend, i.object_key, i.variants from recipe r
			join image i on i.id = r.image_id
			where r.id = ${fixture.recipeId} and r.owner_user_id = ${fixture.userId}`;
		const events = await tx`
			select id, servings, reversed_by_event_id, details
			from inventory_event where household_id = ${fixture.householdId}
				and recipe_id = ${fixture.recipeId} and kind = 'cook'`;
		check('one completed cooking event', events.length === 1 && !events[0]?.reversed_by_event_id, {
			count: events.length
		});
		const event = events[0];
		if (!identity || !event) return;
		const usage = event.details.usage?.find((item) => item.position === fixture.butterPosition);
		const oliveOilId = fixture.ingredientIds['olive oil'];
		check(
			'butter replaced with olive oil in the completed event',
			usage?.substituted &&
				usage.mode === 'deduct' &&
				usage.recipeIngredientId === fixture.ingredientIds.butter &&
				usage.usedIngredientId === oliveOilId
		);

		for (const [name, stock] of Object.entries(fixture.initialStock)) {
			const [balance] = await tx`
				select l.quantity, l.unit,
					coalesce(sum(m.delta) filter (where m.event_id = ${event.id}), 0)::text as actual_delta,
					case when ${name} = 'olive oil' then ${substituteAmount}::numeric
					else (select ri.amount * ${event.servings}::numeric / ${identity.base_servings}::numeric
						from recipe_ingredient ri where ri.recipe_id = ${fixture.recipeId}
							and ri.ingredient_id = ${stock.ingredientId}) end::text as expected_used,
					l.quantity = ${stock.quantity}::numeric + coalesce(sum(m.delta)
						filter (where m.event_id = ${event.id}), 0) as balance_matches_deduction
				from stock_lot l left join inventory_movement m on m.lot_id = l.id
				where l.id = ${stock.lotId} and l.household_id = ${fixture.householdId}
				group by l.id`;
			const [amount] = balance
				? await tx`select ${balance.actual_delta}::numeric = -${balance.expected_used}::numeric as correct`
				: [{}];
			check(
				`${name} deducted correctly`,
				balance &&
					amount.correct &&
					balance.balance_matches_deduction &&
					balance.unit === stock.unit,
				{
					initial: stock.quantity,
					expectedUsed: balance?.expected_used,
					actualDelta: balance?.actual_delta,
					remaining: balance?.quantity,
					unit: stock.unit
				}
			);
		}
		const [{ count: butterMovementCount }] = await tx`
			select count(*)::int as count from inventory_movement
			where household_id = ${fixture.householdId} and ingredient_id = ${fixture.ingredientIds.butter}`;
		check('butter stock was not moved or deducted', butterMovementCount === 0);
		const lines = await tx`
			select g.kind, g.status, g.purchased_amount, g.demand_amount, g.unit, g.subtract_pantry
			from grocery_line g join grocery_list l on l.id = g.list_id
			where l.id = ${fixture.groceryListId} and l.household_id = ${fixture.householdId}
				and g.ingredient_id = ${fixture.ingredientIds.butter}`;
		const [manual] = lines;
		check(
			'independent butter grocery line remains pending for the next shop',
			lines.length === 1 &&
				manual.kind === 'manual' &&
				manual.status === 'pending' &&
				Number(manual.purchased_amount) === 0 &&
				Number(manual.demand_amount) === 250 &&
				manual.unit === 'g' &&
				manual.subtract_pantry === false
		);
		// Same read-only invariants as scripts/consistency-check.mjs, scoped to this fixture.
		const lotMismatches = await tx`
			select l.id from stock_lot l left join inventory_movement m on m.lot_id = l.id
			where l.household_id = ${fixture.householdId}
			group by l.id having l.quantity <> coalesce(sum(m.delta), 0)`;
		const lineMismatches = await tx`
			select g.id from grocery_line g
			join grocery_list l on l.id = g.list_id
			left join purchase_allocation a on a.line_id = g.id
			where l.household_id = ${fixture.householdId}
			group by g.id having g.purchased_amount <> coalesce(sum(a.amount), 0)`;
		check('lot balances match the append-only inventory ledger', lotMismatches.length === 0);
		check('purchase credits match purchase allocations', lineMismatches.length === 0);
	});
} finally {
	await sql.end({ timeout: 5 });
}

const imageEvidence = {
	checkedAt: new Date().toISOString(),
	synthetic: true,
	recipeId: fixture.recipeId,
	imageId: photo?.id ?? null,
	variants: []
};
let photoValid =
	photo?.backend === 'local' && Object.keys(photo.variants).sort().join(',') === 'detail,thumb';
if (photoValid) {
	const uploadRoot = path.resolve(PROMO_OUTPUT_DIR, 'uploads');
	try {
		for (const [name, stored] of Object.entries(photo.variants)) {
			const filename = path.resolve(uploadRoot, photo.object_key, `${name}.webp`);
			if (!filename.startsWith(uploadRoot + path.sep)) {
				throw new Error('Photo path escapes the promo upload directory.');
			}
			const bytes = await readFile(filename);
			const metadata = await sharp(bytes).metadata();
			await sharp(bytes).raw().toBuffer();
			const valid =
				metadata.format === 'webp' &&
				metadata.width === stored.width &&
				metadata.height === stored.height &&
				bytes.byteLength === stored.bytes &&
				stored.mime === 'image/webp';
			photoValid &&= valid;
			imageEvidence.variants.push({
				name,
				width: metadata.width,
				height: metadata.height,
				bytes: bytes.byteLength,
				passed: valid
			});
		}
	} catch {
		photoValid = false;
	}
}
imageEvidence.passed = photoValid;
await writeFile(
	path.join(outputDir, 'image-verification.json'),
	`${JSON.stringify(imageEvidence, null, 2)}\n`
);
check('recipe photo is linked and its stored variants fully decode', photoValid);

result.passed = result.checks.every((item) => item.passed);
await writeFile(path.join(outputDir, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`);
for (const failure of result.checks.filter((item) => !item.passed)) {
	console.error(`FAIL: ${failure.name}`);
}
if (result.passed) console.log(`Promo verification: ${result.checks.length} checks passed.`);
process.exitCode = result.passed ? 0 : 1;
