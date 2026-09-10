# Server resource reductions

Measured locally on 2026-09-09, macOS arm64, Node 26.8.1, PostgreSQL 17.6
in Docker. These are controlled fixture measurements, not production estimates.

## Baseline

The requested `pg_stat_statements` query failed because the extension was absent
and `shared_preload_libraries` was empty. Statement logging was temporarily enabled
for `recipe_test`, then reset. The integration fixture counts queries directly
through the Postgres.js debug callback, restoring that callback in `finally`.
The development database had two recipes and no images, so browser measurements
use the cache test's uploaded photo instead of claiming a 24-image page measurement.

| Operation                                                                             | Before                     | After               |
| ------------------------------------------------------------------------------------- | -------------------------- | ------------------- |
| Refresh draft with 40 recipe lines: total statements, including transaction and locks | 130                        | 13                  |
| Same refresh: grocery line/source writes                                              | 120                        | 3                   |
| Repeat `/recipes` navigation: photo network transfers                                 | 1 revalidation (300 bytes) | 0 bytes, no request |
| Upload of a 4032x3024 phone photo: bytes sent                                         | 3.60 MB                    | 210 KB              |

The 40-line fixture was run against the original grocery implementation before
batching and again afterward. It checks stable line IDs, ordering, quantities,
revisions and source mappings, and guards the three-write budget. A refresh with
only existing recipe lines needs one source deletion, one line update and one
source insertion. Mixed lists can additionally use one new-line insert and one
manual-line update. Stale-line deletion and list metadata updates remain separate,
constant-count statements. Query reduction does not establish a latency or CPU
percentage improvement.

The baseline browser run used the existing production build, which still returned
`private, no-cache`. The updated header assertion failed as expected. The browser
fixture navigates `/recipes` → `/plan` → `/recipes`, waits for image decoding, and
reads Resource Timing transfer sizes. Forced reloads and DevTools' “Disable cache”
explicitly request different browser behavior and are not the cache-reuse scenario.

That fixture now reports `[0]`: the repeat navigation transfers no media bytes and
issues no request, against one conditional request per image per view before. The
measurement covers a single uploaded photo, so it demonstrates cache reuse rather
than a page-level total. Authorization, ETag and `Vary: Cookie` are unchanged, and
the same test still asserts that a non-member receives 404 and an anonymous caller
401 for the same URL.

The planner picker now performs one five-column query rather than a card query
plus count, retaining the same visibility predicate, active/draft filtering,
updated-time ordering and 100-result cap. Pantry search uses a literal,
case-normalized prefix; substring-only matches intentionally no longer appear.

## Reproduction

```sh
pnpm exec vitest run --project integration tests/integration/grocery-flow.test.ts -t '40 lines' --disableConsoleIntercept
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

Session cookie caching remains disabled. Both media routes retain authorization
before conditional responses and return `private, max-age=300`, ETag and `Vary:
Cookie`. Dynamic HTML and data retain `private, no-store`.

## Phase 2.1: photo downscaling before upload

`resizeForUpload` draws the chosen file onto a canvas at 1600px on its longest edge
and re-encodes it as WebP at quality 0.82, matching `IMAGE_VARIANTS.detail`. The
browser fixture wraps `fetch` and sums the blob sizes in the submitted `FormData`,
because Playwright reports `requestBodySize` 0 for SvelteKit's multipart submit.
A 4032x3024, 3.60 MB JPEG was sent as 210 KB. The stored `detail` variant remained
WebP at 1600x1200, so what the server keeps is unchanged.

Files under 512 KB, GIFs and SVGs are left untouched: re-encoding a small file
usually costs bytes, a GIF would lose its animation and an SVG has no raster. A
second fixture confirms a small photo is uploaded byte-for-byte. Every failure path
returns the original file, so an unsupported browser still uploads successfully.

This is an optimisation and not a validation boundary. `storeRecipeImage` still
re-decodes, re-checks the format and dimensions, and re-encodes both variants,
because a browser can send anything. Two related fixes: the file is now read inside
the concurrency semaphore rather than before it, so a burst can no longer hold every
upload in memory while only `IMAGE_CONCURRENCY` progress; and the wait queue is
capped at 32, returning 503 rather than queueing without bound.

One behavioural consequence worth noting: a photo larger than `UPLOAD_MAX_BYTES`
now succeeds when the browser can downscale it, because the server receives the
smaller file. Without JavaScript the original limit still applies.

## Phase 2.2: parsing imports in the browser

`importRecipeHtml` and `parseRecipeText` were already pure string work in
`$lib/shared`, so the only server-bound piece was pdf.js. The import form now parses
the chosen file client-side and posts the result alongside it as `clientParsed`.

| Operation                               | Before                 | After                          |
| --------------------------------------- | ---------------------- | ------------------------------ |
| `/recipes/import` page load: JavaScript | 14 KB                  | 14 KB                          |
| Same page after parsing a PDF           | 14 KB                  | 401 KB                         |
| Server work to read a PDF import        | pdf.js parse, resident | none on the client-parsed path |

pdf.js sits behind a dynamic import, so it is fetched only when a PDF is actually
chosen: about 387 KB over the wire, paid by PDF imports alone rather than by every
page view. A fixture asserts the page stays under 500 KB on load and grows only
after a PDF is parsed, so a later refactor cannot silently make it eager.

Bytes uploaded are unchanged. The original file is still sent, because it is kept
as the recipe's source attachment; what moves off the server is the parsing, not
the transfer.

The payload is checked, not trusted. `readImportedRecipe` validates it against a
zod schema that bounds every string and caps ingredients and steps at 200 each,
and it always overrides `intent`, `expectedRevision` and `removeImage`. Anything
absent or malformed makes the server parse the upload itself, exactly as before —
which is also the no-JavaScript path. A fixture forges a bad payload and confirms
the server's own parse still produces the right recipe.

## Phase 2.3: validating the recipe form in the browser

`RecipeForm`'s submit handler now runs `parseRecipeForm` and `validateRecipe` — the
same two functions `handleRecipeSubmit` calls on the server — and cancels the submit
when they fail. A recipe with no title, servings, ingredients or steps reports all
four problems with no request at all, where before each attempt cost a full round
trip: request, session lookup, membership resolution, validation and a re-render.

This cannot drift from the server, because it is the same code rather than a copy.
The server still validates everything on arrival, so a submission that bypasses the
browser is rejected exactly as before. Findings the browser cannot make, such as an
image the server refuses to decode, still arrive by round trip and are merged over
the client's own.

Draft submissions keep their looser rules: `intent` travels on the clicked button,
so `parseRecipeForm` sees it and `validateRecipe` applies the draft path. A fixture
covers both — a full save reporting four errors and sending nothing, then a draft
with only a title saving on the first request.

Validation runs before the photo is downscaled, so a large image is not decoded and
re-encoded only for the save to be rejected.
