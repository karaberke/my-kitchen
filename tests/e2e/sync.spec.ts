import { expect, test } from '@playwright/test';
import { login, register } from './helpers';

test('another visible device sees a pantry change within the polling window; dirty forms stay intact', async ({
	browser
}) => {
	const ctxA = await browser.newContext();
	const a = await ctxA.newPage();
	const { email, password } = await register(a, 'Fay');
	const ctxB = await browser.newContext();
	const b = await ctxB.newPage();
	await login(b, email, password);
	await b.goto('/pantry');
	await expect(b.getByText('Pantry is empty')).toBeVisible();

	await a.goto('/pantry');
	await a.getByRole('button', { name: '+ Add stock' }).click();
	await a.locator('#add-name').fill('rice');
	await a.getByRole('option', { name: /^rice/ }).first().click();
	await a.locator('#add-qty').fill('1');
	await a.locator('#add-unit').selectOption('kg');
	await a.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(a.getByText('1 kg', { exact: true }).first()).toBeVisible();

	// device B polls every PUBLIC_REVISION_POLL_MS (2 s in .env.test)
	await expect(b.getByText('1 kg', { exact: true }).first()).toBeVisible({ timeout: 10_000 });

	// B opens a sheet (dirty input); A changes stock again; B keeps its sheet and gets a notice
	await b.getByRole('button', { name: '+ Add stock' }).click();
	await b.locator('#add-qty').fill('250');
	await a.getByRole('button', { name: 'Add stock', exact: true }).first().click();
	await a.locator('#add-qty').fill('2');
	await a.locator('#add-unit').selectOption('kg');
	await a.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(b.getByText('Changed by another member')).toBeVisible({ timeout: 10_000 });
	await expect(b.locator('#add-qty')).toHaveValue('250');
	await ctxA.close();
	await ctxB.close();
});
