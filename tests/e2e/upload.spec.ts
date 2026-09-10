import { expect, test } from '@playwright/test';
import { register } from './helpers';
import sharp from 'sharp';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A photo the size a phone actually produces: 4032x3024, ~3.6 MB. */
async function bigPhoto(): Promise<string> {
	const w = 4032;
	const h = 3024;
	const px = Buffer.alloc(w * h * 3);
	let i = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const n = ((x * 7 + y * 13) % 32) - 16;
			px[i++] = Math.max(0, Math.min(255, ((x / w) * 255 + n) | 0));
			px[i++] = Math.max(0, Math.min(255, ((y / h) * 255 + n) | 0));
			px[i++] = Math.max(0, Math.min(255, (((x + y) / (w + h)) * 255 + n) | 0));
		}
	}
	const jpeg = await sharp(px, { raw: { width: w, height: h, channels: 3 } })
		.jpeg({ quality: 92 })
		.toBuffer();
	const dir = await mkdtemp(path.join(tmpdir(), 'mk-upload-'));
	const file = path.join(dir, 'phone-photo.jpg');
	await writeFile(file, jpeg);
	return file;
}

/**
 * Playwright reports requestBodySize 0 for SvelteKit's fetch-based multipart submit,
 * so measure the blob actually handed to fetch instead.
 */
async function recordUploadedBytes(page: import('@playwright/test').Page) {
	await page.addInitScript(() => {
		(window as unknown as Record<string, unknown>).__uploadBytes = 0;
		const original = window.fetch;
		window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const body = init?.body;
			if (body instanceof FormData) {
				let total = 0;
				for (const [, value] of body.entries()) if (value instanceof Blob) total += value.size;
				const w = window as unknown as Record<string, number>;
				if (total > w.__uploadBytes) w.__uploadBytes = total;
			}
			return original(input, init);
		};
	});
}

test('a phone-sized photo is downscaled in the browser before upload', async ({ page }) => {
	const photo = await bigPhoto();
	const original = (await stat(photo)).size;
	expect(original).toBeGreaterThan(3_000_000);

	await recordUploadedBytes(page);
	await register(page, 'Uma');

	await page.goto('/recipes/new');
	await page.getByLabel('Title').fill('Photographed');
	await page.getByLabel('Base servings').fill('2');
	await page.locator('#ing-0-name').fill('salt');
	await page.locator('#step-0-text').fill('Season.');
	await page.locator('#image').setInputFiles(photo);
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);

	const sent = await page.evaluate(
		() => (window as unknown as Record<string, number>).__uploadBytes
	);
	console.info(
		`upload: ${(original / 1024 / 1024).toFixed(2)} MB original -> ${(sent / 1024).toFixed(0)} KB sent`
	);
	// A fraction of what the phone produced, not the whole thing.
	expect(sent).toBeGreaterThan(0);
	expect(sent).toBeLessThan(original / 4);

	// What the server stored is unchanged: a 1600px WebP detail variant, aspect preserved.
	const src = (await page.locator('article img').first().getAttribute('src'))!;
	const detail = await page.request.get(src.replace('/thumb', '/detail'));
	expect(detail.status()).toBe(200);
	const meta = await sharp(await detail.body()).metadata();
	expect(meta.format).toBe('webp');
	expect(meta.width).toBe(1600);
	expect(meta.height).toBe(1200);
});

test('a small photo is left alone rather than re-encoded', async ({ page }) => {
	await recordUploadedBytes(page);
	await register(page, 'Ulf');
	const small = (await stat('tests/e2e/fixtures/photo.jpg')).size;

	await page.goto('/recipes/new');
	await page.getByLabel('Title').fill('Small photo');
	await page.getByLabel('Base servings').fill('2');
	await page.locator('#ing-0-name').fill('salt');
	await page.locator('#step-0-text').fill('Season.');
	await page.locator('#image').setInputFiles('tests/e2e/fixtures/photo.jpg');
	await page.getByRole('button', { name: 'Save recipe' }).click();
	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);

	// Below the threshold, so it goes up byte-for-byte: no pointless re-encode.
	const sent = await page.evaluate(
		() => (window as unknown as Record<string, number>).__uploadBytes
	);
	expect(sent).toBeGreaterThanOrEqual(small);
});
