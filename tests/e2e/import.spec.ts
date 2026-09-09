import { expect, test } from '@playwright/test';
import { register } from './helpers';

const JSONLD_PAGE = `<!DOCTYPE html><html><head><title>Some blog</title>
<script type="application/ld+json">${JSON.stringify({
	'@context': 'https://schema.org',
	'@type': 'Recipe',
	name: 'Red lentil dal',
	description: 'A weeknight dal.',
	recipeYield: '4 servings',
	prepTime: 'PT15M',
	cookTime: 'PT45M',
	recipeIngredient: ['200 g red lentils', '1 tbsp olive oil'],
	recipeInstructions: [
		{ '@type': 'HowToStep', text: 'Rinse the lentils.' },
		{ '@type': 'HowToStep', text: 'Simmer until soft.' }
	]
})}</script></head><body><p>Ignore this.</p></body></html>`;

const PLAIN_PAGE = `<!DOCTYPE html><html><head><title>Nan's stew</title></head>
<body><script>window.leaked = 'SHOULD_NOT_APPEAR'</script>
<h1>Stew</h1><p>Brown the beef, then simmer.</p></body></html>`;

test('the add chooser offers both ways in', async ({ page }) => {
	await register(page, 'Ivy');
	await page.goto('/recipes');
	await page.getByRole('link', { name: '+ Add' }).click();
	await expect(page).toHaveURL(/\/recipes\/add$/);

	await page.getByRole('link', { name: /Enter manually/ }).click();
	await expect(page).toHaveURL(/\/recipes\/new$/);

	await page.goto('/recipes/add');
	await page.getByRole('link', { name: /Import an HTML page/ }).click();
	await expect(page).toHaveURL(/\/recipes\/import$/);
	// Nothing to read yet, so the button stays disabled.
	await expect(page.getByRole('button', { name: 'Read the recipe' })).toBeDisabled();
});

test('imports structured recipe data from pasted HTML and saves it', async ({ page }) => {
	await register(page, 'Iris');
	await page.goto('/recipes/import');
	await page.locator('#import-html').fill(JSONLD_PAGE);
	await page.getByRole('button', { name: 'Read the recipe' }).click();

	await expect(page.getByRole('heading', { name: 'Check the import' })).toBeVisible();
	await expect(page.getByText(/Found recipe data in the page/)).toBeVisible();
	// Fields arrive prefilled from the JSON-LD.
	await expect(page.getByLabel('Title')).toHaveValue('Red lentil dal');
	await expect(page.getByLabel('Base servings')).toHaveValue('4');
	await expect(page.locator('#ing-0-name')).toHaveValue('red lentils');
	await expect(page.locator('#ing-0-amount')).toHaveValue('200');
	await expect(page.locator('#ing-0-unit')).toHaveValue('g');
	await expect(page.locator('#ing-1-name')).toHaveValue('olive oil');
	await expect(page.locator('#step-0-text')).toHaveValue('Rinse the lentils.');
	await expect(page.locator('#step-1-text')).toHaveValue('Simmer until soft.');

	// Nothing is saved until the user says so.
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
	await expect(page.getByRole('heading', { name: 'Red lentil dal' })).toBeVisible();
});

test('a title typed on the import form wins over the one in the page', async ({ page }) => {
	await register(page, 'Ines');
	await page.goto('/recipes/import');
	await page.locator('#import-title').fill('Dad’s dal');
	await page.locator('#import-html').fill(JSONLD_PAGE);
	await page.getByRole('button', { name: 'Read the recipe' }).click();
	await expect(page.getByLabel('Title')).toHaveValue('Dad’s dal');
});

test('falls back to readable text when the page has no recipe data, without leaking scripts', async ({
	page
}) => {
	await register(page, 'Ivan');
	await page.goto('/recipes/import');
	await page.locator('#import-html').fill(PLAIN_PAGE);
	await page.getByRole('button', { name: 'Read the recipe' }).click();

	await expect(page.getByText(/No structured recipe data/)).toBeVisible();
	await expect(page.getByLabel('Title')).toHaveValue("Nan's stew");
	const notes = page.getByLabel('Notes');
	await expect(notes).toHaveValue(/Brown the beef/);
	// Script contents never reach the form, and nothing from the page executes.
	await expect(notes).not.toHaveValue(/SHOULD_NOT_APPEAR/);
	expect(
		await page.evaluate(() => (window as unknown as Record<string, unknown>).leaked)
	).toBeUndefined();
});

