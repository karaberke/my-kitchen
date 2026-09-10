import { expect, test } from '@playwright/test';
import { createRecipe, register } from './helpers';

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

	await expect(page.getByText(/no structured recipe data/i)).toBeVisible();
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
	await expect(page.getByRole('link', { name: 'scanned.pdf', exact: true })).toBeVisible();
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

test('a saved HTML page can be opened, but is served inert', async ({ page }) => {
	await register(page, 'Ivo');
	await page.goto('/recipes/import');
	await page.locator('#import-html').fill(PLAIN_PAGE);
	await page.getByRole('button', { name: 'Read the recipe' }).click();

	const open = page.getByRole('link', { name: /Open .* in a new tab/ });
	await expect(open).toBeVisible();
	const href = await open.getAttribute('href');

	const res = await page.request.get(href!);
	expect(res.status()).toBe(200);
	// Served as a page you can read...
	expect(res.headers()['content-type']).toContain('text/html');
	expect(res.headers()['content-disposition']).toContain('inline');
	// ...but sandboxed into an opaque origin where nothing runs or phones home.
	const csp = res.headers()['content-security-policy'];
	expect(csp).toContain('sandbox');
	expect(csp).not.toContain('allow-scripts');
	expect(csp).not.toContain('allow-same-origin');
	expect(csp).toContain("default-src 'none'");
	expect(res.headers()['x-content-type-options']).toBe('nosniff');
	// The bytes are the original, script tag and all — it is neutralised by headers, not edited.
	expect(await res.text()).toContain('SHOULD_NOT_APPEAR');
});

test('a whole website is not dumped into notes', async ({ page }) => {
	await register(page, 'Iggy');
	const bulky = `<html><head><title>Big blog</title></head><body>${'<p>Navigation and footer boilerplate.</p>'.repeat(200)}</body></html>`;
	await page.goto('/recipes/import');
	await page.locator('#import-html').fill(bulky);
	await page.getByRole('button', { name: 'Read the recipe' }).click();

	await expect(page.getByText(/no structured recipe data/i)).toBeVisible();
	await expect(page.getByLabel('Notes')).toHaveValue('');
	// The original is still there to read instead.
	await expect(page.getByRole('link', { name: /Open .* in a new tab/ })).toBeVisible();
});

