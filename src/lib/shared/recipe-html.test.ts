import { describe, expect, it } from 'vitest';
import { importRecipeHtml, isoDurationToMinutes, splitIngredientLine } from './recipe-html';

const wrap = (jsonld: unknown, body = '') =>
	`<!DOCTYPE html><html><head><title>Page title</title>
	<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
	</head><body>${body}</body></html>`;

const RECIPE = {
	'@context': 'https://schema.org',
	'@type': 'Recipe',
	name: 'Red lentil dal',
	description: 'Weeknight dal.',
	recipeYield: '4 servings',
	prepTime: 'PT15M',
	cookTime: 'PT1H30M',
	recipeIngredient: ['200 g red lentils', '1 tbsp olive oil', 'salt'],
	recipeInstructions: ['Rinse the lentils.', 'Simmer for 30 minutes.']
};

describe('isoDurationToMinutes', () => {
	it('reads hours and minutes', () => {
		expect(isoDurationToMinutes('PT30M')).toBe(30);
		expect(isoDurationToMinutes('PT1H')).toBe(60);
		expect(isoDurationToMinutes('PT1H30M')).toBe(90);
		expect(isoDurationToMinutes('PT2H5M')).toBe(125);
	});

	it('ignores anything it cannot read', () => {
		expect(isoDurationToMinutes('')).toBeNull();
		expect(isoDurationToMinutes('half an hour')).toBeNull();
		expect(isoDurationToMinutes(undefined)).toBeNull();
	});
});

describe('importRecipeHtml with JSON-LD', () => {
	it('pulls title, description, times, servings, ingredients and steps', () => {
		const r = importRecipeHtml(wrap(RECIPE));
		expect(r.source).toBe('json-ld');
		expect(r.input.title).toBe('Red lentil dal');
		expect(r.input.description).toBe('Weeknight dal.');
		expect(r.input.prepMinutes).toBe('15');
		expect(r.input.cookMinutes).toBe('90');
		expect(r.input.baseServings).toBe('4');
		// Ingredient lines are split so imported recipes scale like hand-entered ones.
		expect(r.input.ingredients.map((i) => [i.amount, i.unit, i.name])).toEqual([
			['200', 'g', 'red lentils'],
			['1', 'tbsp', 'olive oil'],
			['', '', 'salt']
		]);
		// The source's exact wording is kept alongside the split.
		expect(r.input.ingredients[0].preparation).toBe('200 g red lentils');
		expect(r.input.ingredients[2].preparation).toBe('');
		expect(r.input.steps.map((s) => s.text)).toEqual([
			'Rinse the lentils.',
			'Simmer for 30 minutes.'
		]);
	});

	it('finds the recipe inside an @graph', () => {
		const r = importRecipeHtml(
			wrap({ '@context': 'x', '@graph': [{ '@type': 'WebSite' }, RECIPE] })
		);
		expect(r.source).toBe('json-ld');
		expect(r.input.title).toBe('Red lentil dal');
	});

	it('finds the recipe inside a top-level array', () => {
		const r = importRecipeHtml(wrap([{ '@type': 'Organization' }, RECIPE]));
		expect(r.input.title).toBe('Red lentil dal');
	});

	it('accepts @type given as an array', () => {
		const r = importRecipeHtml(wrap({ ...RECIPE, '@type': ['Recipe', 'NewsArticle'] }));
		expect(r.input.title).toBe('Red lentil dal');
	});

	it('reads HowToStep and HowToSection instructions', () => {
		const r = importRecipeHtml(
			wrap({
				...RECIPE,
				recipeInstructions: [
					{ '@type': 'HowToStep', text: 'Rinse well.' },
					{
						'@type': 'HowToSection',
						name: 'To finish',
						itemListElement: [
							{ '@type': 'HowToStep', text: 'Simmer.' },
							{ '@type': 'HowToStep', text: 'Season.' }
						]
					}
				]
			})
		);
		expect(r.input.steps.map((s) => s.text)).toEqual(['Rinse well.', 'Simmer.', 'Season.']);
		// The section name carries through onto its own steps.
		expect(r.input.steps.map((s) => s.section)).toEqual(['', 'To finish', 'To finish']);
	});

	it('reads instructions given as one HTML blob', () => {
		const r = importRecipeHtml(
			wrap({ ...RECIPE, recipeInstructions: '<p>Rinse well.</p><p>Simmer gently.</p>' })
		);
		expect(r.input.steps.map((s) => s.text)).toEqual(['Rinse well.', 'Simmer gently.']);
	});

	it('reads servings from a number, an array, and a bare count', () => {
		expect(importRecipeHtml(wrap({ ...RECIPE, recipeYield: 6 })).input.baseServings).toBe('6');
		expect(
			importRecipeHtml(wrap({ ...RECIPE, recipeYield: ['8 servings'] })).input.baseServings
		).toBe('8');
		expect(importRecipeHtml(wrap({ ...RECIPE, recipeYield: '12' })).input.baseServings).toBe('12');
	});

	it('keeps a non-numeric yield as a note rather than inventing servings', () => {
		const r = importRecipeHtml(wrap({ ...RECIPE, recipeYield: 'one loaf' }));
		expect(r.input.baseServings).toBe('');
		expect(r.input.yieldNote).toBe('one loaf');
	});

	it('decodes HTML entities in extracted text', () => {
		const r = importRecipeHtml(
			wrap({
				...RECIPE,
				name: 'Mac &amp; cheese',
				recipeIngredient: ['200 g cheese &mdash; grated']
			})
		);
		expect(r.input.title).toBe('Mac & cheese');
		expect(r.input.ingredients[0].name).toBe('cheese — grated');
		expect(r.input.ingredients[0].amount).toBe('200');
	});
});

