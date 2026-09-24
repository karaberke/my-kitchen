import { browser } from '$app/environment';

export type CookMode = 'list' | 'slides';

export const COOK_MODES: readonly { value: CookMode; label: string }[] = [
	{ value: 'list', label: 'All steps' },
	{ value: 'slides', label: 'Step by step' }
];

export const COOK_TEXT_STEP_MIN = -2;
export const COOK_TEXT_STEP_MAX = 4;
/** Each step changes the reading text by this fraction of its base size. */
const COOK_TEXT_STEP_SIZE = 0.15;

const BASE_PX = { ingredient: 15, step: 17, slide: 21 } as const;

const KEY = 'my-kitchen:cook-view';

export function clampCookTextStep(step: number): number {
	if (!Number.isFinite(step)) return 0;
	return Math.min(COOK_TEXT_STEP_MAX, Math.max(COOK_TEXT_STEP_MIN, Math.round(step)));
}

/** Pixel sizes for the cooking view's reading text at a given text-size step. */
export function cookTextSizes(step: number) {
	const scale = 1 + clampCookTextStep(step) * COOK_TEXT_STEP_SIZE;
	return {
		ingredient: `${Math.round(BASE_PX.ingredient * scale)}px`,
		step: `${Math.round(BASE_PX.step * scale)}px`,
		slide: `${Math.round(BASE_PX.slide * scale)}px`,
		percent: `${Math.round(scale * 100)}%`
	};
}

interface CookView {
	mode: CookMode;
	textStep: number;
}

function load(): CookView {
	const fallback: CookView = { mode: 'list', textStep: 0 };
	if (!browser) return fallback;
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CookView> | null;
		return {
			mode: raw?.mode === 'slides' ? 'slides' : 'list',
			textStep: clampCookTextStep(Number(raw?.textStep ?? 0))
		};
	} catch {
		// Private mode, blocked storage or a corrupt value: start from the defaults.
		return fallback;
	}
}

/**
 * How the reader likes to cook: all steps at once or one at a time, and how
 * large the text is. Remembered in this browser only; never sent to the server.
 */
export const cookView = $state<CookView>(load());

export function setCookView(next: Partial<CookView>) {
	if (next.mode) cookView.mode = next.mode;
	if (next.textStep !== undefined) cookView.textStep = clampCookTextStep(next.textStep);
	if (!browser) return;
	try {
		localStorage.setItem(KEY, JSON.stringify(cookView));
	} catch {
		// Preference simply does not persist; the session still works.
	}
}
