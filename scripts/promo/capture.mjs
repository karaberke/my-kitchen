#!/usr/bin/env node
/**
 * Record the existing mobile UI against the isolated, fictional promo fixture.
 * Usage: node scripts/promo/capture.mjs [--fixture artifacts/promo/fixture.json]
 * Keeps the unedited recording, genuine answer, screenshots and edit timestamps.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
	PROMO_BASE_URL,
	PROMO_OUTPUT_DIR,
	PROMO_SEGMENT_SECONDS,
	PROMO_VIEWPORT
} from './utils.mjs';
import {
	NATIVE_BROWSER_ARGS,
	NATIVE_CAPTURE_FPS,
	NATIVE_CAPTURE_SCALE,
	startNativeRecording
} from './recording.mjs';

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((arg, index, all) => (arg.startsWith('--') ? [arg.slice(2), all[index + 1]] : []))
		.filter((entry) => entry.length)
);
const outputDir = path.resolve(args.output ?? path.join(PROMO_OUTPUT_DIR, 'research-master'));
const fixturePath = path.resolve(args.fixture ?? path.join(outputDir, 'fixture.json'));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const base = new URL(fixture.baseUrl ?? PROMO_BASE_URL);
if (
	fixture.synthetic !== true ||
	!['127.0.0.1', 'localhost'].includes(base.hostname) ||
	base.port !== new URL(PROMO_BASE_URL).port
) {
	throw new Error(
		'Capture requires a synthetic fixture and the isolated loopback app on port 5180.'
	);
}

// Windows sandbox sessions may have a separate LOCALAPPDATA from the installed browsers.
if (process.platform === 'win32' && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
	const browserDirectory = path.join(homedir(), 'AppData', 'Local', 'ms-playwright');
	try {
		await access(browserDirectory);
		process.env.PLAYWRIGHT_BROWSERS_PATH = browserDirectory;
	} catch {
		// Playwright's normal lookup supplies the useful installation error.
	}
}
const { chromium, expect } = await import('@playwright/test');
const viewport = PROMO_VIEWPORT;
const question = 'Can I use olive oil instead of butter here?';
const recipeTitle = fixture.recipeTitle ?? 'Lemon garlic pasta';
const recipePath = `/recipes/${fixture.recipeId}`;
const oliveOilId = fixture.ingredientIds.oliveOil ?? fixture.ingredientIds['olive oil'];
const imagesDir = path.join(outputDir, 'screenshots');
await mkdir(imagesDir, { recursive: true });
await mkdir(path.join(outputDir, 'raw'), { recursive: true });

const timeline = {
	version: 1,
	viewport,
	sourceContent: {
		width: viewport.width * NATIVE_CAPTURE_SCALE,
		height: viewport.height * NATIVE_CAPTURE_SCALE
	},
	frameRate: NATIVE_CAPTURE_FPS,
	startedAt: new Date().toISOString(),
	recordingOffsetSeconds: 0,
	segments: [],
	events: [],
	cuts: [],
	assistant: { question, answer: '' },
	verification: {},
	sourceProvenance: {
		kind: 'Real local My Kitchen application and genuine local assistant response',
		fixturePath,
		recipePhoto: fixture.recipePhoto ?? null,
		frameSource:
			'Unmodified native compositor PNGs; lossless master preserves their source timestamps'
	}
};
const browser = await chromium.launch({
	headless: args.headed !== 'true',
	args: NATIVE_BROWSER_ARGS
});
let context;
let page;
let recordingStarted = 0;
let activeSegment;
let recording;
const screenshots = [];
const now = () =>
	recording ? recording.now() : Number(((performance.now() - recordingStarted) / 1000).toFixed(6));
const pause = (ms) => page.waitForTimeout(ms);

function mark(kind, label, details = {}) {
	const event = { kind, at: now(), label, ...details };
	timeline.events.push(event);
	console.log(`${event.at.toFixed(2)}s ${label}`);
}

function begin(name) {
	if (activeSegment) throw new Error(`Segment ${activeSegment.name} was not ended.`);
	activeSegment = {
		name,
		start: now(),
		targetDuration: PROMO_SEGMENT_SECONDS[name],
		maxSpeed: 1
	};
	mark('beat', name);
}

function end() {
	activeSegment.end = now();
	timeline.segments.push(activeSegment);
	activeSegment = undefined;
}

async function screenshot(name) {
	// Flush after the browser closes so Vite cannot reload the app during a take.
	screenshots.push({ name, buffer: await page.screenshot() });
	mark('screenshot', name);
}

/** One eased swipe in the nearest real scroll container; never relies on tap auto-scroll. */
async function smoothScroll(locator, { top, anchor = 130, ifNeeded = false, self = false } = {}) {
	await locator.waitFor({ state: 'visible' });
	await locator.evaluate(
		async (node, options) => {
			const root = document.scrollingElement;
			let container = options.self ? node : node.parentElement;
			while (container && container !== root) {
				const scrolls = /auto|scroll/.test(getComputedStyle(container).overflowY);
				if (scrolls && container.scrollHeight > container.clientHeight + 1) break;
				container = container.parentElement;
			}
			container ??= root;
			const isRoot = container === root;
			const bounds = isRoot ? { top: 0, bottom: innerHeight } : container.getBoundingClientRect();
			const box = node.getBoundingClientRect();
			if (
				options.ifNeeded &&
				box.top >= bounds.top + (isRoot ? 80 : 20) &&
				box.bottom <= bounds.bottom - (isRoot ? 112 : 24)
			)
				return;
			const from = container.scrollTop;
			const requested = options.top ?? from + box.top - bounds.top - options.anchor;
			const target = Math.max(
				0,
				Math.min(container.scrollHeight - container.clientHeight, requested)
			);
			const distance = target - from;
			if (Math.abs(distance) < 2) return;
			const duration = Math.min(850, Math.max(650, 650 + Math.abs(distance) * 0.15));
			const started = performance.now();
			await new Promise((resolve) => {
				function frame(time) {
					const progress = Math.min(1, (time - started) / duration);
					const eased = progress * progress * (3 - 2 * progress);
					container.scrollTo({ top: from + distance * eased, behavior: 'instant' });
					if (progress < 1) requestAnimationFrame(frame);
					else resolve();
				}
				requestAnimationFrame(frame);
			});
		},
		{ top, anchor, ifNeeded, self }
	);
}

