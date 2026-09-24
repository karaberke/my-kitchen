import { expect, test } from '@playwright/test';
import { createRecipe, register } from './helpers';

test.describe('recipe filters', () => {
	test('scope and category filters combine without losing search state, pills remove one at a time, and Escape closes the menu', async ({
		page
	}) => {
		await register(page, 'Filtra');
		const recipeId = await createRecipe(page, {
			title: 'Weeknight lentil soup',
			servings: '4',
			ingredient: { amount: '300', unit: 'g', name: 'red lentils' },
			step: 'Simmer until soft.',
			tags: 'weeknight'
		});

		// a category, created from the recipes list page's "Manage categories…" sheet
		// (the button lives inside the collapsed Filter <details>, so open it first)
		await page.goto('/recipes');
		await page.locator('details').filter({ hasText: 'Filter' }).locator('summary').click();
		await page.getByRole('button', { name: 'Manage categories…' }).click();
		await page.getByLabel('New category name').fill('Soups');
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByRole('textbox', { name: 'Category name' })).toHaveValue('Soups');
		await page.getByRole('button', { name: 'Close' }).click();

		// add the recipe to that category from its own page's "Categories…" sheet
		await page.goto(`/recipes/${recipeId}`);
		await page.getByRole('button', { name: 'Categories…' }).click();
		const categoryCheckbox = page.getByRole('checkbox', { name: 'Soups' });
		await categoryCheckbox.check();
		await expect(categoryCheckbox).toBeChecked();
		await page.getByRole('button', { name: 'Close' }).click();

		await page.goto('/recipes?q=lentil&tag=weeknight');
		await expect(page.getByRole('heading', { name: 'Weeknight lentil soup' })).toBeVisible();

		const details = page.locator('details').filter({ hasText: 'Filter' });
		await details.locator('summary').click();
		await expect(details).toHaveAttribute('open');

		await details.getByRole('checkbox', { name: 'Mine' }).check();
		await expect(page).toHaveURL(/scope=mine/);
		// The checkbox change resubmits the search form; the menu must not close on us.
		await expect(details).toHaveAttribute('open');

		const catCheckbox = details.getByRole('checkbox', { name: 'Soups' });
		const categoryId = await catCheckbox.getAttribute('value');
		expect(categoryId).toBeTruthy();
		await catCheckbox.check();
		await expect(page).toHaveURL(new RegExp(`cat=${categoryId}`));
		await expect(details).toHaveAttribute('open');

		let url = new URL(page.url());
		expect(url.searchParams.get('scope')).toBe('mine');
		expect(url.searchParams.get('cat')).toBe(categoryId);
		expect(url.searchParams.get('q')).toBe('lentil');
		expect(url.searchParams.get('tag')).toBe('weeknight');
		await expect(page.getByRole('link', { name: 'Remove Mine filter' })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Remove Soups filter' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Weeknight lentil soup' })).toBeVisible();

		await page.getByRole('link', { name: 'Remove Mine filter' }).click();
		await expect(page).not.toHaveURL(/scope=mine/);
		url = new URL(page.url());
		expect(url.searchParams.get('scope')).toBeNull();
		expect(url.searchParams.get('cat')).toBe(categoryId);
		expect(url.searchParams.get('q')).toBe('lentil');
		expect(url.searchParams.get('tag')).toBe('weeknight');
		await expect(page.getByRole('link', { name: 'Remove Mine filter' })).toHaveCount(0);
		await expect(page.getByRole('link', { name: 'Remove Soups filter' })).toBeVisible();

		if (!(await details.getAttribute('open'))) await details.locator('summary').click();
		await expect(details).toHaveAttribute('open');
		await page.keyboard.press('Escape');
		await expect(details).not.toHaveAttribute('open');
	});

	test('a filter with no matches shows the empty state, and Clear resets it', async ({ page }) => {
		await register(page, 'Nomatch');
		await createRecipe(page, {
			title: 'Only recipe here',
			servings: '2',
			ingredient: { amount: '1', unit: 'unit', name: 'egg' },
			step: 'Boil.'
		});

		// the recipe was never favorited, so this filter matches nothing
		await page.goto('/recipes?favorites=1');
		await expect(page.getByText('Nothing matches')).toBeVisible();
		await expect(page.getByText('Try another search or filter.')).toBeVisible();
		await expect(page.getByRole('link', { name: 'Remove Favorites filter' })).toBeVisible();

		await page.getByRole('link', { name: 'Clear' }).click();
		await expect(page).toHaveURL('/recipes');
		await expect(page.getByRole('heading', { name: 'Only recipe here' })).toBeVisible();
	});
});
