#!/usr/bin/env node
/**
 * Development-only performance seed: 10 households × 200 recipes, 200 pantry
 * lots per household, and one large shopping list with 300 lines.
 * Reproducible (seeded PRNG). Refuses to run when NODE_ENV=production.
 * Users: perf1@example.test … perf10@example.test / password "perf-password-1"
 * Usage: node --env-file=.env scripts/seed-perf.mjs [--households 10 --recipes 200 --lots 200 --lines 300]
 */
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { scrypt } from 'node:crypto';
import { promisify } from 'node:util';

if (process.env.NODE_ENV === 'production') {
	console.error('Refusing to seed a production database');
	process.exit(2);
}
const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : []))
		.filter((x) => x.length)
);
const HOUSEHOLDS = Number(args.households ?? 10);
const RECIPES = Number(args.recipes ?? 200);
const LOTS = Number(args.lots ?? 200);
const LINES = Number(args.lines ?? 300);

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const sql = postgres(url, { max: 4, onnotice: () => {} });

// deterministic PRNG
let seed = 20260909;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// Better Auth credential hash format: scrypt (N=16384,r=16,p=1,dkLen=64) → "<saltHex>:<keyHex>"
const scryptAsync = promisify(scrypt);
async function hashPassword(password) {
	const salt = createHash('sha256').update('perf-seed-salt').digest('hex').slice(0, 32);
	const key = await scryptAsync(password.normalize('NFKC'), salt, 64, {
		N: 16384,
		r: 16,
		p: 1,
		maxmem: 128 * 16384 * 16 * 2
	});
	return `${salt}:${Buffer.from(key).toString('hex')}`;
}

const UNITS = ['g', 'g', 'g', 'kg', 'ml', 'ml', 'l', 'piece', 'tbsp', 'tsp', 'cup', 'can', 'clove'];
const WORDS = [
	'Roasted',
	'Braised',
	'Quick',
	'Sunday',
	'Spicy',
	'Lemon',
	'Garlic',
	'Herb',
	'Smoky',
	'Creamy',
	'Crispy',
	'Weeknight'
];
const DISHES = [
	'chicken',
	'lentils',
	'pasta',
	'stew',
	'salad',
	'curry',
	'soup',
	'bake',
	'noodles',
	'rice bowl',
	'tacos',
	'frittata'
];
const TAGS = ['weeknight', 'vegetarian', 'quick', 'batch', 'comfort', 'summer', 'winter', 'kids'];
const LOCS = ['Fridge', 'Freezer', 'Cupboard', 'Pantry shelf', ''];

const catalog =
	await sql`select id, name from ingredient where owner_user_id is null order by name`;
const started = Date.now();
const password = await hashPassword('perf-password-1');

