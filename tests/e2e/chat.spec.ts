import { expect, test, type Page } from '@playwright/test';
import { startChatStub } from '../helpers/chat-stub';
import { createRecipe, register } from './helpers';

interface SpeechState {
	started: number;
	aborted: number;
	stopped: number;
	cancellations: number;
	spoken: string[];
	speaking: boolean;
	lateResult: (() => void) | null;
}

let stub: Awaited<ReturnType<typeof startChatStub>>;

test.beforeAll(async () => {
	stub = await startChatStub();
});

test.afterAll(async () => {
	await stub.close();
});

/** Browser speech stays fake; assistant requests reach only the gated loopback fixture. */
async function fakeSpeech(page: Page) {
	await page.addInitScript(() => {
		const state: SpeechState = {
			started: 0,
			aborted: 0,
			stopped: 0,
			cancellations: 0,
			spoken: [],
			speaking: false,
			lateResult: null
		};
		const resultEvent = () => ({
			results: [{ isFinal: false, 0: { transcript: 'dictated extra' } }]
		});
		class Recognition {
			onresult: ((event: ReturnType<typeof resultEvent>) => void) | null = null;
			onerror: ((event: { error: string }) => void) | null = null;
			onend: (() => void) | null = null;
			start() {
				state.started++;
				const onresult = this.onresult;
				const onend = this.onend;
				state.lateResult = () => {
					onresult?.(resultEvent());
					onend?.();
				};
			}
			stop() {
				state.stopped++;
				this.onresult?.(resultEvent());
				this.onend?.();
			}
			abort() {
				state.aborted++;
				this.onend?.();
			}
		}
		Object.defineProperties(window, {
			__speech: { configurable: true, value: state },
			SpeechRecognition: { configurable: true, value: Recognition },
			speechSynthesis: {
				configurable: true,
				value: {
					getVoices: () => [],
					speak(utterance: { text: string }) {
						state.spoken.push(utterance.text);
						state.speaking = !!utterance.text.trim();
					},
					cancel() {
						state.cancellations++;
						state.speaking = false;
					}
				}
			}
		});
	});
}

async function speechStats(page: Page) {
	return page.evaluate(() => {
		const state = (window as unknown as { __speech: SpeechState }).__speech;
		return {
			started: state.started,
			aborted: state.aborted,
			stopped: state.stopped,
			cancellations: state.cancellations,
			speaking: state.speaking,
			spoken: state.spoken.filter((text) => text.trim())
		};
	});
}

test('closing cooking chat cancels speech immediately, finishes pending answers silently and preserves drafts', async ({
	page
}) => {
	await fakeSpeech(page);
	await register(page, 'ChatLifecycle');
	const recipeId = await createRecipe(page, {
		title: 'Chat lifecycle chicken',
		servings: '2',
		ingredient: { amount: '200', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
		step: 'Bake gently.'
	});
	await page.goto(`/recipes/${recipeId}/cook`);
	const ask = page.getByRole('button', { name: 'Ask', exact: true });
	const dialog = page.getByRole('dialog', { name: 'Ask the assistant' });
	const conversation = dialog.getByRole('log', { name: 'Conversation with the assistant' });
	const input = dialog.getByLabel('Your question');
	await ask.click();
	await input.fill('Keep this draft');
	await dialog.getByRole('button', { name: 'Speak', exact: true }).click();
	await expect(dialog.getByRole('button', { name: 'Listening… tap to stop' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog).not.toBeVisible();
	await expect.poll(async () => (await speechStats(page)).aborted).toBe(1);
	await ask.click();
	await expect(input).toHaveValue('Keep this draft');
	await page.evaluate(() => {
		(window as unknown as { __speech: SpeechState }).__speech.lateResult?.();
	});
	await expect(input).toHaveValue('Keep this draft');

	// The visible stop button still accepts a final transcript rather than cancelling it.
	await dialog.getByRole('button', { name: 'Speak', exact: true }).click();
	await dialog.getByRole('button', { name: 'Listening… tap to stop' }).click();
	await expect(input).toHaveValue('Keep this draft dictated extra');
	expect((await speechStats(page)).stopped).toBe(1);
	expect((await speechStats(page)).aborted).toBe(1);

	await dialog.getByLabel('Read answers aloud').check();
	await input.fill('Can I use thighs instead?');
	await dialog.getByRole('button', { name: 'Send', exact: true }).click();
	await expect.poll(() => stub.requests.length).toBe(1);
	const newerDraft = 'How long should they cook?';
	await input.fill(newerDraft);
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await ask.click();
	await expect(input).toHaveValue(newerDraft);
	await expect(dialog.getByRole('button', { name: 'Thinking…', exact: true })).toBeDisabled();
	expect(stub.requests).toHaveLength(1);
	await page.keyboard.press('Escape');
	const silentAnswer = 'Yes, thighs work in this recipe.';
	await stub.release(silentAnswer);
	await expect
		.poll(() => page.evaluate((key) => sessionStorage.getItem(key), `recipe-chat:${recipeId}`))
		.toContain(silentAnswer);
	expect((await speechStats(page)).spoken).toEqual([]);

	await ask.click();
	await expect(conversation).toBeVisible();
	await expect(conversation).toContainText(silentAnswer);
	await expect(input).toHaveValue(newerDraft);
	await dialog.getByRole('button', { name: 'Send', exact: true }).click();
	await expect.poll(() => stub.requests.length).toBe(2);
	const spokenAnswer = 'Cook until the chicken reaches the proper temperature.';
	await stub.release(spokenAnswer);
	await expect(conversation).toContainText(spokenAnswer);
	await expect.poll(async () => (await speechStats(page)).spoken).toEqual([spokenAnswer]);
	const cancellations = (await speechStats(page)).cancellations;
	await page.keyboard.press('Escape');
	await expect
		.poll(async () => (await speechStats(page)).cancellations)
		.toBeGreaterThan(cancellations);
	expect((await speechStats(page)).speaking).toBe(false);
	await ask.click();
	await expect(conversation).toContainText(silentAnswer);
	await expect(conversation).toContainText(spokenAnswer);
});
