import { describe, expect, it } from 'vitest';
import {
	COOK_TEXT_STEP_MAX,
	COOK_TEXT_STEP_MIN,
	clampCookTextStep,
	cookTextSizes
} from './cook-view.svelte';

describe('cookTextSizes', () => {
	it('uses the base sizes at step zero', () => {
		expect(cookTextSizes(0)).toEqual({
			ingredient: '15px',
			step: '17px',
			slide: '21px',
			percent: '100%'
		});
	});

	it('grows and shrinks by 15 % per step', () => {
		expect(cookTextSizes(2)).toEqual({
			ingredient: '20px',
			step: '22px',
			slide: '27px',
			percent: '130%'
		});
		expect(cookTextSizes(-1).percent).toBe('85%');
	});

	it('stays inside the allowed range', () => {
		expect(cookTextSizes(99)).toEqual(cookTextSizes(COOK_TEXT_STEP_MAX));
		expect(cookTextSizes(-99)).toEqual(cookTextSizes(COOK_TEXT_STEP_MIN));
	});
});

describe('clampCookTextStep', () => {
	it('rounds and clamps stored values', () => {
		expect(clampCookTextStep(1.6)).toBe(2);
		expect(clampCookTextStep(COOK_TEXT_STEP_MAX + 3)).toBe(COOK_TEXT_STEP_MAX);
		expect(clampCookTextStep(Number.NaN)).toBe(0);
	});
});