describe('importRecipeHtml without JSON-LD', () => {
	it('falls back to readable text and takes a title from the document', () => {
		const r = importRecipeHtml(
			'<html><head><title>Grandma&#39;s stew</title></head><body><h1>Stew</h1><p>Very good.</p></body></html>'
		);
		expect(r.source).toBe('text');
		expect(r.input.title).toBe("Grandma's stew");
		expect(r.input.notes).toContain('Very good.');
		expect(r.input.ingredients).toEqual([]);
	});

	it('prefers an h1 when there is no document title', () => {
		const r = importRecipeHtml('<body><h1>Stew</h1><p>Good.</p></body>');
		expect(r.input.title).toBe('Stew');
	});

	it('never lets script or style content into the text', () => {
		const r = importRecipeHtml(
			`<body><script>alert('xss')</script><style>.a{color:red}</style><p>Real text.</p></body>`
		);
		expect(r.input.notes).toContain('Real text.');
		expect(r.input.notes).not.toContain('alert');
		expect(r.input.notes).not.toContain('color:red');
	});

	it('survives malformed JSON-LD instead of throwing', () => {
		const r = importRecipeHtml(
			`<html><script type="application/ld+json">{ not json )</script><body><p>Fallback.</p></body></html>`
		);
		expect(r.source).toBe('text');
		expect(r.input.notes).toContain('Fallback.');
	});

	it('ignores JSON-LD that has no recipe in it', () => {
		const r = importRecipeHtml(wrap({ '@type': 'BlogPosting', headline: 'Nope' }, '<p>Body.</p>'));
		expect(r.source).toBe('text');
	});

	it('returns an empty import for empty input rather than throwing', () => {
		const r = importRecipeHtml('');
		expect(r.input.title).toBe('');
		expect(r.input.ingredients).toEqual([]);
	});
});

describe('splitIngredientLine', () => {
	const split = (s: string) => {
		const r = splitIngredientLine(s);
		return [r.amount, r.unit, r.name];
	};

	it('splits a plain metric quantity', () => {
		expect(split('200 g red lentils')).toEqual(['200', 'g', 'red lentils']);
		expect(split('1 tbsp olive oil')).toEqual(['1', 'tbsp', 'olive oil']);
	});

	it('handles a missing space between amount and unit', () => {
		expect(split('200g red lentils')).toEqual(['200', 'g', 'red lentils']);
	});

	it('reads fractions and mixed numbers', () => {
		expect(split('½ tsp cumin')).toEqual(['0.5', 'tsp', 'cumin']);
		expect(split('1 1/2 cups flour')).toEqual(['1.5', 'cup', 'flour']);
		expect(split('1½ cups flour')).toEqual(['1.5', 'cup', 'flour']);
	});

	it('normalises unit spellings', () => {
		expect(split('2 tablespoons butter')).toEqual(['2', 'tbsp', 'butter']);
		expect(split('3 cloves garlic')).toEqual(['3', 'clove', 'garlic']);
	});

	it('drops a connecting "of"', () => {
		expect(split('1 cup of milk')).toEqual(['1', 'cup', 'milk']);
	});

	it('leaves the amount alone when the next word is not a unit', () => {
		expect(split('2 large eggs')).toEqual(['2', '', 'large eggs']);
	});

	it('keeps an unquantified ingredient as just a name', () => {
		expect(split('salt')).toEqual(['', '', 'salt']);
		expect(split('freshly ground black pepper')).toEqual(['', '', 'freshly ground black pepper']);
	});

	it('takes the low end of a range so the amount stays usable', () => {
		expect(split('2-3 tbsp water')).toEqual(['2', 'tbsp', 'water']);
	});

	it('always keeps the original wording', () => {
		expect(splitIngredientLine('200 g red lentils').original).toBe('200 g red lentils');
		expect(splitIngredientLine('  salt  ').original).toBe('salt');
	});

	it('does not choke on an empty line', () => {
		expect(split('')).toEqual(['', '', '']);
	});
});

