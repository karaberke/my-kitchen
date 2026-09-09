# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: recipes.spec.ts >> recipes >> a private recipe is denied to another user until shared, then visible via household
- Location: tests/e2e/recipes.spec.ts:70:2

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Nothing here')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText('Nothing here') with timeout 5000ms
  - waiting for getByText('Nothing here')

```

```yaml
- link "Skip to content":
  - /url: "#main"
- complementary:
  - link "Pantry & Plate":
    - /url: /recipes
  - text: Bob's kitchen
  - navigation "Main":
    - link "Recipes":
      - /url: /recipes
    - link "Grocery":
      - /url: /grocery
    - link "Pantry":
      - /url: /pantry
    - link "Household":
      - /url: /household
    - link "Settings":
      - /url: /settings
  - text: B Bob bob-1788936786251-2@example.test
  - button "Sign out": ⇥
- main:
  - text: "500"
  - heading "Something went wrong" [level=1]
  - paragraph: Something went wrong on our side. Please try again.
  - paragraph: ref 7459e5e2-b8d5-4f74-8295-652a952eb575
  - link "Back to recipes":
    - /url: /recipes
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
  67  | 		expect(gone.status()).toBe(404);
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
> 86  | 		await expect(b.getByText('Nothing here')).toBeVisible();
      |                                             ^ Error: expect(locator).toBeVisible() failed
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