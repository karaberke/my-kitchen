import { expect, test, type Page } from '@playwright/test';
import { createRecipe, register } from './helpers';

async function addChicken(page: Page, grams: string) {
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

/** Create a household from the index; it becomes the active one. */
async function createHousehold(page: Page, name: string) {
	await page.goto('/household');
	await page.getByRole('button', { name: 'Create household' }).first().click();
	await page.locator('#hh-name').fill(name);
	await page.getByRole('dialog').getByRole('button', { name: 'Create household' }).click();
	await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** Switch the active household using the sidebar dropdown. */
async function switchTo(page: Page, name: string) {
	await page.locator('#household-switch-d').selectOption({ label: name });
	await expect(page.locator('#household-switch-d')).toHaveValue(/.+/);
}

async function deleteFromManagePage(page: Page, name: string) {
	await page.getByRole('button', { name: 'Delete this household' }).click();
	const dialog = page.getByRole('dialog');
	const confirm = dialog.getByRole('button', { name: 'Delete household' });
	await expect(confirm).toBeDisabled();
	await dialog.locator('#hh-delete-confirm').fill(name);
	await expect(confirm).toBeEnabled();
	// The URL does not change on its own, so wait for the POST before navigating away.
	const done = page.waitForResponse((r) => r.url().includes('deleteHousehold'));
	await confirm.click();
	await done;
}

test('delete a household you own while a different one is active', async ({ page }) => {
	await register(page, 'Yang');
	await addChicken(page, '500');
	await createHousehold(page, 'BurgerPizza');
	await switchTo(page, "Yang's kitchen");

	// Manage the non-active household from the index and delete it.
	await page.goto('/household');
	await page.getByRole('link', { name: /BurgerPizza/ }).click();
	await expect(page).toHaveURL(/\/household\/[0-9a-f-]{36}$/);
	await deleteFromManagePage(page, 'BurgerPizza');

	await expect(page).toHaveURL(/\/household$/);
	await expect(page.getByRole('link', { name: /BurgerPizza/ })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /Yang's kitchen/ })).toBeVisible();
	// The still-active household kept its pantry.
	await page.goto('/pantry');
	await expect(page.getByText('500 g', { exact: true }).first()).toBeVisible();
});

test('deleting your only household wipes its data, keeps recipes and creates a fresh kitchen', async ({
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
	await page.getByRole('link', { name: /Dana's kitchen/ }).click();
	await deleteFromManagePage(page, "Dana's kitchen");

	await expect(page).toHaveURL(/\/household$/);
	await expect(page.getByRole('link', { name: /Dana's kitchen/ })).toBeVisible();
	await page.goto('/pantry');
	await expect(page.getByText('Pantry is empty')).toBeVisible();
	await page.goto('/recipes');
	await expect(page.getByRole('link', { name: 'Keeper' }).first()).toBeVisible();
});

test('a member can leave a household but cannot delete it', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const a = await ctxA.newPage();
	const b = await ctxB.newPage();
	await register(a, 'Owner');
	await register(b, 'Guest');

	await a.goto('/household');
	await a.getByRole('link', { name: /Owner's kitchen/ }).click();
	await a.getByRole('button', { name: 'Create invitation link' }).click();
	const link = await a.getByLabel('Invitation link').inputValue();
	await b.goto(link);
	await b.getByRole('button', { name: /Join/ }).click();
	// Accepting the invite lands on the joined household's page.
	await expect(b).toHaveURL(/\/household\/[0-9a-f-]{36}$/);

	await b.goto('/household');
	await b.getByRole('link', { name: /Owner's kitchen/ }).click();
	await expect(b).toHaveURL(/\/household\/[0-9a-f-]{36}$/);
	// A member gets Leave, never Delete.
	await expect(b.getByRole('button', { name: 'Delete this household' })).toHaveCount(0);
	b.once('dialog', (d) => d.accept());
	await b.getByRole('button', { name: 'Leave this household' }).click();
	await expect(b).toHaveURL(/\/household$/);
	await expect(b.getByRole('link', { name: /Owner's kitchen/ })).toHaveCount(0);

	// The household and its owner are unaffected.
	await a.goto('/household');
	await a.getByRole('link', { name: /Owner's kitchen/ }).click();
	await expect(a.getByText('Guest')).toHaveCount(0);
	await ctxA.close();
	await ctxB.close();
});

test('a non-member cannot open or delete another household by URL', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const a = await ctxA.newPage();
	const b = await ctxB.newPage();
	await register(a, 'Ada');
	await register(b, 'Bo');

	await a.goto('/household');
	await a.getByRole('link', { name: /Ada's kitchen/ }).click();
	await expect(a).toHaveURL(/\/household\/[0-9a-f-]{36}$/);
	const url = new URL(a.url());

	expect((await b.request.get(url.pathname)).status()).toBe(403);
	const res = await b.request.post(`${url.pathname}?/deleteHousehold`, {
		form: { confirmName: "Ada's kitchen" },
		headers: { 'x-sveltekit-action': 'true' }
	});
	expect(res.status()).toBe(403);
	// Still there for its owner.
	await a.goto(url.pathname);
	await expect(a.getByRole('heading', { name: "Ada's kitchen" })).toBeVisible();
	await ctxA.close();
	await ctxB.close();
});