test('a save that fails validation keeps the review screen, the edits and the reasons', async ({
	page
}) => {
	await register(page, 'Val');
	await page.goto('/recipes/import');
	await page.locator('#import-html').fill(PLAIN_PAGE);
	await page.getByRole('button', { name: 'Read the recipe' }).click();
	await expect(page.getByRole('heading', { name: 'Check the import' })).toBeVisible();

	// That page yields no servings, ingredients or steps, all of which a full save needs.
	await page.getByLabel('Title').fill('Nan’s stew');
	await page.getByRole('button', { name: 'Save recipe' }).click();

	// Still reviewing — not thrown back to the upload form.
	await expect(page.getByRole('heading', { name: 'Check the import' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Read the recipe' })).toHaveCount(0);
	// Every missing piece is named, not just the first.
	await expect(page.getByText('Please fix the highlighted fields.')).toBeVisible();
	await expect(page.getByText('Base servings are needed for scaling')).toBeVisible();
	await expect(page.getByText('Add at least one ingredient')).toBeVisible();
	await expect(page.getByText('Add at least one step')).toBeVisible();
	// The edits and the kept source survived.
	await expect(page.getByLabel('Title')).toHaveValue('Nan’s stew');
	await expect(page.getByRole('link', { name: /pasted-source\.html/ }).first()).toBeVisible();

	// Filling in what was flagged lets it save.
	await page.getByLabel('Base servings').fill('4');
	await page.locator('#ing-0-amount').fill('500');
	await page.locator('#ing-0-unit').fill('g');
	await page.locator('#ing-0-name').fill('beef shin');
	await page.locator('#step-0-text').fill('Brown the beef, then simmer.');
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
	await expect(page.getByRole('heading', { name: 'Nan’s stew' })).toBeVisible();
	// The source followed it through the failed attempt.
	await expect(page.getByRole('link', { name: 'View source' })).toBeVisible();
});

test('a file that cannot be read says so', async ({ page }) => {
	await register(page, 'Vic');
	await page.goto('/recipes/import?kind=pdf');
	// A .pdf that is not a PDF at all.
	await page.locator('#import-file').setInputFiles({
		name: 'broken.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('%PDF-1.4 this is not really a pdf')
	});
	await page.getByRole('button', { name: 'Read the recipe' }).click();
	await expect(page.getByText('That file could not be read as a PDF')).toBeVisible();
});

test('a saved import offers View source next to Print', async ({ page }) => {
	await register(page, 'Vera');
	await page.goto('/recipes/import');
	await page.locator('#import-html').fill(JSONLD_PAGE);
	await page.getByRole('button', { name: 'Read the recipe' }).click();
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);

	const view = page.getByRole('link', { name: 'View source' });
	await expect(view).toBeVisible();
	const res = await page.request.get((await view.getAttribute('href'))!);
	expect(res.status()).toBe(200);
	expect(res.headers()['cache-control']).toBe('private, max-age=300');
	const etag = res.headers()['etag'];
	expect(etag).toBeTruthy();
	const conditional = await page.request.get((await view.getAttribute('href'))!, {
		headers: { 'if-none-match': etag }
	});
	expect(conditional.status()).toBe(304);
});

test('a hand-entered recipe has no View source button', async ({ page }) => {
	await register(page, 'Vince');
	await createRecipe(page, {
		title: 'By hand',
		servings: '2',
		ingredient: { amount: '100', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
		step: 'Cook.'
	});
	await expect(page.getByRole('link', { name: 'View source' })).toHaveCount(0);
});

test('the browser parses the import, so the server never loads pdf.js', async ({ page }) => {
	await register(page, 'Cly');
	// Record what the form actually posts, to prove the parse happened client-side.
	await page.addInitScript(() => {
		(window as unknown as Record<string, unknown>).__sentClientParse = null;
		const original = window.fetch;
		window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const body = init?.body;
			if (body instanceof FormData && body.has('clientParsed'))
				(window as unknown as Record<string, unknown>).__sentClientParse = String(
					body.get('clientParsed')
				);
			return original(input, init);
		};
	});

	await page.goto('/recipes/import?kind=pdf');
	await page.locator('#import-file').setInputFiles('tests/e2e/fixtures/dal-recipe.pdf');
	await page.getByRole('button', { name: 'Read the recipe' }).click();

	// Same result the server used to produce, but computed in the browser.
	await expect(page.getByLabel('Title')).toHaveValue('Coconut Red Lentil Dal');
	await expect(page.locator('#ing-1-amount')).toHaveValue('400');
	await expect(page.locator('#ing-1-unit')).toHaveValue('ml');

	const sent = await page.evaluate(
		() => (window as unknown as Record<string, string | null>).__sentClientParse
	);
	expect(sent).toBeTruthy();
	const payload = JSON.parse(sent!);
	expect(payload.source).toBe('pdf');
	expect(payload.pageCount).toBe(2);
	expect(payload.input.title).toBe('Coconut Red Lentil Dal');
});

test('a client parse that is malformed is ignored, not trusted', async ({ page }) => {
	await register(page, 'Cla');
	// Forge a payload that fails the schema; the server must fall back to its own parse.
	await page.addInitScript(() => {
		const original = window.fetch;
		window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const body = init?.body;
			if (body instanceof FormData && body.has('clientParsed'))
				body.set('clientParsed', JSON.stringify({ source: 'nonsense', input: 'not an object' }));
			return original(input, init);
		};
	});

	await page.goto('/recipes/import?kind=pdf');
	await page.locator('#import-file').setInputFiles('tests/e2e/fixtures/dal-recipe.pdf');
	await page.getByRole('button', { name: 'Read the recipe' }).click();

	// Server-side parse produced the same recipe, so the forged payload changed nothing.
	await expect(page.getByLabel('Title')).toHaveValue('Coconut Red Lentil Dal');
	await expect(page.locator('#ing-0-amount')).toHaveValue('300');
});

test('pdf.js is not downloaded until a PDF is actually chosen', async ({ page }) => {
	await register(page, 'Chu');
	const scriptBytes = () =>
		page.evaluate(() =>
			performance
				.getEntriesByType('resource')
				.filter((e) => e.name.endsWith('.js'))
				.reduce((n, e) => n + (e as PerformanceResourceTiming).transferSize, 0)
		);

	await page.goto('/recipes/import?kind=pdf');
	await page.locator('#import-file').waitFor();
	const onLoad = await scriptBytes();
	// The page itself stays small: the parser is behind a dynamic import.
	expect(onLoad).toBeLessThan(500_000);

	await page.locator('#import-file').setInputFiles('tests/e2e/fixtures/dal-recipe.pdf');
	await page.getByRole('button', { name: 'Read the recipe' }).click();
	await expect(page.getByLabel('Title')).toHaveValue('Coconut Red Lentil Dal');

	// Choosing one pulls the parser in, so the cost falls only on imports that need it.
	const afterParse = await scriptBytes();
	console.info(
		`import page JS: ${(onLoad / 1024).toFixed(0)} KB on load -> ${(afterParse / 1024).toFixed(0)} KB after parsing a PDF`
	);
	expect(afterParse).toBeGreaterThan(onLoad);
});