await sql.begin(async (tx) => {
	for (let h = 1; h <= HOUSEHOLDS; h++) {
		const email = `perf${h}@example.test`;
		const [existing] = await tx`select id from "user" where email = ${email}`;
		if (existing) {
			console.log(`user ${email} exists, skipping household ${h}`);
			continue;
		}
		const userId = randomUUID().replace(/-/g, '').slice(0, 32);
		await tx`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${userId}, ${'Perf User ' + h}, ${email}, true, now(), now())`;
		await tx`insert into account (id, account_id, provider_id, user_id, password, created_at, updated_at) values (${randomUUID().replace(/-/g, '').slice(0, 32)}, ${userId}, 'credential', ${userId}, ${password}, now(), now())`;
		const [household] =
			await tx`insert into household (name) values (${'Perf household ' + h}) returning id`;
		await tx`insert into household_member (household_id, user_id, role) values (${household.id}, ${userId}, 'owner')`;
		await tx`insert into user_preference (user_id, active_household_id) values (${userId}, ${household.id})`;

		// recipes
		const recipeRows = [];
		for (let r = 0; r < RECIPES; r++) {
			recipeRows.push({
				owner_user_id: userId,
				title: `${pick(WORDS)} ${pick(DISHES)} #${r + 1}`,
				description: 'Seeded recipe for performance measurements.',
				base_servings: String(int(2, 8)),
				prep_minutes: int(5, 30),
				cook_minutes: int(10, 90),
				tags: [pick(TAGS), pick(TAGS)].filter((t, i, a) => a.indexOf(t) === i),
				status: 'active'
			});
		}
		const inserted =
			await tx`insert into recipe ${tx(recipeRows, 'owner_user_id', 'title', 'description', 'base_servings', 'prep_minutes', 'cook_minutes', 'tags', 'status')} returning id`;
		const ingRows = [];
		const stepRows = [];
		for (const { id } of inserted) {
			const n = int(4, 10);
			for (let p = 0; p < n; p++) {
				const ing = pick(catalog);
				const unit = pick(UNITS);
				ingRows.push({
					recipe_id: id,
					position: p,
					group_name: p < n / 2 ? '' : 'Finish',
					ingredient_id: ing.id,
					name: ing.name,
					amount: rnd() < 0.1 ? null : String(int(1, 500)),
					unit: rnd() < 0.1 ? null : unit,
					preparation: '',
					optional: rnd() < 0.15
				});
			}
			for (let s = 0; s < int(3, 7); s++)
				stepRows.push({
					recipe_id: id,
					position: s,
					section_title: '',
					text: `Step ${s + 1}: do the thing carefully, then the next thing.`
				});
		}
		for (let i = 0; i < ingRows.length; i += 1000)
			await tx`insert into recipe_ingredient ${tx(ingRows.slice(i, i + 1000), 'recipe_id', 'position', 'group_name', 'ingredient_id', 'name', 'amount', 'unit', 'preparation', 'optional')}`;
		for (let i = 0; i < stepRows.length; i += 1000)
			await tx`insert into recipe_step ${tx(stepRows.slice(i, i + 1000), 'recipe_id', 'position', 'section_title', 'text')}`;
		// share a fifth of recipes with the household
		await tx`insert into recipe_share (recipe_id, household_id) select id, ${household.id} from recipe where owner_user_id = ${userId} and random() < 0.2`;

		// pantry lots with movements (so the consistency check holds)
		const [event] =
			await tx`insert into inventory_event (household_id, kind, actor_user_id, actor_name, summary) values (${household.id}, 'add_stock', ${userId}, ${'Perf User ' + h}, 'Seeded stock') returning id`;
		const lotRows = [];
		for (let l = 0; l < LOTS; l++) {
			const ing = pick(catalog);
			const unit = pick(['g', 'g', 'kg', 'ml', 'l', 'piece', 'can']);
			const exp =
				rnd() < 0.5
					? null
					: new Date(Date.now() + int(-5, 60) * 86400000).toISOString().slice(0, 10);
			lotRows.push({
				household_id: household.id,
				ingredient_id: ing.id,
				quantity: String(int(1, 2000)),
				unit,
				location: pick(LOCS),
				expires_on: exp,
				note: ''
			});
		}
		const lots =
			await tx`insert into stock_lot ${tx(lotRows, 'household_id', 'ingredient_id', 'quantity', 'unit', 'location', 'expires_on', 'note')} returning id, ingredient_id, quantity, unit`;
		await tx`insert into inventory_movement ${tx(
			lots.map((l) => ({
				event_id: event.id,
				household_id: household.id,
				lot_id: l.id,
				ingredient_id: l.ingredient_id,
				delta: l.quantity,
				unit: l.unit,
				balance_after: l.quantity
			})),
			'event_id',
			'household_id',
			'lot_id',
			'ingredient_id',
			'delta',
			'unit',
			'balance_after'
		)}`;
		await tx`update household set pantry_revision = pantry_revision + 1 where id = ${household.id}`;

		// one large shopping list in the first household
		if (h === 1) {
			const [list] =
				await tx`insert into grocery_list (household_id, name, status, created_by, started_at, pantry_revision_at_preview) values (${household.id}, 'Big shop', 'shopping', ${userId}, now(), 1) returning id`;
			const lineRows = [];
			for (let i = 0; i < LINES; i++) {
				const ing = pick(catalog);
				const target = String(int(50, 1000));
				lineRows.push({
					list_id: list.id,
					kind: i % 10 === 0 ? 'manual' : 'recipe',
					plan_key: `${ing.id}|dim:mass|${i}`,
					ingredient_id: ing.id,
					name: ing.name,
					category: 'Pantry',
					unit: 'g',
					demand_amount: target,
					stock_considered: '0',
					target_amount: target,
					purchased_amount: '0',
					status: 'pending',
					position: i
				});
			}
			await tx`insert into grocery_line ${tx(lineRows, 'list_id', 'kind', 'plan_key', 'ingredient_id', 'name', 'category', 'unit', 'demand_amount', 'stock_considered', 'target_amount', 'purchased_amount', 'status', 'position')}`;
		}
		console.log(
			`household ${h}: ${RECIPES} recipes, ${LOTS} lots${h === 1 ? `, ${LINES}-line list` : ''}`
		);
	}
});
console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await sql.end();
