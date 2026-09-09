# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: recipes.spec.ts >> recipes >> registration, draft, full save, edit, duplicate, export, delete
- Location: tests/e2e/recipes.spec.ts:5:2

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 404
Received: 500
```

# Page snapshot

```yaml
- generic [ref=f5e2]:
  - generic [ref=f5e3]:
    - link "Skip to content" [ref=f5e4] [cursor=pointer]:
      - /url: "#main"
    - complementary [ref=f5e5]:
      - link "Pantry & Plate" [ref=f5e6] [cursor=pointer]:
        - /url: /recipes
      - generic "Alice's kitchen" [ref=f5e8]
      - navigation "Main" [ref=f5e9]:
        - link "Recipes" [ref=f5e10] [cursor=pointer]:
          - /url: /recipes
          - generic [aria-hidden] [ref=f5e11]: ❏
        - link "Grocery" [ref=f5e13] [cursor=pointer]:
          - /url: /grocery
          - generic [aria-hidden] [ref=f5e14]: ☑
        - link "Pantry" [ref=f5e16] [cursor=pointer]:
          - /url: /pantry
          - generic [aria-hidden] [ref=f5e17]: ▤
        - link "Household" [ref=f5e19] [cursor=pointer]:
          - /url: /household
          - generic [aria-hidden] [ref=f5e20]: ⌂
        - link "Settings" [ref=f5e22] [cursor=pointer]:
          - /url: /settings
          - generic [aria-hidden] [ref=f5e23]: ⚙
      - generic [ref=f5e26]:
        - generic [ref=f5e27]: A
        - generic [ref=f5e28]:
          - generic [ref=f5e29]: Alice
          - generic [ref=f5e30]: alice-1788936783074-1@example.test
        - button "Sign out" [ref=f5e32]: ⇥
    - main [ref=f5e34]:
      - generic [ref=f5e35]:
        - generic [ref=f5e36]:
          - heading "Recipes" [level=1] [ref=f5e37]
          - generic [ref=f5e38]: 2 recipes · Alice's kitchen
        - generic [ref=f5e39]:
          - link "Export" [ref=f5e40] [cursor=pointer]:
            - /url: /recipes/export.json
          - link "+ Add" [ref=f5e41] [cursor=pointer]:
            - /url: /recipes/new
      - search [ref=f5e42]:
        - generic [aria-hidden] [ref=f5e43]: ⌕
        - generic [ref=f5e44]: Search recipes
        - textbox "Search recipes" [ref=f5e45]:
          - /placeholder: Search recipes by title
      - group "Filters" [ref=f5e46]:
        - link "All" [ref=f5e47] [cursor=pointer]:
          - /url: /recipes
        - link "Favorites" [ref=f5e48] [cursor=pointer]:
          - /url: /recipes?favorites=1
        - link "Mine" [ref=f5e49] [cursor=pointer]:
          - /url: /recipes?scope=mine
        - link "Shared with me" [ref=f5e50] [cursor=pointer]:
          - /url: /recipes?scope=shared
        - link "Drafts" [ref=f5e51] [cursor=pointer]:
          - /url: /recipes?status=draft
        - link "Archived" [ref=f5e52] [cursor=pointer]:
          - /url: /recipes?status=archived
      - generic [ref=f5e53]:
        - article [ref=f5e54]:
          - link "Sheet-pan chicken with lemon (copy)" [ref=f5e55] [cursor=pointer]:
            - /url: /recipes/a649d1df-3dbb-448f-a78d-3fadcef1ed73
          - generic [aria-hidden] [ref=f5e58]: no photo
          - generic [ref=f5e59]:
            - generic [ref=f5e60]:
              - heading "Sheet-pan chicken with lemon (copy)" [level=3] [ref=f5e61]
              - button "Add to favorites" [ref=f5e63]: ☆
            - generic [ref=f5e64]: 4 servings
        - article [ref=f5e65]:
          - link "Half an idea" [ref=f5e66] [cursor=pointer]:
            - /url: /recipes/8a371282-c778-4c1d-87d3-2e1ff1f35c64
          - generic [aria-hidden] [ref=f5e69]: no photo
          - generic [ref=f5e70]:
            - generic [ref=f5e71]:
              - heading "Half an idea" [level=3] [ref=f5e72]
              - button "Add to favorites" [ref=f5e74]: ☆
            - generic [ref=f5e75]: Draft
  - generic [ref=f5e77]: Recipes · Pantry & Plate
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | import { createRecipe, login, register } from './helpers';
  3   | 
  4   | test.describe('recipes', () => {
  5   | 	test('registration, draft, full save, edit, duplicate, export, delete', async ({ page }) => {
  6   | 		await register(page, 'Alice');
  7   | 		// draft with only a title
  8   | 		await page.goto('/recipes/new');
  9   | 		await page.getByLabel('Title').fill('Half an idea');
  10  | 		await page.getByRole('button', { name: 'Save draft' }).click();
  11  | 		await expect(page.getByText('This is a draft')).toBeVisible();
  12  | 		await expect(page.getByRole('link', { name: 'Cook this' })).toHaveAttribute(
  13  | 			'aria-disabled',
  14  | 			'true'
  15  | 		);
  16  | 
  17  | 		// validation preserves input
  18  | 		await page.goto('/recipes/new');
  19  | 		await page.getByLabel('Title').fill('Broken amounts');
  20  | 		await page.locator('#ing-0-amount').fill('lots');
  21  | 		await page.locator('#ing-0-name').fill('salt');
  22  | 		await page.getByRole('button', { name: 'Save recipe' }).click();
  23  | 		await expect(page.getByText('Base servings are needed for scaling')).toBeVisible();
  24  | 		await expect(page.getByLabel('Title')).toHaveValue('Broken amounts');
  25  | 		await expect(page.locator('#ing-0-amount')).toHaveValue('lots');
  26  | 
  27  | 		const id = await createRecipe(page, {
  28  | 			title: 'Sheet-pan chicken',
  29  | 			servings: '4',
  30  | 			ingredient: { amount: '1 1/2', unit: 'kg', name: 'chicken breast', match: 'chicken breast' },
  31  | 			step: 'Roast until done.'
  32  | 		});
  33  | 		await expect(page.getByRole('heading', { name: 'Sheet-pan chicken' })).toBeVisible();
  34  | 		await expect(page.getByText('1.5 kg chicken breast')).toBeVisible();
  35  | 		// scaling changes displayed amount, base untouched after reload
  36  | 		await page.getByRole('button', { name: 'More servings' }).click();
  37  | 		await page.getByRole('button', { name: 'More servings' }).click();
  38  | 		await expect(page.getByText('2.25 kg chicken breast')).toBeVisible();
  39  | 		await page.reload();
  40  | 		await expect(page.getByText('1.5 kg chicken breast')).toBeVisible();
  41  | 
  42  | 		// edit
  43  | 		await page.getByRole('link', { name: 'Edit' }).click();
  44  | 		await page.getByLabel('Title').fill('Sheet-pan chicken with lemon');
  45  | 		await page.getByRole('button', { name: 'Save changes' }).click();
  46  | 		await expect(page.getByRole('heading', { name: 'Sheet-pan chicken with lemon' })).toBeVisible();
  47  | 
  48  | 		// export JSON
  49  | 		const res = await page.request.get(`/recipes/${id}/export.json`);
  50  | 		expect(res.status()).toBe(200);
  51  | 		expect(res.headers()['cache-control']).toContain('no-store');
  52  | 		const json = await res.json();
  53  | 		expect(json.schemaVersion).toBe(1);
  54  | 		expect(json.recipes[0].ingredients[0].amount).toBe('1.5');
  55  | 
  56  | 		// duplicate lands in edit of the copy
  57  | 		await page.getByRole('button', { name: 'Duplicate' }).click();
  58  | 		await expect(page).toHaveURL(/\/edit$/);
  59  | 		await expect(page.getByLabel('Title')).toHaveValue('Sheet-pan chicken with lemon (copy)');
  60  | 
  61  | 		// delete original
  62  | 		await page.goto(`/recipes/${id}`);
  63  | 		await page.getByRole('button', { name: 'Delete' }).click();
  64  | 		await page.getByRole('button', { name: 'Delete recipe' }).click();
  65  | 		await expect(page).toHaveURL(/\/recipes$/);
  66  | 		const gone = await page.request.get(`/recipes/${id}/export.json`);
> 67  | 		expect(gone.status()).toBe(404);
      |                         ^ Error: expect(received).toBe(expected) // Object.is equality
  68  | 	});
  69  | 
  70  | 	test('a private recipe is denied to another user until shared, then visible via household', async ({
  71  | 		browser
  72  | 	}) => {
  73  | 		const ctxA = await browser.newContext();
  74  | 		const ctxB = await browser.newContext();
  75  | 		const a = await ctxA.newPage();
  76  | 		const b = await ctxB.newPage();
  77  | 		await register(a, 'Alice');
  78  | 		const bob = await register(b, 'Bob');
  79  | 		const id = await createRecipe(a, {
  80  | 			title: 'Alice private dal',
  81  | 			servings: '4',
  82  | 			ingredient: { amount: '300', unit: 'g', name: 'red lentils', match: 'red lentils' },
  83  | 			step: 'Simmer.'
  84  | 		});
  85  | 		await b.goto(`/recipes/${id}`);
  86  | 		await expect(b.getByText('Nothing here')).toBeVisible();
  87  | 		expect((await b.request.get(`/recipes/${id}/export.json`)).status()).toBe(404);
  88  | 
  89  | 		// invite Bob
  90  | 		await a.goto('/household');
  91  | 		await a.getByRole('button', { name: 'Create invitation link' }).click();
  92  | 		const link = await a.getByLabel('Invitation link').inputValue();
  93  | 		await b.goto(link);
  94  | 		await b.getByRole('button', { name: /Join/ }).click();
  95  | 		await expect(b).toHaveURL(/\/household/);
  96  | 		await expect(b.getByText('Bob (you)')).toBeVisible();
  97  | 
  98  | 		// share
  99  | 		await a.goto(`/recipes/${id}`);
  100 | 		await a.getByRole('button', { name: 'Share…' }).click();
  101 | 		await a.getByRole('button', { name: 'Share', exact: true }).click();
  102 | 		await b.goto(`/recipes/${id}`);
  103 | 		await expect(b.getByRole('heading', { name: 'Alice private dal' })).toBeVisible();
  104 | 		await expect(b.getByRole('link', { name: 'Edit' })).toHaveCount(0);
  105 | 		expect((await b.request.get(`/recipes/${id}/edit`)).status()).toBe(403);
  106 | 
  107 | 		// remove Bob from the household: access ends immediately
  108 | 		await a.goto('/household');
  109 | 		a.once('dialog', (d) => d.accept());
  110 | 		await a.getByRole('button', { name: 'Remove' }).click();
  111 | 		await expect(a.getByText('Bob (you)')).toHaveCount(0);
  112 | 		await b.goto(`/recipes/${id}`);
  113 | 		await expect(b.getByText('Nothing here')).toBeVisible();
  114 | 		await ctxA.close();
  115 | 		await ctxB.close();
  116 | 		void bob;
  117 | 	});
  118 | });
  119 | 
```