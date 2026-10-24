#!/usr/bin/env node
/** Fictional filming data, restricted to the isolated local promo database. */
import { chromium, expect } from '@playwright/test';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertPromoDatabase, PROMO_BASE_URL, PROMO_OUTPUT_DIR } from './utils.mjs';

const recipeVariants = {
	lemon: {
		title: 'Lemon garlic pasta',
		description: 'A little lemon, golden garlic, and a silky sauce. Your easy weeknight dinner.',
		tags: ['Weeknight', 'Vegetarian'],
		ingredients: [
			{
				name: 'garlic',
				category: 'Produce',
				amount: '2',
				unit: 'clove',
				preparation: 'thinly sliced',
				stock: { quantity: '8', location: 'Counter' }
			},
			{
				name: 'lemon',
				category: 'Produce',
				amount: '1',
				unit: 'piece',
				preparation: 'zest and juice',
				stock: { quantity: '3', location: 'Fridge' }
			}
		],
		steps: [
			'Warm the butter in a pan over medium-low heat. Add the sliced garlic and cook gently for 1 minute.',
			'Toss in the pasta, lemon zest and juice. Add a splash of pasta water and stir until glossy. Season and serve.'
		]
	},
	meatballs: {
		title: 'Spaghetti and meatballs',
		description:
			'Tender meatballs, a rich tomato sauce, and your favorite spaghetti. Dinner made simple.',
		tags: ['Weeknight'],
		ingredients: [
			{
				name: 'cooked meatballs',
				category: 'Meat & Fish',
				amount: '300',
				unit: 'g',
				preparation: '',
				stock: { quantity: '600', location: 'Fridge' }
			},
			{
				name: 'tomato sauce',
				category: 'Oils & Condiments',
				amount: '400',
				unit: 'g',
				preparation: '',
				stock: { quantity: '800', location: 'Cupboard' }
			}
		],
		steps: [
			'Melt the butter in a pan over medium-low heat. Stir in the tomato sauce and cooked meatballs. Simmer gently until the meatballs are heated through.',
			'Toss the spaghetti with the sauce, adding a splash of pasta water if needed. Divide between bowls and top with the meatballs.'
		]
	}
};

async function ingredientFor(tx, ownerUserId, name, category = 'Other') {
	const [existing] = await tx`
		select id from ingredient where name_normalized = ${name}
			and (owner_user_id is null or owner_user_id = ${ownerUserId})
		order by owner_user_id nulls first limit 1`;
	if (existing) return existing.id;
	const [created] = await tx`
		insert into ingredient (owner_user_id, name, name_normalized, category)
		values (${ownerUserId}, ${name}, ${name}, ${category}) returning id`;
	return created.id;
}

const { values } = parseArgs({
	options: {
		output: { type: 'string', default: PROMO_OUTPUT_DIR },
		runtime: { type: 'string', default: resolve(PROMO_OUTPUT_DIR, 'runtime.json') },
		recipe: { type: 'string', default: 'lemon' }
	}
});
const selectedRecipe = recipeVariants[values.recipe];
if (!selectedRecipe) throw new Error(`Unknown promo recipe: ${values.recipe}`);
const recipeIngredients = [
	{ name: 'butter', category: 'Dairy', amount: '30', unit: 'g', preparation: '' },
	{
		name: 'spaghetti',
		category: 'Grains & Pasta',
		amount: '200',
		unit: 'g',
		preparation: '',
		stock: { quantity: '500', location: 'Cupboard' }
	},
	...selectedRecipe.ingredients
];
const oliveOil = {
	name: 'olive oil',
	category: 'Oils & Condiments',
	unit: 'g',
	stock: { quantity: '400', location: 'Cupboard' }
};
const ingredients = [...recipeIngredients, oliveOil];
const pantry = ingredients
	.filter((ingredient) => ingredient.stock)
	.map(({ name, unit, stock }) => ({
		name,
		unit,
		...stock
	}));
const steps = [
	'Cook the spaghetti in salted water until al dente. Save a cup of pasta water, then drain.',
	...selectedRecipe.steps
];
const output = resolve(values.output);
const runtime = JSON.parse(await readFile(resolve(values.runtime), 'utf8'));
assertPromoDatabase(runtime.databaseUrl);
const base = new URL(runtime.baseUrl);
if (base.origin !== PROMO_BASE_URL) {
	throw new Error('Promo seed requires the dedicated loopback promo application and database.');
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: base.origin });
const page = await context.newPage();
const password = randomBytes(18).toString('base64url');
const user = { email: `alex-${Date.now()}@example.test`, password };
let storageState;
try {
	// The normal test helper fills immediately after navigation; Vite's first
	// hydration can replace those fields, so filming setup waits for it explicitly.
	await page.goto('/register', { waitUntil: 'networkidle' });
	await page.getByLabel('Your name').fill('Alex');
	await page.getByLabel('Email', { exact: true }).fill(user.email);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Create account', exact: true }).click();
	await expect(page).toHaveURL(/\/recipes$/);
	storageState = await context.storageState();
} finally {
	await context.close();
	await browser.close();
}

