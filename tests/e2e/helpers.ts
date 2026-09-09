import { expect, type Page } from '@playwright/test';

let seq = 0;
export function uniqueEmail(prefix: string): string {
	seq++;
	return `${prefix}-${Date.now()}-${seq}@example.test`;
}

export async function register(
	page: Page,
	name: string,
	email = uniqueEmail(name.toLowerCase()),
	password = 'correct horse battery'
) {
	await page.goto('/register');
	await page.getByLabel('Your name').fill(name);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Create account' }).click();
	await expect(page).toHaveURL(/\/recipes/);
	return { email, password };
}

export async function login(page: Page, email: string, password = 'correct horse battery') {
	await page.goto('/login');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/recipes/);
}

export async function createRecipe(
	page: Page,
	opts: {
		title: string;
		servings?: string;
		ingredient?: { amount: string; unit: string; name: string; match?: string };
		step?: string;
		draft?: boolean;
	}
) {
	await page.goto('/recipes/new');
	await page.getByLabel('Title').fill(opts.title);
	if (opts.servings) await page.getByLabel('Base servings').fill(opts.servings);
	if (opts.ingredient) {
		await page.locator('#ing-0-amount').fill(opts.ingredient.amount);
		await page.locator('#ing-0-unit').fill(opts.ingredient.unit);
		await page.locator('#ing-0-name').fill(opts.ingredient.name);
		if (opts.ingredient.match) {
			await page
				.getByRole('option', { name: new RegExp(opts.ingredient.match, 'i') })
				.first()
				.click();
			await expect(page.getByText(`Tracked as`).first()).toBeVisible();
		}
	}
	if (opts.step) await page.locator('#step-0-text').fill(opts.step);
	await page.getByRole('button', { name: opts.draft ? 'Save draft' : 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
	return page.url().split('/').pop()!;
}
