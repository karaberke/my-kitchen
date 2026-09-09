import { expect, test } from '@playwright/test';
import { createRecipe, register } from './helpers';

async function addChicken(page: import('@playwright/test').Page, grams: string) {
	await page.goto('/pantry');
	await page.getByRole('button', { name: '+ Add stock' }).click();
	await page.locator('#add-name').fill('chicken breast');
	await page
		.getByRole('option', { name: /chicken breast/ })
		.first()
		.click();
	await page.locator('#add-qty').fill(grams);
	await page.locator('#add-unit').selectOption('g');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByText(`${grams} g`, { exact: true }).first()).toBeVisible();
}

test('owner deletes their only household: pantry is wiped, recipes survive, a fresh kitchen is created', async ({
	page
}) => {
	await register(page, 'Dana');
	await createRecipe(page, {
		title: 'Keeper',
		servings: '4',
		ingredient: { amount: '200', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
		step: 'Cook.'
	});
	await addChicken(page, '300');

	await page.goto('/household');
	await expect(page.getByText("Dana's kitchen · you are an owner")).toBeVisible();
	await page.getByRole('button', { name: 'Delete this household' }).click();

	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('heading', { name: 'Delete this household?' })).toBeVisible();
	const confirm = dialog.getByRole('button', { name: 'Delete household' });
	await expect(confirm).toBeDisabled();
	await dialog.locator('#hh-delete-confirm').fill('wrong name');
	await expect(confirm).toBeDisabled();
	await dialog.locator('#hh-delete-confirm').fill("Dana's kitchen");
	await expect(confirm).toBeEnabled();
	// The action deletes the household we are looking at; the URL does not change, so wait
	// for the POST itself before navigating anywhere else.
	const deleted = page.waitForResponse((r) => r.url().includes('deleteHousehold'));
	await confirm.click();
	await deleted;
	await expect(dialog).toBeHidden();

	// Landed back on /household with a freshly created personal kitchen.
	await expect(page).toHaveURL(/\/household$/);
	await expect(page.getByText("Dana's kitchen · you are an owner")).toBeVisible();

	// Household-scoped data is gone; user-owned recipes are not.
	await page.goto('/pantry');
	await expect(page.getByText('Pantry is empty')).toBeVisible();
	await page.goto('/recipes');
	await expect(page.getByRole('link', { name: 'Keeper' }).first()).toBeVisible();
});

test('deleting a secondary household falls back to the remaining one with its pantry intact', async ({
	page
}) => {
	await register(page, 'Evan');
	await addChicken(page, '500');

	await page.goto('/household');
	await page.getByRole('button', { name: 'Create household' }).first().click();
	await page.locator('#hh-name').fill('Temp');
	await page.getByRole('dialog').getByRole('button', { name: 'Create household' }).click();
	await expect(page.getByText('Temp · you are an owner')).toBeVisible();
	await addChicken(page, '50');

	await page.goto('/household');
	await page.getByRole('button', { name: 'Delete this household' }).click();
	const dialog = page.getByRole('dialog');
	await dialog.locator('#hh-delete-confirm').fill('Temp');
	const deleted = page.waitForResponse((r) => r.url().includes('deleteHousehold'));
	await dialog.getByRole('button', { name: 'Delete household' }).click();
	await deleted;
	await expect(dialog).toBeHidden();

	await expect(page).toHaveURL(/\/household$/);
	await expect(page.getByText("Evan's kitchen · you are an owner")).toBeVisible();
	await expect(page.getByText('Temp')).toHaveCount(0);
	await page.goto('/pantry');
	await expect(page.getByText('500 g', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('50 g', { exact: true })).toHaveCount(0);
});
