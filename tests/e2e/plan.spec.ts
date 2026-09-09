import { expect, test, type Page } from '@playwright/test';
import { createRecipe, register } from './helpers';

/** The card for a weekday, by its visible long name. */
function dayCard(page: Page, weekday: string) {
	return page.locator('section').filter({ has: page.getByRole('heading', { name: weekday }) });
}

const monday = () => {
	const d = new Date();
	const shift = d.getDay() === 0 ? -6 : 1 - d.getDay();
	d.setDate(d.getDate() + shift);
	return d.toLocaleDateString(undefined, { weekday: 'long' });
};

test('plan a recipe and a note, then push the week to the grocery list', async ({ page }) => {
	await register(page, 'Pia');
	await createRecipe(page, {
		title: 'Roast',
		servings: '4',
		ingredient: { amount: '500', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
		step: 'Roast it.'
	});

	await page.goto('/plan');
	await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
	// Seven day cards, all empty to begin with.
	await expect(page.getByText('Nothing planned.')).toHaveCount(7);
	await expect(page.getByText('0 meals across 0 of 7 days')).toBeVisible();
	// Nothing to shop for yet.
	await expect(page.getByRole('button', { name: 'Add this week to grocery list' })).toBeDisabled();

	// Plan the saved recipe on Monday.
	const mon = dayCard(page, monday());
	await mon.getByRole('button', { name: '+ Add meal' }).click();
	const sheet = page.getByRole('dialog');
	await expect(sheet).toContainText(`Plan ${monday()}`);
	await sheet.getByRole('button', { name: /Roast/ }).click();
	await expect(sheet).toBeHidden();
	await expect(mon.getByRole('link', { name: /Roast/ })).toBeVisible();
	await expect(page.getByText('1 meal across 1 of 7 days')).toBeVisible();

	// Plan a free-text note on the same day.
	await mon.getByRole('button', { name: '+ Add meal' }).click();
	await sheet.locator('#plan-note').fill('Takeaway night');
	await sheet.getByRole('button', { name: 'Add note' }).click();
	await expect(sheet).toBeHidden();
	await expect(mon.getByText('Takeaway night')).toBeVisible();
	await expect(mon.getByText('Note · no recipe attached')).toBeVisible();
	await expect(page.getByText('2 meals across 1 of 7 days')).toBeVisible();

	// The planned recipe carries through to a grocery list.
	await page.getByRole('button', { name: 'Add this week to grocery list' }).click();
	await expect(page).toHaveURL(/\/grocery\/[0-9a-f-]{36}$/);
	await expect(page.getByRole('heading', { name: 'Planned recipes' })).toBeVisible();
	await expect(page.getByText('· 4 servings')).toBeVisible();
	// The recipe's ingredients made it onto the list; the note contributed nothing.
	await expect(page.getByText(/For Roast \(500 g\)/)).toBeVisible();
	await expect(page.getByText('Takeaway night')).toHaveCount(0);
});

test('remove a planned meal', async ({ page }) => {
	await register(page, 'Rex');
	await page.goto('/plan');
	const mon = dayCard(page, monday());
	await mon.getByRole('button', { name: '+ Add meal' }).click();
	const sheet = page.getByRole('dialog');
	await sheet.locator('#plan-note').fill('Soup');
	await sheet.getByRole('button', { name: 'Add note' }).click();
	await expect(mon.getByText('Soup')).toBeVisible();

	await mon.getByRole('button', { name: /Remove Soup/ }).click();
	await expect(mon.getByText('Soup')).toHaveCount(0);
	await expect(page.getByText('0 meals across 0 of 7 days')).toBeVisible();
});

test('the plan is shared with the household and private to it', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const a = await ctxA.newPage();
	const b = await ctxB.newPage();
	await register(a, 'Ann');
	await register(b, 'Ben');

	// Ben joins Ann's household.
	await a.goto('/household');
	await a.getByRole('link', { name: /Ann's kitchen/ }).click();
	await a.getByRole('button', { name: 'Create invitation link' }).click();
	const link = await a.getByLabel('Invitation link').inputValue();
	await b.goto(link);
	await b.getByRole('button', { name: /Join/ }).click();
	await expect(b).toHaveURL(/\/household\/[0-9a-f-]{36}$/);

	await a.goto('/plan');
	const mon = dayCard(a, monday());
	await mon.getByRole('button', { name: '+ Add meal' }).click();
	await a.getByRole('dialog').locator('#plan-note').fill('Shared supper');
	await a.getByRole('dialog').getByRole('button', { name: 'Add note' }).click();
	await expect(mon.getByText('Shared supper')).toBeVisible();

	// Ben sees it in the shared household...
	await b.goto('/plan');
	await expect(b.getByText('Shared supper')).toBeVisible();
	// ...but only while he is a member of it.
	await b.goto('/household');
	await b.getByRole('link', { name: /Ann's kitchen/ }).click();
	b.once('dialog', (d) => d.accept());
	await b.getByRole('button', { name: 'Leave this household' }).click();
	await expect(b).toHaveURL(/\/household$/);
	await b.goto('/plan');
	await expect(b.getByText('Shared supper')).toHaveCount(0);

	await ctxA.close();
	await ctxB.close();
});