test('imports from an uploaded HTML file', async ({ page }) => {
	await register(page, 'Ida');
	await page.goto('/recipes/import');
	await page.locator('#import-file').setInputFiles({
		name: 'dal-recipe.html',
		mimeType: 'text/html',
		buffer: Buffer.from(JSONLD_PAGE)
	});
	await page.getByRole('button', { name: 'Read the recipe' }).click();
	await expect(page.getByLabel('Title')).toHaveValue('Red lentil dal');
	await expect(page.locator('#ing-0-name')).toHaveValue('red lentils');
	await expect(page.locator('#ing-0-amount')).toHaveValue('200');
	await expect(page.locator('#ing-0-unit')).toHaveValue('g');
});

test('imports a PDF, keeps it as the source, and opens it from the recipe', async ({ page }) => {
	await register(page, 'Pia');
	await page.goto('/recipes/add');
	await page.getByRole('link', { name: /Import a PDF/ }).click();
	await expect(page).toHaveURL(/kind=pdf/);

	await page.locator('#import-file').setInputFiles('tests/e2e/fixtures/dal-recipe.pdf');
	await page.getByRole('button', { name: 'Read the recipe' }).click();

	await expect(page.getByText(/Text came from the PDF page layout/)).toBeVisible();
	await expect(page.getByLabel('Title')).toHaveValue('Coconut Red Lentil Dal');
	await expect(page.getByLabel('Base servings')).toHaveValue('4');
	await expect(page.getByLabel('Prep (min)')).toHaveValue('10');
	// Ingredients are split, including the "1 can (400 ml)" case.
	await expect(page.locator('#ing-0-amount')).toHaveValue('300');
	await expect(page.locator('#ing-0-unit')).toHaveValue('g');
	await expect(page.locator('#ing-1-amount')).toHaveValue('400');
	await expect(page.locator('#ing-1-unit')).toHaveValue('ml');
	await expect(page.locator('#step-0-text')).toHaveValue(
		'Rinse the lentils until the water runs clear.'
	);
	// The source is kept and openable straight away.
	const sourceLink = page.getByRole('link', { name: 'dal-recipe.pdf' });
	await expect(sourceLink).toBeVisible();

	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
	// ...and stays with the saved recipe.
	const onRecipe = page.getByRole('link', { name: 'dal-recipe.pdf' });
	await expect(onRecipe).toBeVisible();
	const href = await onRecipe.getAttribute('href');
	const res = await page.request.get(href!);
	expect(res.status()).toBe(200);
	expect(res.headers()['content-type']).toBe('application/pdf');
});

test('a PDF with no text layer is still attached so the recipe can be typed in', async ({
	page
}) => {
	await register(page, 'Pol');
	await page.goto('/recipes/import?kind=pdf');
	await page.locator('#import-file').setInputFiles('tests/e2e/fixtures/scanned.pdf');
	await page.getByRole('button', { name: 'Read the recipe' }).click();

	await expect(page.getByText(/No readable text in that PDF/)).toBeVisible();
	await expect(page.getByRole('link', { name: 'scanned.pdf' })).toBeVisible();
	await expect(page.getByLabel('Title')).toHaveValue('');
});

test('another user cannot open someone else’s imported source', async ({ browser }) => {
	const ctxA = await browser.newContext();
	const ctxB = await browser.newContext();
	const a = await ctxA.newPage();
	const b = await ctxB.newPage();
	await register(a, 'Ana');
	await register(b, 'Bo');

	await a.goto('/recipes/import?kind=pdf');
	await a.locator('#import-file').setInputFiles('tests/e2e/fixtures/dal-recipe.pdf');
	await a.getByRole('button', { name: 'Read the recipe' }).click();
	const href = await a.getByRole('link', { name: 'dal-recipe.pdf' }).getAttribute('href');

	expect((await b.request.get(href!)).status()).toBe(404);
	expect((await a.request.get(href!)).status()).toBe(200);
	await ctxA.close();
	await ctxB.close();
});