const sql = postgres(runtime.databaseUrl, { max: 1, onnotice: () => {} });
try {
	const [{ id: userId }] = await sql`select id from "user" where email = ${user.email}`;
	const [{ household_id: householdId }] =
		await sql`select household_id from household_member where user_id = ${userId}`;
	const today = new Date().toISOString().slice(0, 10);
	const ingredientIds = {};
	const initialStock = {};
	const weekMeals = [];
	let recipeId;
	let groceryListId;
	let oliveOilLotId;
	await sql.begin(async (tx) => {
		await tx`update household set name = 'Maple House' where id = ${householdId}`;
		for (const ingredient of ingredients) {
			ingredientIds[ingredient.name] = await ingredientFor(
				tx,
				userId,
				ingredient.name,
				ingredient.category
			);
		}
		const [recipe] = await tx`
			insert into recipe
				(owner_user_id, title, description, base_servings, prep_minutes, cook_minutes, tags, status)
			values (${userId}, ${selectedRecipe.title}, ${selectedRecipe.description},
				2, 5, 15, ${selectedRecipe.tags}, 'active') returning id`;
		recipeId = recipe.id;
		for (const [position, ingredient] of recipeIngredients.entries()) {
			await tx`
				insert into recipe_ingredient
					(recipe_id, position, ingredient_id, name, amount, unit, preparation)
				values (${recipeId}, ${position}, ${ingredientIds[ingredient.name]},
					${ingredient.name}, ${ingredient.amount}, ${ingredient.unit}, ${ingredient.preparation})`;
		}
		for (const [position, step] of steps.entries()) {
			await tx`insert into recipe_step (recipe_id, position, text) values (${recipeId}, ${position}, ${step})`;
		}
		const [event] = await tx`
			insert into inventory_event (household_id, kind, actor_user_id, actor_name, summary)
			values (${householdId}, 'add_stock', ${userId}, 'Alex', 'Stocked the kitchen') returning id`;
		for (const stock of pantry) {
			const ingredientId = ingredientIds[stock.name];
			const [lot] = await tx`
				insert into stock_lot (household_id, ingredient_id, quantity, unit, location)
				values (${householdId}, ${ingredientId}, ${stock.quantity}, ${stock.unit}, ${stock.location})
				returning id`;
			await tx`
				insert into inventory_movement
					(event_id, household_id, lot_id, ingredient_id, delta, unit, balance_after)
				values (${event.id}, ${householdId}, ${lot.id}, ${ingredientId},
					${stock.quantity}, ${stock.unit}, ${stock.quantity})`;
			initialStock[stock.name] = { ...stock, lotId: lot.id, ingredientId };
			if (stock.name === 'olive oil') oliveOilLotId = lot.id;
		}
		const [list] = await tx`
			insert into grocery_list (household_id, name, created_by)
			values (${householdId}, 'Next shop', ${userId}) returning id`;
		groceryListId = list.id;
		const supportingMeals = [
			{
				title: 'Chickpea rice bowls',
				minutes: 20,
				ingredients: [
					['rice', '150', 'g'],
					['chickpeas', '240', 'g']
				],
				step: 'Cook the rice until tender. Warm the drained chickpeas with a little oil and seasoning, then serve together.'
			},
			{
				title: 'Tomato basil soup',
				minutes: 25,
				ingredients: [
					['tomatoes', '500', 'g'],
					['basil', '10', 'g']
				],
				step: 'Simmer the chopped tomatoes with a splash of water until soft. Blend, season, and finish with torn basil.'
			},
			{
				title: 'Veggie stir-fry',
				minutes: 15,
				ingredients: [
					['tofu', '200', 'g'],
					['broccoli', '250', 'g']
				],
				step: 'Pat the tofu dry and cut into cubes. Stir-fry with the broccoli in a little oil until golden and tender, then season.'
			},
			{
				title: 'Black bean tacos',
				minutes: 15,
				ingredients: [
					['black beans', '240', 'g'],
					['tortillas', '4', 'piece']
				],
				step: 'Warm the drained black beans with your favorite taco seasoning. Spoon into warm tortillas and add toppings.'
			},
			{
				title: 'Roasted vegetable bowls',
				minutes: 30,
				ingredients: [
					['zucchini', '300', 'g'],
					['couscous', '150', 'g']
				],
				step: 'Roast sliced zucchini with a little oil at 200 C until golden. Prepare the couscous according to its package, and serve together.'
			},
			{
				title: 'Mushroom risotto',
				minutes: 30,
				ingredients: [
					['arborio rice', '150', 'g'],
					['mushrooms', '200', 'g']
				],
				step: 'Brown the sliced mushrooms in a little oil. Add the rice and ladle in hot vegetable stock, stirring until creamy and tender.'
			},
			{
				title: 'Sunday tomato pasta',
				minutes: 20,
				ingredients: [
					['spaghetti', '200', 'g'],
					['tomatoes', '300', 'g']
				],
				step: 'Cook the spaghetti until al dente. Simmer the chopped tomatoes with a little oil and seasoning, then toss with the pasta.'
			}
		];
		const monday = new Date(`${today}T00:00:00Z`);
		monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
		for (const [offset, meal] of supportingMeals.entries()) {
			const day = new Date(monday);
			day.setUTCDate(day.getUTCDate() + offset);
			const date = day.toISOString().slice(0, 10);
			let plannedRecipeId = recipeId;
			let title = selectedRecipe.title;
			if (date !== today) {
				title = meal.title;
				const [saved] = await tx`
					insert into recipe (owner_user_id, title, base_servings, prep_minutes, cook_minutes, status)
					values (${userId}, ${title}, 2, 5, ${meal.minutes}, 'active') returning id`;
				plannedRecipeId = saved.id;
				for (const [position, [name, amount, unit]] of meal.ingredients.entries()) {
					const ingredientId = await ingredientFor(tx, userId, name);
					await tx`
						insert into recipe_ingredient (recipe_id, position, ingredient_id, name, amount, unit)
						values (${plannedRecipeId}, ${position}, ${ingredientId}, ${name}, ${amount}, ${unit})`;
				}
				await tx`insert into recipe_step (recipe_id, position, text) values (${plannedRecipeId}, 0, ${meal.step})`;
			}
			await tx`
				insert into meal_plan_entry (household_id, planned_on, recipe_id, title, created_by)
				values (${householdId}, ${date}, ${plannedRecipeId}, ${title}, ${userId})`;
			weekMeals.push({ date, title, recipeId: plannedRecipeId });
		}
		await tx`
			update household set pantry_revision = pantry_revision + 1,
				plan_revision = plan_revision + 1, grocery_revision = grocery_revision + 1
			where id = ${householdId}`;
	});
	// Feed the local photograph through the same upload and validation as a real edit.
	const requestedPhoto = resolve(
		process.env.PROMO_IMAGE_PATH ?? resolve(PROMO_OUTPUT_DIR, 'recipe-photo.jpg')
	);
	let recipePhoto = null;
	const photoFile = await stat(requestedPhoto).catch((error) => {
		if (error.code === 'ENOENT' && !process.env.PROMO_IMAGE_PATH) return null;
		throw error;
	});
	if (photoFile) {
		if (!photoFile.isFile()) throw new Error('PROMO_IMAGE_PATH must be a local image file.');
		const photoBrowser = await chromium.launch({ headless: true });
		const photoContext = await photoBrowser.newContext({ baseURL: base.origin, storageState });
		try {
			const editor = await photoContext.newPage();
			await editor.goto(`/recipes/${recipeId}/edit`, { waitUntil: 'networkidle' });
			await editor.locator('input[type="file"][name="image"]').setInputFiles(requestedPhoto);
			await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
			await expect(editor).toHaveURL(new RegExp(`/recipes/${recipeId}$`), { timeout: 30_000 });
			const uploadedPhoto = editor.getByRole('img', { name: selectedRecipe.title, exact: true });
			await expect(uploadedPhoto).toBeVisible();
			await uploadedPhoto.evaluate((image) => image.decode());
			recipePhoto = { path: requestedPhoto, src: await uploadedPhoto.getAttribute('src') };
		} finally {
			await photoContext.close();
			await photoBrowser.close();
		}
	}
	const fixture = {
		synthetic: true,
		baseUrl: base.origin,
		user,
		userId,
		householdId,
		recipeId,
		groceryListId,
		recipeTitle: selectedRecipe.title,
		recipeVariant: values.recipe,
		butterPosition: 0,
		today,
		weekMeals,
		oliveOilLotId,
		ingredientIds,
		initialStock
	};
	if (recipePhoto) fixture.recipePhoto = recipePhoto;
	await writeFile(resolve(output, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
	console.log(`Fictional kitchen prepared; fixture saved to ${resolve(output, 'fixture.json')}.`);
} finally {
	await sql.end({ timeout: 5 });
}
