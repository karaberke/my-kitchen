# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: caching.spec.ts >> cache headers: immutable assets, no-store pages/data, private media with authorized 304
- Location: tests/e2e/caching.spec.ts:5:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 401
Received: 500
```

# Page snapshot

```yaml
- generic [ref=f1e2]:
  - generic [ref=f1e3]:
    - link "Skip to content" [ref=f1e4] [cursor=pointer]:
      - /url: "#main"
    - complementary [ref=f1e5]:
      - link "Pantry & Plate" [ref=f1e6] [cursor=pointer]:
        - /url: /recipes
      - generic "Dana's kitchen" [ref=f1e8]
      - navigation "Main" [ref=f1e9]:
        - link "Recipes" [ref=f1e10] [cursor=pointer]:
          - /url: /recipes
          - generic [aria-hidden] [ref=f1e11]: ❏
        - link "Grocery" [ref=f1e13] [cursor=pointer]:
          - /url: /grocery
          - generic [aria-hidden] [ref=f1e14]: ☑
        - link "Pantry" [ref=f1e16] [cursor=pointer]:
          - /url: /pantry
          - generic [aria-hidden] [ref=f1e17]: ▤
        - link "Household" [ref=f1e19] [cursor=pointer]:
          - /url: /household
          - generic [aria-hidden] [ref=f1e20]: ⌂
        - link "Settings" [ref=f1e22] [cursor=pointer]:
          - /url: /settings
          - generic [aria-hidden] [ref=f1e23]: ⚙
      - generic [ref=f1e26]:
        - generic [ref=f1e27]: D
        - generic [ref=f1e28]:
          - generic [ref=f1e29]: Dana
          - generic [ref=f1e30]: dana-1788936781518-1@example.test
        - button "Sign out" [ref=f1e32]: ⇥
    - main [ref=f1e34]:
      - generic [ref=f1e35]:
        - link "Back" [ref=f1e36] [cursor=pointer]:
          - /url: /recipes
          - text: ‹
        - generic [ref=f1e37]:
          - heading "With photo" [level=1] [ref=f1e38]
          - generic [ref=f1e39]: Yours · private
        - link "Edit" [ref=f1e41] [cursor=pointer]:
          - /url: /recipes/6c002358-df78-4f61-b5b6-3ae32cc0e8ab/edit
      - article [ref=f1e42]:
        - generic [ref=f1e43]:
          - img "With photo" [ref=f1e45]
          - generic [ref=f1e46]: 2 servings
          - generic [ref=f1e48]:
            - button "☆ Favorite" [ref=f1e50] [cursor=pointer]
            - button "Share…" [ref=f1e51] [cursor=pointer]
            - button "Duplicate" [ref=f1e53] [cursor=pointer]
            - link "Export JSON" [ref=f1e54] [cursor=pointer]:
              - /url: /recipes/6c002358-df78-4f61-b5b6-3ae32cc0e8ab/export.json
            - link "Plain text" [ref=f1e55] [cursor=pointer]:
              - /url: /recipes/6c002358-df78-4f61-b5b6-3ae32cc0e8ab/print.txt
            - button "Print" [ref=f1e56] [cursor=pointer]
            - button "Archive" [ref=f1e58] [cursor=pointer]
            - button "Delete" [ref=f1e59] [cursor=pointer]
          - generic [ref=f1e60]:
            - generic [ref=f1e61]:
              - generic [ref=f1e62]: Servings
              - generic [ref=f1e63]: Original yield
            - group "Servings" [ref=f1e64]:
              - button "Fewer servings" [ref=f1e65]: −
              - status [ref=f1e66]: "2"
              - button "More servings" [ref=f1e67]: +
          - heading "Ingredients" [level=2] [ref=f1e69]
          - list [ref=f1e71]:
            - listitem [ref=f1e72]:
              - generic "Check while cooking" [ref=f1e73]
              - generic [ref=f1e74]:
                - generic [ref=f1e75]: salt
                - generic [ref=f1e76]: Check while cooking
          - generic [ref=f1e77]:
            - button "Add to grocery list" [ref=f1e78] [cursor=pointer]
            - link "Cook this" [ref=f1e79] [cursor=pointer]:
              - /url: /recipes/6c002358-df78-4f61-b5b6-3ae32cc0e8ab/cook?servings=2
        - generic [ref=f1e80]:
          - heading "Instructions" [level=2] [ref=f1e81]
          - list [ref=f1e82]:
            - listitem [ref=f1e83]:
              - button "Mark step 1 done" [ref=f1e84]: "1"
              - paragraph [ref=f1e85]: Season.
          - paragraph [ref=f1e86]: Checking steps is just for you while cooking. Only “Finish cooking” updates the pantry.
          - link "Open cooking view" [ref=f1e87] [cursor=pointer]:
            - /url: /recipes/6c002358-df78-4f61-b5b6-3ae32cc0e8ab/cook?servings=2
  - generic [ref=f1e88]: With photo · Pantry & Plate
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import { createRecipe, register } from './helpers';
  3  | import path from 'node:path';
  4  | 
  5  | test('cache headers: immutable assets, no-store pages/data, private media with authorized 304', async ({
  6  | 	page,
  7  | 	browser
  8  | }) => {
  9  | 	await register(page, 'Dana');
  10 | 	const html = await page.request.get('/recipes');
  11 | 	expect(html.headers()['cache-control']).toBe('private, no-store');
  12 | 	const data = await page.request.get('/recipes/__data.json');
  13 | 	expect(data.headers()['cache-control']).toBe('private, no-store');
  14 | 	const rev = await page.request.get('/api/revisions');
  15 | 	expect(rev.headers()['cache-control']).toBe('private, no-store');
  16 | 	expect(Number(rev.headers()['content-length'] ?? (await rev.text()).length)).toBeLessThan(200);
  17 | 
  18 | 	// hashed asset from the page
  19 | 	const src = await page
  20 | 		.locator('link[rel=modulepreload], script[src]')
  21 | 		.first()
  22 | 		.getAttribute('href')
  23 | 		.catch(() => null);
  24 | 	const assetUrl =
  25 | 		src ?? (await page.locator('script[src*="/_app/immutable/"]').first().getAttribute('src'));
  26 | 	if (assetUrl) {
  27 | 		const asset = await page.request.get(assetUrl);
  28 | 		expect(asset.status()).toBe(200);
  29 | 		expect(asset.headers()['cache-control']).toContain('immutable');
  30 | 	}
  31 | 	const missing = await page.request.get('/_app/immutable/does-not-exist.js');
  32 | 	expect(missing.status()).toBe(404);
  33 | 	expect(missing.headers()['cache-control'] ?? '').not.toContain('immutable');
  34 | 
  35 | 	// upload an image and check private media policy
  36 | 	await page.goto('/recipes/new');
  37 | 	await page.getByLabel('Title').fill('With photo');
  38 | 	await page.getByLabel('Base servings').fill('2');
  39 | 	await page.locator('#ing-0-name').fill('salt');
  40 | 	await page.locator('#step-0-text').fill('Season.');
  41 | 	await page.locator('#image').setInputFiles(path.resolve('tests/e2e/fixtures/photo.jpg'));
  42 | 	await page.getByRole('button', { name: 'Save recipe' }).click();
  43 | 	await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  44 | 	const img = page.locator('article img').first();
  45 | 	const mediaUrl = (await img.getAttribute('src'))!;
  46 | 	const media = await page.request.get(mediaUrl);
  47 | 	expect(media.status()).toBe(200);
  48 | 	expect(media.headers()['cache-control']).toBe('private, no-cache');
  49 | 	const etag = media.headers()['etag'];
  50 | 	expect(etag).toBeTruthy();
  51 | 	const conditional = await page.request.get(mediaUrl, { headers: { 'if-none-match': etag } });
  52 | 	expect(conditional.status()).toBe(304);
  53 | 
  54 | 	// another user: no bytes, and no 304 either
  55 | 	const other = await browser.newContext();
  56 | 	const otherPage = await other.newPage();
  57 | 	await register(otherPage, 'Eve');
  58 | 	const denied = await otherPage.request.get(mediaUrl, { headers: { 'if-none-match': etag } });
  59 | 	expect(denied.status()).toBe(404);
  60 | 	const anon = await (
  61 | 		await browser.newContext()
  62 | 	).request.get(mediaUrl, { headers: { 'if-none-match': etag } });
> 63 | 	expect(anon.status()).toBe(401);
     |                        ^ Error: expect(received).toBe(expected) // Object.is equality
  64 | 	await other.close();
  65 | });
  66 | 
```