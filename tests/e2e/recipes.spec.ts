import { expect, test } from '@playwright/test';
import { createRecipe, register } from './helpers';

test.describe('recipes', () => {
	test('registration, draft, full save, edit, duplicate, export, delete', async ({ page }) => {
		await register(page, 'Alice');
		// draft with only a title
		await page.goto('/recipes/new');
		await page.getByLabel('Title').fill('Half an idea');
		await page.getByRole('button', { name: 'Save draft' }).click();
		await expect(page.getByText('This is a draft')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Cook this' })).toHaveAttribute(
			'aria-disabled',
			'true'
		);

		// validation preserves input
		await page.goto('/recipes/new');
		await page.getByLabel('Title').fill('Broken amounts');
		await page.locator('#ing-0-amount').fill('lots');
		await page.locator('#ing-0-name').fill('salt');
		await page.getByRole('button', { name: 'Save recipe' }).click();
		await expect(page.getByText('Base servings are needed for scaling')).toBeVisible();
		await expect(page.getByLabel('Title')).toHaveValue('Broken amounts');
		await expect(page.locator('#ing-0-amount')).toHaveValue('lots');

		const id = await createRecipe(page, {
			title: 'Sheet-pan chicken',
			servings: '4',
			ingredient: { amount: '1 1/2', unit: 'kg', name: 'chicken breast', match: 'chicken breast' },
			step: 'Roast until done.'
		});
		await expect(page.getByRole('heading', { name: 'Sheet-pan chicken' })).toBeVisible();
		await expect(page.getByText('1.5 kg chicken breast')).toBeVisible();
		// scaling changes displayed amount, base untouched after reload
		await page.getByRole('button', { name: 'More servings' }).click();
		await page.getByRole('button', { name: 'More servings' }).click();
		await expect(page.getByText('2.25 kg chicken breast')).toBeVisible();
		await page.reload();
		await expect(page.getByText('1.5 kg chicken breast')).toBeVisible();

		// edit
		await page.getByRole('link', { name: 'Edit' }).click();
		await page.getByLabel('Title').fill('Sheet-pan chicken with lemon');
		await page.getByRole('button', { name: 'Save changes' }).click();
		await expect(page.getByRole('heading', { name: 'Sheet-pan chicken with lemon' })).toBeVisible();

		// export JSON
		const res = await page.request.get(`/recipes/${id}/export.json`);
		expect(res.status()).toBe(200);
		expect(res.headers()['cache-control']).toContain('no-store');
		const json = await res.json();
		expect(json.schemaVersion).toBe(1);
		expect(json.recipes[0].ingredients[0].amount).toBe('1.5');

		// duplicate lands in edit of the copy
		await page.getByRole('button', { name: 'Duplicate' }).click();
		await expect(page).toHaveURL(/\/edit$/);
		await expect(page.getByLabel('Title')).toHaveValue('Sheet-pan chicken with lemon (copy)');

		// delete original
		await page.goto(`/recipes/${id}`);
		await page.getByRole('button', { name: 'Delete' }).click();
		await page.getByRole('button', { name: 'Delete recipe' }).click();
		await expect(page).toHaveURL(/\/recipes$/);
		const gone = await page.request.get(`/recipes/${id}/export.json`);
		expect(gone.status()).toBe(404);
	});

	test('a recipe is denied to a stranger, reaches the household automatically, and follows unshare and removal', async ({
		browser
	}) => {
		const ctxA = await browser.newContext();
		const ctxB = await browser.newContext();
		const a = await ctxA.newPage();
		const b = await ctxB.newPage();
		await register(a, 'Alice');
		const bob = await register(b, 'Bob');
		const id = await createRecipe(a, {
			title: 'Alice private dal',
			servings: '4',
			ingredient: { amount: '300', unit: 'g', name: 'red lentils', match: 'red lentils' },
			step: 'Simmer.'
		});
		await b.goto(`/recipes/${id}`);
		await expect(b.getByText('Nothing here')).toBeVisible();
		expect((await b.request.get(`/recipes/${id}/export.json`)).status()).toBe(404);

		// invite Bob
		await a.goto('/household');
		await a.getByRole('link', { name: /Alice's kitchen/ }).click();
		await a.getByRole('button', { name: 'Create invitation link' }).click();
		const link = await a.getByLabel('Invitation link').inputValue();
		await b.goto(link);
		await b.getByRole('button', { name: /Join/ }).click();
		await expect(b).toHaveURL(/\/household/);
		await expect(b.getByText('Bob (you)')).toBeVisible();

		// Alice never pressed Share: the recipe went to her active household when she
		// saved it, so joining that household is enough for Bob to read it.
		await b.goto(`/recipes/${id}`);
		await expect(b.getByRole('heading', { name: 'Alice private dal' })).toBeVisible();
		await expect(b.getByRole('link', { name: 'Edit' })).toHaveCount(0);
		expect((await b.request.get(`/recipes/${id}/edit`)).status()).toBe(403);

		// unshare, then share again: the owner keeps control of the share
		await a.goto(`/recipes/${id}`);
		await a.getByRole('button', { name: 'Share…' }).click();
		await a.getByRole('button', { name: 'Unshare' }).click();
		await expect(a.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
		await b.goto(`/recipes/${id}`);
		await expect(b.getByText('Nothing here')).toBeVisible();
		await a.getByRole('button', { name: 'Share', exact: true }).click();
		await expect(a.getByRole('button', { name: 'Unshare' })).toBeVisible();
		await b.goto(`/recipes/${id}`);
		await expect(b.getByRole('heading', { name: 'Alice private dal' })).toBeVisible();

		// remove Bob from the household: access ends immediately
		await a.goto('/household');
		await a.getByRole('link', { name: /Alice's kitchen/ }).click();
		a.once('dialog', (d) => d.accept());
		await a.getByRole('button', { name: 'Remove' }).click();
		// Wait for the removal to land before checking Bob's access.
		await expect(a.getByText(bob.email)).toHaveCount(0);
		await b.goto(`/recipes/${id}`);
		await expect(b.getByText('Nothing here')).toBeVisible();
		await ctxA.close();
		await ctxB.close();
	});
});

test('a recipe missing required fields is caught in the browser, with no request', async ({
	page
}) => {
	await register(page, 'Val');
	await page.goto('/recipes/new');

	let posts = 0;
	page.on('request', (r) => {
		if (r.method() === 'POST') posts++;
	});

	// Nothing filled in: title, servings, ingredients and steps are all required.
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page.getByText('Please fix the highlighted fields.')).toBeVisible();
	await expect(page.getByText('Give the recipe a title')).toBeVisible();
	await expect(page.getByText('Base servings are needed for scaling')).toBeVisible();
	await expect(page.getByText('Add at least one ingredient')).toBeVisible();
	await expect(page.getByText('Add at least one step')).toBeVisible();
	// The whole point: the server was never asked.
	expect(posts).toBe(0);
	await expect(page).toHaveURL(/\/recipes\/new$/);

	// A draft has none of those requirements, so it saves without complaint.
	await page.getByLabel('Title').fill('Rough idea');
	await page.getByRole('button', { name: 'Save draft' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
	expect(posts).toBe(1);
});

test('fixing a flagged field clears it and lets the recipe save', async ({ page }) => {
	await register(page, 'Vin');
	await page.goto('/recipes/new');
	await page.getByLabel('Title').fill('Almost there');
	await page.locator('#ing-0-name').fill('salt');
	await page.locator('#step-0-text').fill('Season.');
	await page.getByRole('button', { name: 'Save recipe' }).click();

	// Only servings is missing, and only servings is reported.
	await expect(page.getByText('Base servings are needed for scaling')).toBeVisible();
	await expect(page.getByText('Add at least one ingredient')).toHaveCount(0);

	await page.getByLabel('Base servings').fill('4');
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
	await expect(page.getByRole('heading', { name: 'Almost there' })).toBeVisible();
});
