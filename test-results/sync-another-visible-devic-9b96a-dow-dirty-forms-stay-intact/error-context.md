# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sync.spec.ts >> another visible device sees a pantry change within the polling window; dirty forms stay intact
- Location: tests/e2e/sync.spec.ts:4:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Pantry is empty')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByText('Pantry is empty') with timeout 5000ms
  - waiting for getByText('Pantry is empty')

```

```yaml
- text: Pantry & Plate Recipes · groceries · pantry
- heading "Welcome back" [level=1]
- paragraph: Sign in to your recipes and household.
- text: Email
- textbox "Email"
- text: Password
- textbox "Password"
- paragraph: Forgot it? Password reset by email is not set up on this installation; ask a household owner to help.
- button "Sign in"
- paragraph:
  - text: New here?
  - link "Create an account":
    - /url: /register
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import { register } from './helpers';
  3  | 
  4  | test('another visible device sees a pantry change within the polling window; dirty forms stay intact', async ({
  5  | 	browser
  6  | }) => {
  7  | 	const ctxA = await browser.newContext();
  8  | 	const a = await ctxA.newPage();
  9  | 	const { email, password } = await register(a, 'Fay');
  10 | 	const ctxB = await browser.newContext();
  11 | 	const b = await ctxB.newPage();
  12 | 	await b.goto('/login');
  13 | 	await b.getByLabel('Email').fill(email);
  14 | 	await b.getByLabel('Password').fill(password);
  15 | 	await b.getByRole('button', { name: 'Sign in' }).click();
  16 | 	await b.goto('/pantry');
> 17 | 	await expect(b.getByText('Pantry is empty')).toBeVisible();
     |                                               ^ Error: expect(locator).toBeVisible() failed
  18 | 
  19 | 	await a.goto('/pantry');
  20 | 	await a.getByRole('button', { name: '+ Add stock' }).click();
  21 | 	await a.locator('#add-name').fill('rice');
  22 | 	await a.getByRole('option', { name: /^rice/ }).first().click();
  23 | 	await a.locator('#add-qty').fill('1');
  24 | 	await a.locator('#add-unit').selectOption('kg');
  25 | 	await a.getByRole('button', { name: 'Add', exact: true }).click();
  26 | 	await expect(a.getByText('1 kg', { exact: true }).first()).toBeVisible();
  27 | 
  28 | 	// device B polls every PUBLIC_REVISION_POLL_MS (2 s in .env.test)
  29 | 	await expect(b.getByText('1 kg', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  30 | 
  31 | 	// B opens a sheet (dirty input); A changes stock again; B keeps its sheet and gets a notice
  32 | 	await b.getByRole('button', { name: '+ Add stock' }).click();
  33 | 	await b.locator('#add-qty').fill('250');
  34 | 	await a.getByRole('button', { name: 'Add stock' }).first().click();
  35 | 	await a.locator('#add-qty').fill('2');
  36 | 	await a.locator('#add-unit').selectOption('kg');
  37 | 	await a.getByRole('button', { name: 'Add', exact: true }).click();
  38 | 	await expect(b.getByText('Changed by another member')).toBeVisible({ timeout: 10_000 });
  39 | 	await expect(b.locator('#add-qty')).toHaveValue('250');
  40 | 	await ctxA.close();
  41 | 	await ctxB.close();
  42 | });
  43 | 
```