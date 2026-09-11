import { createServer, type Server } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { register } from './helpers';

/**
 * The path from a barcode to pantry stock, with the product databases mocked.
 *
 * Desktop Chromium has no camera and no real barcode in front of it, so the
 * decoder is stubbed where the scanner transitions are exercised, and manual
 * entry is used for the path that must work when the camera cannot. Neither
 * proves anything about a physical iPhone or Android phone; see the device
 * checklist in docs/design-decisions.md.
 */

/**
 * The stub USDA the app is pointed at by .env.test. The lookup runs in the app
 * process, so a page.route() mock would never see it. Open Food Facts is
 * switched off for the same suite, so nothing here reaches the real internet.
 */
const STUB_PORT = 4319;
let stub: Server;
let answer: { status: number; body: unknown } | 'refuse' = { status: 200, body: { foods: [] } };
let asked = 0;

test.beforeAll(async () => {
	stub = createServer((req, res) => {
		asked++;
		if (answer === 'refuse') return req.socket.destroy();
		res.writeHead(answer.status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(answer.body));
	});
	await new Promise<void>((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => stub.close(() => resolve()));
});

const usdaFood = (gtinUpc: string, description: string) => ({
	totalHits: 1,
	foods: [
		{
			fdcId: 424242,
			description,
			dataType: 'Branded',
			gtinUpc,
			brandName: 'Acme',
			publicationDate: '2023-06-15',
			servingSize: 32,
			servingSizeUnit: 'g',
			packageWeight: '16 oz (454 g)',
			foodNutrients: [
				{
					nutrientId: 1003,
					nutrientNumber: '203',
					nutrientName: 'Protein',
					unitName: 'G',
					value: 25
				}
			]
		}
	]
});

function usdaAnswers(body: unknown, status = 200) {
	answer = { status, body };
}

/**
 * A valid UPC-A nobody has scanned before.
 *
 * Provider metadata is cached for 30 days and shared by every household, so a
 * fixed number would be answered from an earlier run's cache and the test would
 * never reach the stub. A fresh number keeps each run independent without
 * reaching into the database.
 */
function freshUpc(): string {
	const body = Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('');
	let sum = 0;
	for (let i = 0; i < body.length; i++)
		sum += Number(body[i]) * ((body.length - 1 - i) % 2 === 0 ? 3 : 1);
	return `${body}${(10 - (sum % 10)) % 10}`;
}

async function openScanner(page: Page) {
	await page.goto('/pantry');
	await page.getByRole('button', { name: 'Scan', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Scan a barcode' })).toBeVisible();
}

test.beforeEach(() => {
	asked = 0;
	answer = { status: 200, body: { totalHits: 0, foods: [] } };
});

test('a typed barcode becomes pantry stock, and is recognised next time', async ({ page }) => {
	await register(page, 'Scanner');
	const code = freshUpc();
	usdaAnswers(usdaFood(code, 'CREAMY PEANUT BUTTER'));
	await openScanner(page);

	await page.getByLabel('Or type the number under the barcode').fill(code);
	await page.getByRole('button', { name: 'Look up' }).click();

	const sheet = page.getByRole('dialog').filter({ hasText: 'Confirm this product' });
	await expect(sheet).toBeVisible();
	await expect(sheet).toContainText('CREAMY PEANUT BUTTER');
	await expect(sheet).toContainText('USDA FoodData Central');
	await expect(sheet).toContainText('Public domain');

	// USDA states net contents only as text, so the label is parsed to 16 oz.
	await expect(page.getByTestId('scan-total')).toHaveText(/16 oz/);

	await page.locator('#scan-qty').fill('454');
	await page.locator('#scan-unit').selectOption('g');
	await page.locator('#scan-count').fill('2');
	await expect(page.getByTestId('scan-total')).toHaveText(/908 g/);

	await page.locator('#scan-name').fill('Peanut butter');
	await page.getByRole('button', { name: 'Add to pantry' }).click();

	await expect(page.getByText('Stock added.')).toBeVisible();
	// The scanner re-arms for the next item in the trolley.
	await expect(page.getByRole('dialog', { name: 'Scan a barcode' })).toBeVisible();
	await page.getByRole('button', { name: 'Close' }).click();

	await page.goto('/pantry');
	await expect(page.getByText('peanut butter', { exact: false }).first()).toBeVisible();
	// The group total and its single lot both read 908 g: 454 g times two packages.
	await expect(page.getByText('908 g').first()).toBeVisible();

	// Second time round the household's own record answers, and the sheet says so.
	await openScanner(page);
	await page.getByLabel('Or type the number under the barcode').fill(code);
	await page.getByRole('button', { name: 'Look up' }).click();
	const again = page.getByRole('dialog').filter({ hasText: 'Add this again' });
	await expect(again).toBeVisible();
	await expect(again).toContainText('Saved by your household');
	// The household's own record answered; no provider was asked a second time.
	expect(asked).toBe(1);
	await expect(page.locator('#scan-qty')).toHaveValue('454');
	await expect(page.locator('#scan-count')).toHaveValue('2');
});

test('an unknown barcode can be named and is then remembered', async ({ page }) => {
	await register(page, 'Unknown');
	const code = freshUpc();
	usdaAnswers({ totalHits: 0, foods: [] });
	await openScanner(page);

	await page.getByLabel('Or type the number under the barcode').fill(code);
	await page.getByRole('button', { name: 'Look up' }).click();

	const sheet = page.getByRole('dialog').filter({ hasText: 'Confirm this product' });
	await expect(sheet).toContainText('No product database holds this barcode');
	await expect(page.getByTestId('scan-total')).toHaveText('—');

	await page.locator('#scan-name').fill('Chickpeas in brine');
	await page.locator('#scan-qty').fill('400');
	await page.locator('#scan-unit').selectOption('g');
	await page.getByRole('button', { name: 'Add to pantry' }).click();
	await expect(page.getByText('Stock added.')).toBeVisible();
	await page.getByRole('button', { name: 'Close' }).click();

	await openScanner(page);
	await page.getByLabel('Or type the number under the barcode').fill(code);
	await page.getByRole('button', { name: 'Look up' }).click();
	await expect(page.getByRole('dialog').filter({ hasText: 'Add this again' })).toBeVisible();
	await expect(page.locator('#scan-qty')).toHaveValue('400');
});

test('an unreadable number is refused without opening the confirmation', async ({ page }) => {
	await register(page, 'BadCode');
	await openScanner(page);

	await page.getByLabel('Or type the number under the barcode').fill('012345678904');
	await page.getByRole('button', { name: 'Look up' }).click();
	await expect(page.getByText(/check digit/i)).toBeVisible();
	await expect(page.getByRole('dialog').filter({ hasText: 'Confirm this product' })).toHaveCount(0);

	// Eight digits are two different products until the reading is settled.
	await page.getByLabel('Or type the number under the barcode').fill('01234565');
	await page.getByRole('button', { name: 'Look up' }).click();
	await expect(page.getByText(/UPC-E or EAN-8/i)).toBeVisible();
});

test('a provider outage still allows an ordinary add, and is not a confirmed miss', async ({
	page
}) => {
	await register(page, 'Outage');
	answer = 'refuse';
	await openScanner(page);

	await page.getByLabel('Or type the number under the barcode').fill(freshUpc());
	await page.getByRole('button', { name: 'Look up' }).click();

	const sheet = page.getByRole('dialog').filter({ hasText: 'Confirm this product' });
	await expect(sheet).toContainText('could not be reached');
	await expect(sheet).toContainText('not remembered as a miss');

	await page.locator('#scan-name').fill('Peanut butter');
	await page.locator('#scan-qty').fill('454');
	await page.locator('#scan-unit').selectOption('g');
	await page.getByRole('button', { name: 'Add to pantry' }).click();
	await expect(page.getByText('Stock added.')).toBeVisible();
});

test('the camera is released when the scanner closes and when the page is hidden', async ({
	page
}) => {
	await register(page, 'Camera');

	// A fake camera: one track whose stop() is counted.
	await page.addInitScript(() => {
		const stopped: string[] = [];
		(window as unknown as { __stopped: string[] }).__stopped = stopped;
		const track = {
			kind: 'video',
			stop: () => stopped.push('stop'),
			getCapabilities: () => ({}),
			applyConstraints: async () => {}
		};
		const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
		Object.defineProperty(navigator, 'mediaDevices', {
			configurable: true,
			value: { getUserMedia: async () => stream }
		});
	});

	await openScanner(page);
	await page.getByRole('button', { name: 'Close' }).click();
	await expect(page.getByRole('dialog', { name: 'Scan a barcode' })).toHaveCount(0);
	expect(
		await page.evaluate(() => (window as unknown as { __stopped: string[] }).__stopped.length)
	).toBeGreaterThan(0);

	await page.getByRole('button', { name: 'Scan', exact: true }).click();
	const before = await page.evaluate(
		() => (window as unknown as { __stopped: string[] }).__stopped.length
	);
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await expect
		.poll(() =>
			page.evaluate(() => (window as unknown as { __stopped: string[] }).__stopped.length)
		)
		.toBeGreaterThan(before);
	// Coming back is deliberate, not automatic.
	await expect(page.getByRole('button', { name: 'Scan again' })).toBeVisible();
});
