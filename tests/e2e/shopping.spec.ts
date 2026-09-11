import { expect, test } from '@playwright/test';
import { createRecipe, register } from './helpers';

test('plan two recipes, review pantry subtraction, shop with partial purchases, cook and undo', async ({
	page
}) => {
	await register(page, 'Carol');
	await createRecipe(page, {
		title: 'Roast',
		servings: '4',
		ingredient: { amount: '500', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
		step: 'Roast.'
	});
	const curryId = await createRecipe(page, {
		title: 'Curry',
		servings: '4',
		ingredient: { amount: '300', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
		step: 'Simmer.'
	});

	// pantry: 300 g
	await page.goto('/pantry');
	await page.getByRole('button', { name: '+ Add stock' }).click();
	await page.locator('#add-name').fill('chicken breast');
	await page
		.getByRole('option', { name: /chicken breast/ })
		.first()
		.click();
	await page.locator('#add-qty').fill('300');
	await page.locator('#add-unit').selectOption('g');
	await page.locator('#add-loc').fill('Freezer');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByText('300 g', { exact: true }).first()).toBeVisible();

	// plan both recipes
	for (const title of ['Roast', 'Curry']) {
		await page.goto('/recipes');
		await page.getByRole('link', { name: title }).first().click();
		await page.getByRole('button', { name: 'Add to grocery list' }).click();
		await page.getByRole('button', { name: 'Add to list' }).click();
		await expect(page.getByText(/Planned 4 servings/)).toBeVisible();
	}
	await page.goto('/grocery');
	await expect(page).toHaveURL(/\/grocery\/[0-9a-f-]{36}$/);
	await expect(page.getByText('need 800 g · pantry 300 g')).toBeVisible();
	await expect(page.getByText('500 g', { exact: true })).toBeVisible();

	// start shopping
	await page.getByRole('button', { name: 'Start shopping' }).click();
	await expect(page.getByText(/Shopping ·/)).toBeVisible();

	// buy 200 g
	await page.getByRole('button', { name: /Buy chicken breast/ }).click();
	await page.locator('#buy-qty').fill('200');
	await page.locator('#buy-unit').selectOption('g');
	await page.getByRole('button', { name: 'Bought it' }).click();
	await expect(page.getByText('300 g', { exact: true })).toBeVisible();
	await expect(page.getByText(/bought 200 g/)).toBeVisible();

	// buy 1 kg pack -> complete
	await page.getByRole('button', { name: /Buy chicken breast/ }).click();
	await page.locator('#buy-qty').fill('1');
	await page.locator('#buy-unit').selectOption('kg');
	await page.getByRole('button', { name: 'Bought it' }).click();
	await expect(page.getByText('All done here')).toBeVisible();
	await page.getByRole('button', { name: 'All' }).click();
	await expect(page.getByText(/bought 1.2 kg/)).toBeVisible();

	// pantry now 1.5 kg
	await page.goto('/pantry');
	await expect(page.getByText('1.5 kg', { exact: true }).first()).toBeVisible();

	// cook the curry for 2 servings from the plan
	await page.goto(`/recipes/${curryId}/cook?servings=2`);
	await page.getByRole('button', { name: 'Finish & update pantry' }).click();
	await page.locator('#finish-batch').selectOption({ index: 1 });
	await page.getByRole('button', { name: 'Deduct from pantry' }).click();
	await expect(page.getByText('Pantry updated: 1 deduction')).toBeVisible();
	await expect(page.getByText('2 planned servings fulfilled')).toBeVisible();
	await page.goto('/pantry');
	await expect(page.getByText('1.35 kg', { exact: true }).first()).toBeVisible();

	// undo from history restores 150 g
	await page.goto('/pantry/history');
	await page.getByRole('button', { name: 'Undo' }).first().click();
	await expect(page.getByText('Undid: Cooked Curry')).toBeVisible();
	await page.goto('/pantry');
	await expect(page.getByText('1.5 kg', { exact: true }).first()).toBeVisible();
});

test('revert an accidental trip completion, from the toast and from the list page', async ({
	page
}) => {
	await register(page, 'Dave');
	await createRecipe(page, {
		title: 'Soup',
		servings: '4',
		ingredient: { amount: '200', unit: 'g', name: 'carrot', match: 'carrot' },
		step: 'Simmer.'
	});
	await page.goto('/recipes');
	await page.getByRole('link', { name: 'Soup' }).first().click();
	await page.getByRole('button', { name: 'Add to grocery list' }).click();
	await page.getByRole('button', { name: 'Add to list' }).click();
	await expect(page.getByText(/Planned 4 servings/)).toBeVisible();
	await page.goto('/grocery');
	await expect(page).toHaveURL(/\/grocery\/[0-9a-f-]{36}$/);
	await page.getByRole('button', { name: 'Start shopping' }).click();
	await expect(page.getByText(/Shopping ·/)).toBeVisible();

	// an accidental click on Complete trip is undone from the toast
	await page.getByRole('button', { name: 'Complete trip' }).click();
	await expect(page.getByText(/Completed ·/)).toBeVisible();
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByText('Trip reopened. You can shop again.')).toBeVisible();
	await expect(page.getByText(/Shopping ·/)).toBeVisible();
	await expect(page.getByRole('button', { name: /Buy carrot/ })).toBeVisible();

	// and later from the Reopen trip button on the completed list
	await page.getByRole('button', { name: 'Complete trip' }).click();
	await expect(page.getByText(/Completed ·/)).toBeVisible();
	await page.getByRole('button', { name: 'Reopen trip' }).click();
	await expect(page.getByText(/Shopping ·/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Complete trip' })).toBeVisible();
});
