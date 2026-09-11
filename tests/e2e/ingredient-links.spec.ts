import { expect, test } from '@playwright/test';
import { register } from './helpers';

test.describe('pantry links', () => {
	test('an unlinked name gets its link from the review screen, and the circle follows', async ({
		page
	}) => {
		await register(page, 'Linus');

		// A recipe whose ingredient points at nothing: the name is typed and left alone.
		await page.goto('/recipes/new');
		await page.getByLabel('Title').fill('Cream test');
		await page.getByLabel('Base servings').fill('4');
		await page.locator('#ing-0-amount').fill('200');
		await page.locator('#ing-0-unit').fill('ml');
		await page.locator('#ing-0-name').fill('heavy cream, cold');
		// The form proposes a match on blur; refuse it, so the row stays unlinked.
		await page.locator('#step-0-text').click();
		await expect(page.getByText('Proposed: cream')).toBeVisible();
		await page.getByRole('button', { name: 'Remove ingredient match' }).click();
		await page.locator('#step-0-text').fill('Whip it.');
		await page.getByRole('button', { name: 'Save recipe' }).click();
		await expect(page.getByText('Check while cooking').first()).toBeVisible();

		// The review screen proposes the same match for the saved recipe.
		await page.goto('/settings/ingredient-links');
		await expect(page.getByText('heavy cream, cold', { exact: true })).toBeVisible();
		await expect(page.getByText('Proposed: cream')).toBeVisible();
		await page.getByRole('button', { name: /^Link 1 ingredient$/ }).click();
		await expect(page.getByText('Everything is linked')).toBeVisible();

		// The recipe now compares against the pantry: nothing in stock, so red.
		await page.goto('/recipes');
		await page.getByRole('link', { name: 'Cream test' }).click();
		await expect(page.getByText('Not in pantry')).toBeVisible();
	});
});
