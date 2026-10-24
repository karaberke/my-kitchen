import { expect, test, type Page } from '@playwright/test';
import { createRecipe, register } from './helpers';

async function stock(page: Page, name: string, quantity: string, unit: string) {
	await page.goto('/pantry');
	await page.getByRole('button', { name: '+ Add stock' }).click();
	await page.locator('#add-name').fill(name);
	await page
		.getByRole('option', { name: new RegExp(name, 'i') })
		.first()
		.click();
	await page.locator('#add-qty').fill(quantity);
	await page.locator('#add-unit').selectOption(unit);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('a purchase uses the selected catalog identity and merges with its existing stock', async ({
	page
}) => {
	await register(page, 'Nadia');
	await stock(page, 'chicken breast', '100', 'g');
	await page.goto('/grocery');
	await page.getByLabel('List name').fill('Dinner groceries');
	await page.getByRole('button', { name: 'Start a list' }).click();
	await page.getByRole('button', { name: 'Add item', exact: true }).first().click();
	await page.locator('#line-name').fill('Dinner supplies');
	await page.locator('#line-amount').fill('100');
	await page.locator('#line-unit').selectOption('g');
	await page.getByRole('button', { name: 'Add to list', exact: true }).click();
	await page.getByRole('button', { name: 'Start shopping' }).click();
	await page.getByRole('button', { name: 'Buy Dinner supplies', exact: true }).click();
	await page.locator('#buy-qty').fill('100');
	await page.locator('#buy-unit').selectOption('g');
	await page.locator('#buy-ing').fill('chicken breast');
	await page
		.getByRole('option', { name: /chicken breast/i })
		.first()
		.click();
	await page.getByRole('button', { name: 'Bought it', exact: true }).click();
	await expect(page.getByText('All done here')).toBeVisible();
	await page.goto('/pantry');
	await expect(page.getByText('200 g', { exact: true }).first()).toBeVisible();
	await expect(page.locator('main').getByText('chicken breast', { exact: true })).toHaveCount(1);
});

test('substitute allocations show the lot unit and deduct that amount from the lot', async ({
	page
}) => {
	await register(page, 'Omar');
	const recipeId = await createRecipe(page, {
		title: 'Small chicken supper',
		servings: '1',
		ingredient: { amount: '100', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
		step: 'Cook the chicken.'
	});
	await stock(page, 'chicken thigh', '1', 'kg');
	await page.goto(`/recipes/${recipeId}/cook`);
	await page.getByRole('button', { name: 'Finish & update pantry' }).click();
	await page.getByText('Substitute or note', { exact: true }).click();
	await page.getByLabel('Used a different ingredient').fill('chicken thigh');
	await page
		.getByRole('option', { name: /chicken thigh/i })
		.first()
		.click();
	await page.getByRole('button', { name: 'Use its pantry lots' }).click();
	const allocation = page.getByLabel('Amount to deduct from this lot');
	await expect(allocation).toHaveValue('0.1');
	await expect(allocation.locator('..').locator('span')).toHaveText('kg');
	await page.getByRole('button', { name: 'Deduct from pantry' }).click();
	await expect(page.getByText('Pantry updated: 1 deduction')).toBeVisible();
	await page.goto('/pantry');
	await expect(page.getByText(/^(?:0\.9 kg|900 g)$/).first()).toBeVisible();
});