async function tap(locator, label, { scroll = true } = {}) {
	if (scroll) await smoothScroll(locator, { ifNeeded: true });
	await expect(locator).toBeVisible();
	await expect(locator).toBeEnabled();
	await locator.tap({ trial: true });
	const box = await locator.boundingBox();
	if (!box) throw new Error(`No visible tap target: ${label}`);
	mark('tap', label, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
	await locator.tap();
	await pause(180);
}

async function type(locator, text, label) {
	await tap(locator, label);
	mark('type', label, { characters: text.length });
	// Slightly uneven, repeatable typing with pauses at word and sentence boundaries.
	for (const [index, character] of [...text].entries()) {
		await locator.pressSequentially(character, { delay: 80 + ((index * 13) % 31) });
		if (/[,.?]/.test(character)) await pause(90);
	}
	await expect(locator).toHaveValue(text);
}

async function cut(reason, action) {
	const start = now();
	mark('edit-start', reason);
	await action();
	const finish = now();
	if (finish - start >= 0.04) timeline.cuts.push({ start, end: finish, reason });
	mark('edit-end', reason);
}

try {
	// Sign in before recording: the fictional credentials never appear in the video.
	const loginContext = await browser.newContext({ baseURL: base.origin, viewport });
	const loginPage = await loginContext.newPage();
	await loginPage.goto('/login');
	await loginPage.waitForLoadState('networkidle');
	await loginPage.getByLabel('Email', { exact: true }).fill(fixture.user.email);
	await loginPage.getByLabel('Password', { exact: true }).fill(fixture.user.password);
	await loginPage.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(loginPage).toHaveURL(/\/recipes$/);
	const storageState = await loginContext.storageState();
	await loginContext.close();

	context = await browser.newContext({
		baseURL: base.origin,
		viewport,
		deviceScaleFactor: NATIVE_CAPTURE_SCALE,
		isMobile: true,
		hasTouch: true,
		locale: 'en-US',
		timezoneId: 'America/Chicago',
		colorScheme: 'light',
		storageState
	});
	// The recorded browser only talks to the local app, never third-party sites.
	await context.route('**/*', (route) => {
		const url = new URL(route.request().url());
		return url.origin === base.origin || ['data:', 'blob:'].includes(url.protocol)
			? route.continue()
			: route.abort();
	});
	await context.addInitScript(() => {
		localStorage.setItem('my-kitchen:chat-read-aloud', '0');
		localStorage.setItem('my-kitchen:cook-view', JSON.stringify({ mode: 'slides', textStep: 0 }));
		// A brief, theme-colored touch pulse; no content, captions or interface replacements.
		document.addEventListener('pointerdown', (event) => {
			const pulse = document.createElement('span');
			pulse.setAttribute('aria-hidden', 'true');
			Object.assign(pulse.style, {
				position: 'fixed',
				left: `${event.clientX}px`,
				top: `${event.clientY}px`,
				width: 'calc(var(--spacing) * 4)',
				height: 'calc(var(--spacing) * 4)',
				margin: 'calc(var(--spacing) * -2)',
				borderRadius: '50%',
				background: 'var(--color-leaf)',
				pointerEvents: 'none',
				zIndex: '2147483647'
			});
			// Place inside an open modal when present so the pulse stays in the top layer.
			(document.querySelector('dialog[open]') ?? document.body).appendChild(pulse);
			const animation = pulse.animate(
				[
					{ transform: 'scale(.6)', opacity: 0.25 },
					{ transform: 'scale(1.6)', opacity: 0 }
				],
				{ duration: 360, easing: 'ease-out' }
			);
			animation.finished.then(() => pulse.remove());
		});
	});
	recordingStarted = performance.now();
	page = await context.newPage();
	page.on('pageerror', (error) => mark('pageerror', error.message));
	page.on('framenavigated', (frame) => {
		if (frame === page.mainFrame()) mark('navigation', new URL(frame.url()).pathname);
	});
	recording = await startNativeRecording(page, viewport);
	timeline.captureClock =
		'First CDP frame epoch, synchronized to the renderer clock; zero manual offset';
	page.setDefaultTimeout(15_000);
	await page.goto('/plan');
	await expect(page.getByRole('heading', { name: 'This week', exact: true })).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
	await smoothScroll(page.locator('html'), { top: 0 });
	await pause(500);

	begin('plan');
	await screenshot('01-weekly-plan');
	await pause(2000);
	const today = page.locator('section').filter({ has: page.getByText('Today', { exact: true }) });
	await smoothScroll(today, { anchor: 170 });
	await expect(today.getByRole('link', { name: new RegExp(recipeTitle, 'i') })).toBeVisible();
	await screenshot('02-todays-dinner');
	mark('shot', 'todaySettled');
	await pause(1600);
	end();

	begin('recipe');
	await tap(today.getByRole('link', { name: new RegExp(recipeTitle, 'i') }), 'Open today’s dinner');
	await expect(page).toHaveURL(new RegExp(`${recipePath}$`));
	await cut('Settle recipe navigation before the photo', async () => {
		await smoothScroll(page.locator('html'), { top: 0 });
	});
	await expect(page.getByRole('heading', { name: recipeTitle, exact: true })).toBeVisible();
	if (fixture.recipePhoto) {
		const heroPhoto = page.getByRole('img', { name: recipeTitle, exact: true });
		await expect(heroPhoto).toBeVisible();
		await heroPhoto.evaluate((image) => image.decode());
		await screenshot('02b-recipe-photo');
	}
	mark('shot', 'photoSettled');
	await pause(2500);
	const butter = page.locator('li').filter({ hasText: /30 g butter/i });
	await smoothScroll(butter, { anchor: 130 });
	await expect(butter).toContainText('Not in pantry');
	await screenshot('03-butter-missing');
	mark('shot', 'missingSettled');
	await pause(2400);
	end();

	begin('grocery');
	await tap(
		page
			.getByRole('navigation', { name: 'Main' })
			.getByRole('link', { name: 'Grocery', exact: true }),
		'Open grocery list',
		{ scroll: false }
	);
	await expect(page).toHaveURL(new RegExp(`/grocery/${fixture.groceryListId}$`));
	await tap(
		page.getByRole('button', { name: 'Add item', exact: true }).first(),
		'Add a grocery item'
	);
	const addSheet = page.getByRole('dialog', { name: 'Add an item', exact: true });
	await type(addSheet.getByLabel('Item', { exact: true }), 'butter', 'Type butter');
	await tap(addSheet.getByRole('option', { name: /^butter\b/i }).first(), 'Choose butter');
	await cut('Shorten the routine grocery quantity entry', async () => {
		await addSheet.getByLabel('Amount', { exact: false }).fill('250');
		mark('tap', 'Choose grams');
		await addSheet.getByLabel('Unit', { exact: true }).selectOption('g');
		await expect(addSheet.getByLabel('Amount', { exact: false })).toHaveValue('250');
		await expect(addSheet.getByLabel('Unit', { exact: true })).toHaveValue('g');
	});
	await expect(
		addSheet.getByRole('checkbox', { name: /Subtract what the pantry already has/ })
	).not.toBeChecked();
	await pause(400);
	await tap(
		addSheet.getByRole('button', { name: 'Add to list', exact: true }),
		'Save butter for the next shop'
	);
	await expect(addSheet).not.toBeVisible();
	await expect(
		page
			.getByRole('listitem')
			.filter({ hasText: /butter.*manual/ })
			.first()
	).toContainText('250 g');
	await screenshot('04-butter-on-grocery-list');
	mark('shot', 'groceryProof');
	await pause(2300);
	end();

	begin('ask');
	const cookLink = page.getByRole('link', { name: 'Cook this', exact: true }).first();
	await cut('Return to the recipe without dwelling on its controls', async () => {
		mark('tap', 'Return to the recipe');
		await page.goBack();
		await expect(page).toHaveURL(new RegExp(`${recipePath}$`));
		await smoothScroll(cookLink, { ifNeeded: true });
	});
	await tap(page.getByRole('link', { name: 'Cook this', exact: true }).first(), 'Start cooking');
	await expect(page).toHaveURL(new RegExp(`${recipePath}/cook`));
	await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
	await pause(400);
	await tap(page.getByRole('button', { name: 'Ask', exact: true }), 'Ask about a substitution', {
		scroll: false
	});
	const chatSheet = page.getByRole('dialog', { name: 'Ask the assistant', exact: true });
	mark('shot', 'questionStart');
	await type(chatSheet.getByLabel('Your question'), question, 'Ask whether olive oil will work');
	await pause(500);
	await tap(chatSheet.getByRole('button', { name: 'Send', exact: true }), 'Send the question');
	mark('shot', 'questionSent');
	const waitStart = now();
	const conversation = chatSheet.getByRole('log', { name: 'Conversation with the assistant' });
	await expect(conversation.locator('p').filter({ hasText: /^Assistant:/ })).toBeVisible({
		timeout: 180_000
	});
	const answerAt = now();
	if (answerAt - waitStart > 1.2) {
		timeline.cuts.push({
			start: waitStart + 0.7,
			end: answerAt,
			reason: 'Local model response wait; answer remains genuine and unchanged.'
		});
	}
	timeline.assistant.answer = (
		await conversation
			.locator('p')
			.filter({ hasText: /^Assistant:/ })
			.innerText()
	).replace(/^Assistant:\s*/, '');
	mark('answer', 'Genuine local assistant answer received');
	await smoothScroll(conversation, { top: 0, self: true });
	await screenshot('05-genuine-assistant-answer');
	mark('shot', 'answerReadable');
	await pause(8000);
	end();

	begin('cook');
	if (await chatSheet.isVisible()) {
		await tap(chatSheet.getByRole('button', { name: 'Close', exact: true }), 'Return to cooking');
	}
	const nextStep = page.getByRole('button', { name: 'Next step', exact: true });
	while (await nextStep.count()) {
		await tap(nextStep, 'Continue to the next cooking step');
		await pause(850);
	}
	await screenshot('06-final-cooking-step');
	mark('shot', 'finalStep');
	await pause(600);
	await tap(page.getByRole('button', { name: 'Finish', exact: true }), 'Finish cooking');
	const finishSheet = page.getByRole('dialog', {
		name: `Finish cooking ${recipeTitle}`,
		exact: true
	});
	const butterRow = finishSheet
		.locator('li')
		.filter({ has: page.locator(`input[name="item.${fixture.butterPosition ?? 0}.name"]`) });
	await tap(butterRow.locator('summary'), 'Record what was actually used');
	await type(
		butterRow.getByLabel('Used a different ingredient'),
		'olive oil',
		'Choose olive oil instead'
	);
	await tap(butterRow.getByRole('option', { name: /^olive oil\b/i }).first(), 'Select olive oil');
	await tap(
		butterRow.getByRole('button', { name: 'Use its pantry lots', exact: true }),
		'Use the olive oil in the pantry'
	);
	const amount = butterRow.getByRole('textbox', {
		name: 'Amount to deduct from this lot',
		exact: true
	});
	await expect(amount).toBeVisible();
	await expect(
		butterRow.locator(`input[name="item.${fixture.butterPosition ?? 0}.ingredientId"]`)
	).toHaveValue(oliveOilId);
	// A weighed amount chosen by the cook; it is not a fabricated model quotation.
	const recommendedGrams = timeline.assistant.answer.match(
		/\b(?:start with|use|about|roughly|approximately)\s+(\d+(?:\.\d+)?)\s*(?:g|grams?)\b/i
	)?.[1];
	const sameAmount = /\bsame amount\b/i.test(timeline.assistant.answer)
		? (await butterRow.innerText()).match(/^(\d+(?:\.\d+)?)\s*g\s*butter/i)?.[1]
		: undefined;
	const substituteAmount = String(
		fixture.substituteAmount ?? recommendedGrams ?? sameAmount ?? '22'
	);
	await tap(amount, 'Enter the olive oil actually used');
	if ((await amount.inputValue()) !== substituteAmount) await amount.fill(substituteAmount);
	mark('type', `Record ${substituteAmount} g olive oil`, { characters: substituteAmount.length });
	timeline.verification.substituteAmount = substituteAmount;
	timeline.verification.substituteIngredientId = oliveOilId;
	await screenshot('07-olive-oil-substitution');
	mark('shot', 'substitutionReviewed');
	await pause(2100);
	timeline.verification.finishForm = await finishSheet
		.locator('form')
		.evaluate((form) => Object.fromEntries(new FormData(form).entries()));
	const requestCapture = page.waitForRequest(
		(request) => request.method() === 'POST' && request.url().includes('?/finish')
	);
	await cut('Shorten the repeated ingredient rows before confirmation', async () => {
		await smoothScroll(
			finishSheet.getByRole('button', { name: 'Deduct from pantry', exact: true }),
			{ ifNeeded: true }
		);
	});
	await tap(
		finishSheet.getByRole('button', { name: 'Deduct from pantry', exact: true }),
		'Confirm the pantry update'
	);
	mark('shot', 'confirmTap');
	await requestCapture;
	await expect(finishSheet).not.toBeVisible();
	await cut('Move directly from confirmation to the real success state', async () => {
		await smoothScroll(page.locator('html'), { top: 0 });
		await expect(page.getByRole('status').filter({ hasText: 'Pantry updated:' })).toBeVisible();
	});
	end();

	begin('success');
	await screenshot('08-cooking-complete');
	mark('shot', 'successReadable');
	await pause(4000);
	end();
	// Read-only verification after the story, outside the kept video segments.
	await page.goto(`/grocery/${fixture.groceryListId}`);
	await expect(
		page
			.getByRole('listitem')
			.filter({ hasText: /butter.*manual/ })
			.first()
	).toContainText('250 g');
	timeline.verification.butterRemainsOnGroceryList = true;
	await screenshot('09-butter-still-on-list');
	timeline.status = 'complete';
} catch (error) {
	timeline.status = 'failed';
	timeline.error = error instanceof Error ? error.message : String(error);
	if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
	throw error;
} finally {
	if (activeSegment) end();
	if (recording) await recording.stop();
	if (context) await context.close();
	await browser.close();
	if (recording) {
		const native = await recording.save(outputDir);
		timeline.rawPath = native.rawPath;
		timeline.capture = native;
	}
	for (const { name, buffer } of screenshots) {
		await writeFile(path.join(imagesDir, `${name}.png`), buffer);
	}
	if (timeline.assistant.answer) {
		await writeFile(
			path.join(outputDir, 'assistant-answer.txt'),
			`${question}\n\n${timeline.assistant.answer}\n`
		);
	}
	await writeFile(path.join(outputDir, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`);
}
