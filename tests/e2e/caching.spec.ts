import { expect, test } from '@playwright/test';
import { createRecipe, register } from './helpers';
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

	// hashed asset from the page
	const src = await page
		.locator('link[rel=modulepreload], script[src]')
		.first()
		.getAttribute('href')
		.catch(() => null);
	const assetUrl =
		src ?? (await page.locator('script[src*="/_app/immutable/"]').first().getAttribute('src'));
	if (assetUrl) {
		const asset = await page.request.get(assetUrl);
		expect(asset.status()).toBe(200);
		expect(asset.headers()['cache-control']).toContain('immutable');
	}
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
	const media = await page.request.get(mediaUrl);
	expect(media.status()).toBe(200);
	expect(media.headers()['cache-control']).toBe('private, no-cache');
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
