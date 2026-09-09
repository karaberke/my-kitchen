# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: shopping.spec.ts >> plan two recipes, review pantry subtraction, shop with partial purchases, cook and undo
- Location: tests/e2e/shopping.spec.ts:4:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText(/Pantry updated: 1 deduction/)
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText(/Pantry updated: 1 deduction/) with timeout 5000ms
  - waiting for getByText(/Pantry updated: 1 deduction/)

```

```yaml
- link "Skip to content":
  - /url: "#main"
- complementary:
  - link "Pantry & Plate":
    - /url: /recipes
  - text: Carol's kitchen
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
  - text: C Carol carol-1788936792394-1@example.test
  - button "Sign out": ⇥
- main:
  - link "Back":
    - /url: /recipes/0943c9b1-8bfc-4460-9ee6-0d31dee0d238
    - text: ‹
  - heading "Cooking" [level=1]
  - text: Curry · 2 servings
  - group "Servings":
    - button "Fewer servings": −
    - text: "2"
    - button "More servings": +
  - status:
    - text: "Pantry updated: 1 deduction. 2 planned servings fulfilled."
    - button "Undo this cooking"
    - link "View history":
      - /url: /pantry/history
  - region "Ingredients · tap to check off":
    - heading "Ingredients · tap to check off" [level=2]
    - list:
      - listitem:
        - button "150 g chicken breast"
    - paragraph: Checking items here changes nothing in the pantry.
  - region "Steps":
    - button "Step 1 Simmer.":
      - text: Step 1
      - paragraph: Simmer.
    - button "Finish & update pantry" [disabled]
- status:
  - text: Pantry updated.
  - button "Dismiss": ×
- text: Cooking Curry · Pantry & Plate
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import { createRecipe, register } from './helpers';
  3  | 
  4  | test('plan two recipes, review pantry subtraction, shop with partial purchases, cook and undo', async ({
  5  | 	page
  6  | }) => {
  7  | 	await register(page, 'Carol');
  8  | 	await createRecipe(page, {
  9  | 		title: 'Roast',
  10 | 		servings: '4',
  11 | 		ingredient: { amount: '500', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
  12 | 		step: 'Roast.'
  13 | 	});
  14 | 	const curryId = await createRecipe(page, {
  15 | 		title: 'Curry',
  16 | 		servings: '4',
  17 | 		ingredient: { amount: '300', unit: 'g', name: 'chicken breast', match: 'chicken breast' },
  18 | 		step: 'Simmer.'
  19 | 	});
  20 | 
  21 | 	// pantry: 300 g
  22 | 	await page.goto('/pantry');
  23 | 	await page.getByRole('button', { name: '+ Add stock' }).click();
  24 | 	await page.locator('#add-name').fill('chicken breast');
  25 | 	await page
  26 | 		.getByRole('option', { name: /chicken breast/ })
  27 | 		.first()
  28 | 		.click();
  29 | 	await page.locator('#add-qty').fill('300');
  30 | 	await page.locator('#add-unit').selectOption('g');
  31 | 	await page.locator('#add-loc').fill('Freezer');
  32 | 	await page.getByRole('button', { name: 'Add', exact: true }).click();
  33 | 	await expect(page.getByText('300 g', { exact: true }).first()).toBeVisible();
  34 | 
  35 | 	// plan both recipes
  36 | 	for (const title of ['Roast', 'Curry']) {
  37 | 		await page.goto('/recipes');
  38 | 		await page.getByRole('link', { name: title }).first().click();
  39 | 		await page.getByRole('button', { name: 'Add to grocery list' }).click();
  40 | 		await page.getByRole('button', { name: 'Add to list' }).click();
  41 | 		await expect(page.getByText(/Planned 4 servings/)).toBeVisible();
  42 | 	}
  43 | 	await page.goto('/grocery');
  44 | 	await expect(page).toHaveURL(/\/grocery\/[0-9a-f-]{36}$/);
  45 | 	await expect(page.getByText('need 800 g · pantry 300 g')).toBeVisible();
  46 | 	await expect(page.getByText('500 g', { exact: true })).toBeVisible();
  47 | 
  48 | 	// start shopping
  49 | 	await page.getByRole('button', { name: 'Start shopping' }).click();
  50 | 	await expect(page.getByText(/Shopping ·/)).toBeVisible();
  51 | 
  52 | 	// buy 200 g
  53 | 	await page.getByRole('button', { name: /Buy chicken breast/ }).click();
  54 | 	await page.locator('#buy-qty').fill('200');
  55 | 	await page.locator('#buy-unit').selectOption('g');
  56 | 	await page.getByRole('button', { name: 'Bought it' }).click();
  57 | 	await expect(page.getByText('300 g', { exact: true })).toBeVisible();
  58 | 	await expect(page.getByText(/bought 200 g/)).toBeVisible();
  59 | 
  60 | 	// buy 1 kg pack -> complete
  61 | 	await page.getByRole('button', { name: /Buy chicken breast/ }).click();
  62 | 	await page.locator('#buy-qty').fill('1');
  63 | 	await page.locator('#buy-unit').selectOption('kg');
  64 | 	await page.getByRole('button', { name: 'Bought it' }).click();
  65 | 	await expect(page.getByText('All done here')).toBeVisible();
  66 | 	await page.getByRole('button', { name: 'All' }).click();
  67 | 	await expect(page.getByText(/bought 1.2 kg/)).toBeVisible();
  68 | 
  69 | 	// pantry now 1.5 kg
  70 | 	await page.goto('/pantry');
  71 | 	await expect(page.getByText('1.5 kg', { exact: true }).first()).toBeVisible();
  72 | 
  73 | 	// cook the curry for 2 servings from the plan
  74 | 	await page.goto(`/recipes/${curryId}/cook?servings=2`);
  75 | 	await page.getByRole('button', { name: 'Finish & update pantry' }).click();
  76 | 	await page.locator('#finish-batch').selectOption({ index: 1 });
  77 | 	await page.getByRole('button', { name: 'Deduct from pantry' }).click();
> 78 | 	await expect(page.getByText(/Pantry updated: 1 deduction/)).toBeVisible();
     |                                                              ^ Error: expect(locator).toBeVisible() failed
  79 | 	await expect(page.getByText(/2 planned servings fulfilled/)).toBeVisible();
  80 | 	await page.goto('/pantry');
  81 | 	await expect(page.getByText('1.35 kg', { exact: true }).first()).toBeVisible();
  82 | 
  83 | 	// undo from history restores 150 g
  84 | 	await page.goto('/pantry/history');
  85 | 	await page.getByRole('button', { name: 'Undo' }).first().click();
  86 | 	await expect(page.getByText(/Undid: Cooked Curry/)).toBeVisible();
  87 | 	await page.goto('/pantry');
  88 | 	await expect(page.getByText('1.5 kg', { exact: true }).first()).toBeVisible();
  89 | });
  90 | 
```