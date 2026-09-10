import { expect, test } from '@playwright/test';
import { register } from './helpers';
import path from 'node:path';

test('cache headers: immutable assets, no-store pages/data, private media with authorized 304', async ({
	page,
	browser
}) => {
	await register(page, 'Dana');
	const html = await page.request.get('/recipes');
	expect(html.headers()['cache-control']).toBe('private, no-store');
	const data = await page.request.get('/recipes/__data.json');
	expect(data.headers()['cache-control']).toBe('private, no-store');
	const rev = await page.request.get('/api/revisions');
	expect(rev.headers()['cache-control']).toBe('private, no-store');
	expect(Number(rev.headers()['content-length'] ?? (await rev.text()).length)).toBeLessThan(200);

	// SvelteKit can load JavaScript through inline imports, so use its stylesheet.
	const assetUrl = await page
		.locator('link[rel="stylesheet"][href*="/_app/immutable/"]')
		.first()
		.getAttribute('href');
	expect(assetUrl).toBeTruthy();
	const asset = await page.request.get(assetUrl!);
	expect(asset.status()).toBe(200);
	expect(asset.headers()['cache-control']).toContain('immutable');

	const missing = await page.request.get('/_app/immutable/does-not-exist.js');
	expect(missing.status()).toBe(404);
	expect(missing.headers()['cache-control'] ?? '').not.toContain('immutable');

	// upload an image and check private media policy
	await page.goto('/recipes/new');
	await page.getByLabel('Title').fill('With photo');
	await page.getByLabel('Base servings').fill('2');
	await page.locator('#ing-0-name').fill('salt');
	await page.locator('#step-0-text').fill('Season.');
	await page.locator('#image').setInputFiles(path.resolve('tests/e2e/fixtures/photo.jpg'));
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
	const img = page.locator('article img').first();
	const mediaUrl = (await img.getAttribute('src'))!;
	// Normal repeat navigation (a forced reload explicitly asks the browser to revalidate).
	await page.goto('/recipes');
	await page
		.locator('main img')
		.first()
		.evaluate((el) => (el as HTMLImageElement).decode());
	await page.goto('/plan');
	await page.goto('/recipes');
	await page
		.locator('main img')
		.first()
		.evaluate((el) => (el as HTMLImageElement).decode());
	const mediaTransfers = await page.evaluate(() =>
		performance
			.getEntriesByType('resource')
			.filter((e) => new URL(e.name).pathname.startsWith('/media/'))
			.map((e) => (e as PerformanceResourceTiming).transferSize)
	);
	console.info('Repeat recipes navigation media transfer sizes:', mediaTransfers);
	expect(mediaTransfers).toEqual([0]);
	const media = await page.request.get(mediaUrl);
	expect(media.status()).toBe(200);
	// Content-addressed, so the browser may reuse it briefly without revalidating; the
	// window bounds how long a revoked viewer keeps seeing their own cached copy.
	expect(media.headers()['cache-control']).toBe('private, max-age=300');
	const etag = media.headers()['etag'];
	expect(etag).toBeTruthy();
	const conditional = await page.request.get(mediaUrl, { headers: { 'if-none-match': etag } });
	expect(conditional.status()).toBe(304);

	// another user: no bytes, and no 304 either
	const other = await browser.newContext();
	const otherPage = await other.newPage();
	await register(otherPage, 'Eve');
	const denied = await otherPage.request.get(mediaUrl, { headers: { 'if-none-match': etag } });
	expect(denied.status()).toBe(404);
	const anon = await (
		await browser.newContext()
	).request.get(mediaUrl, { headers: { 'if-none-match': etag } });
	expect(anon.status()).toBe(401);
	await other.close();
});

test('with no provider credentials configured, sign-in stays password-only', async ({ page }) => {
	// The test environment sets no GOOGLE_/MICROSOFT_/APPLE_ variables, so the
	// buttons must not appear and the social action must refuse.
	await page.goto('/login');
	await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	await expect(page.getByText('or continue with')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /Continue with/ })).toHaveCount(0);

	const res = await page.request.post(new URL('/login?/social', page.url()).toString(), {
		form: { provider: 'google', next: '/recipes' },
		// Same-origin header, so this gets past CSRF and actually reaches the action.
		headers: { origin: new URL(page.url()).origin, 'x-sveltekit-action': 'true' }
	});
	// SvelteKit reports an action failure as 200 with the status inside the body.
	const body = JSON.parse(await res.text());
	expect(body.type).toBe('failure');
	expect(body.status).toBe(400);
	expect(String(body.data)).toContain('not available');
	// And crucially, no redirect off to a provider was ever issued.
	expect(res.headers()['location']).toBeUndefined();
});