describe('importRecipeHtml title and notes on an unstructured page', () => {
	it('prefers the recipe block’s own name over the page title', () => {
		const r = importRecipeHtml(
			`<html><head><title>Taiwanese Fried Chicken - The Woks of Life</title></head>
			<body><h2 class="wprm-recipe-name wprm-block-text-bold">Taiwanese Fried Chicken</h2></body></html>`
		);
		expect(r.input.title).toBe('Taiwanese Fried Chicken');
	});

	it('falls back to the page title when the page names no recipe', () => {
		const r = importRecipeHtml(
			'<html><head><title>Nan&#39;s stew</title></head><body><p>Hi.</p></body></html>'
		);
		expect(r.input.title).toBe("Nan's stew");
	});

	it('keeps short readable text in notes', () => {
		const r = importRecipeHtml('<body><h1>Stew</h1><p>Brown the beef, then simmer.</p></body>');
		expect(r.input.notes).toContain('Brown the beef');
	});

	it('does not dump a whole website into notes', () => {
		// A page that is mostly navigation and furniture, as saved blog pages are.
		const filler = '<p>Some navigation and boilerplate text.</p>'.repeat(200);
		const r = importRecipeHtml(
			`<html><head><title>Big page</title></head><body>${filler}</body></html>`
		);
		expect(r.source).toBe('text');
		// Nothing useful to keep: the original file is the better reference.
		expect(r.input.notes).toBe('');
	});
});

describe('character references', () => {
	const parse = (body: string) => importRecipeHtml(`<html><body>${body}</body></html>`);

	it('leaves an out-of-range numeric reference as literal text', () => {
		// String.fromCodePoint throws above 0x10FFFF, which used to 500 the import.
		for (const bad of ['&#1114112;', '&#99999999999;', '&#x110000;', '&#55357;', '&#0;']) {
			const { input } = parse(`<h1>Cake ${bad}</h1><ul><li>200 g flour</li></ul>`);
			expect(input.title).toContain(bad);
		}
	});

	it('still decodes valid references, including astral ones', () => {
		expect(parse('<h1>Caf&#233; tart</h1>').input.title).toBe('Café tart');
		expect(parse('<h1>Cake &#x1F370; tart</h1>').input.title).toBe('Cake 🍰 tart');
		expect(parse('<h1>Salt &amp; pepper</h1>').input.title).toBe('Salt & pepper');
	});
});

describe('importRecipeHtml: the picture', () => {
	const meta = (property: string, content: string) =>
		`<!DOCTYPE html><html><head><meta property="${property}" content="${content}"></head><body></body></html>`;

	it('takes the og:image of the page', () => {
		const { input } = importRecipeHtml(meta('og:image', 'https://example.com/dal.jpg'));
		expect(input.imageUrl).toBe('https://example.com/dal.jpg');
	});

	it('takes twitter:image when there is no og:image', () => {
		const html = `<html><head><meta name="twitter:image" content="https://example.com/t.jpg"></head></html>`;
		expect(importRecipeHtml(html).input.imageUrl).toBe('https://example.com/t.jpg');
	});

	it('prefers the picture of the recipe itself over the one of the page', () => {
		const html = wrap({ ...RECIPE, image: 'https://example.com/recipe.jpg' }).replace(
			'</head>',
			'<meta property="og:image" content="https://example.com/page.jpg"></head>'
		);
		expect(importRecipeHtml(html).input.imageUrl).toBe('https://example.com/recipe.jpg');
	});

	it('takes the first picture when the recipe lists several', () => {
		const html = wrap({
			...RECIPE,
			image: ['https://example.com/a.jpg', 'https://example.com/b.jpg']
		});
		expect(importRecipeHtml(html).input.imageUrl).toBe('https://example.com/a.jpg');
	});

	it('reads the address out of an ImageObject', () => {
		const html = wrap({
			...RECIPE,
			image: { '@type': 'ImageObject', url: 'https://example.com/object.jpg' }
		});
		expect(importRecipeHtml(html).input.imageUrl).toBe('https://example.com/object.jpg');
	});

	it('makes a relative address absolute against the page', () => {
		const { input } = importRecipeHtml(
			meta('og:image', '/img/dal.jpg'),
			'https://example.com/recipes/dal'
		);
		expect(input.imageUrl).toBe('https://example.com/img/dal.jpg');
	});

	it('drops a relative address when the page address is unknown', () => {
		expect(importRecipeHtml(meta('og:image', '/img/dal.jpg')).input.imageUrl).toBe('');
	});

	it('ignores an address that is not http or https', () => {
		expect(importRecipeHtml(meta('og:image', 'data:image/gif;base64,AAAA')).input.imageUrl).toBe(
			''
		);
	});

	it('leaves the field empty when the page names no picture', () => {
		expect(importRecipeHtml(wrap(RECIPE)).input.imageUrl).toBe('');
	});
});
