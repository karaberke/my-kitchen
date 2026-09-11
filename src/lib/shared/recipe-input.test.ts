import { describe, expect, it } from 'vitest';
import { parseRecipeForm, validateRecipe, parseTags } from './recipe-input';

function fd(entries: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(entries)) f.set(k, v);
	return f;
}

describe('parseRecipeForm', () => {
	it('collects indexed ingredient and step rows in index order', () => {
		const input = parseRecipeForm(
			fd({
				title: 'Dal',
				'ing.2.name': 'lemon',
				'ing.0.name': 'red lentils',
				'ing.0.amount': '300',
				'ing.0.unit': 'g',
				'step.1.text': 'Simmer',
				'step.0.text': 'Rinse',
				intent: 'save'
			})
		);
		expect(input.ingredients.map((i) => i.name)).toEqual(['red lentils', 'lemon']);
		expect(input.steps.map((s) => s.text)).toEqual(['Rinse', 'Simmer']);
	});

	it('keeps the link to a picture', () => {
		const input = parseRecipeForm(fd({ imageUrl: ' https://example.com/dal.jpg ' }));
		expect(input.imageUrl).toBe('https://example.com/dal.jpg');
	});

	it('has no picture link when the field is absent', () => {
		expect(parseRecipeForm(fd({ title: 'Dal' })).imageUrl).toBe('');
	});
});

describe('validateRecipe', () => {
	const base = () =>
		parseRecipeForm(
			fd({
				title: 'Dal',
				baseServings: '4',
				'ing.0.name': 'red lentils',
				'ing.0.amount': '300',
				'ing.0.unit': 'grams',
				'ing.1.name': 'flaky salt',
				'ing.1.amount': '',
				'step.0.text': 'Simmer 20 minutes',
				intent: 'save',
				tags: 'Weeknight, vegan, weeknight'
			})
		);

	it('accepts a complete recipe and normalises units, tags and unknown amounts', () => {
		const r = validateRecipe(base());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.ingredients[0].unit).toBe('g');
		expect(r.value.ingredients[0].amount?.toString()).toBe('300');
		expect(r.value.ingredients[1].amount).toBeNull();
		expect(r.value.tags).toEqual(['Weeknight', 'vegan']);
		expect(r.value.status).toBe('active');
	});

	it('requires title, servings, an ingredient and a step for a full save but not a draft', () => {
		const empty = parseRecipeForm(fd({ intent: 'save' }));
		const r = validateRecipe(empty);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(Object.keys(r.errors).sort()).toEqual(['baseServings', 'ingredients', 'steps', 'title']);
		const d = validateRecipe(parseRecipeForm(fd({ intent: 'draft' })));
		expect(d.ok).toBe(true);
		if (d.ok) expect(d.value.title).toBe('Untitled draft');
	});

	it('rejects bad amounts and unknown units even in drafts', () => {
		const r = validateRecipe(
			parseRecipeForm(
				fd({ intent: 'draft', 'ing.0.name': 'x', 'ing.0.amount': 'lots', 'ing.0.unit': 'furlong' })
			)
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors['ing.0.amount']).toBeTruthy();
		expect(r.errors['ing.0.unit']).toBe('Unknown unit');
	});

	it('ignores fully blank ingredient rows', () => {
		const r = validateRecipe(
			parseRecipeForm(
				fd({
					...Object.fromEntries([]),
					title: 'T',
					baseServings: '2',
					'ing.0.name': 'a',
					'ing.1.name': '',
					'ing.1.amount': '',
					'step.0.text': 's',
					intent: 'save'
				})
			)
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.ingredients).toHaveLength(1);
	});

	it('parses tags deduplicated and capped', () => {
		expect(parseTags('a, b,, A ,c')).toEqual(['a', 'b', 'c']);
	});
});
