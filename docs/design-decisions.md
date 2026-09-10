# Design decisions

My Kitchen is a single SvelteKit application with one PostgreSQL database.
This note explains the choices that are not obvious from the code.

## Ownership and isolation

- **Recipes belong to a user.** They are private unless the owner shares them
  with a household they belong to (`recipe_share`). Members of that household
  can view and duplicate; only the owner edits. Unsharing or removing a member
  cuts access on the next request because every load, action and media request
  re-checks the database (`assertMember`, `recipeReadableBy`), never a cached
  claim.
- **Pantry stock and grocery lists belong to a household.** A user can belong to
  several households; the active one is a per-user preference that is repaired
  automatically if membership disappears.
- **Ingredient identities** come from a read-only shared catalog (owner null)
  plus private custom identities (owner = user). Autocomplete only ever returns
  catalog rows and the caller's own rows. A shared recipe carries its custom
  ingredient names by value (the recipe row stores `name`), so members see the
  recipe without gaining a way to enumerate the owner's other identities.
- **Origin handling**: `ORIGIN` is the single source of truth for CSRF and
  auth trusted origins in production. When it is empty (Cloudflare quick tunnel
  with a random hostname) the app trusts the origin of each request as
  forwarded by the tunnel (`X-Forwarded-Proto` + `Host`); cross-site posts still
  fail because their `Origin` differs from the `Host` they target. In `vite dev`
  the dev-server origin is trusted in addition, so one `.env` serves both.
- **Auth rate limits**: the form actions for sign-in, sign-up and password change
  use a small in-process sliding-window limiter keyed by client address (and
  email for sign-in), because Better Auth's own limiter only guards its HTTP
  handler and the app calls `auth.api.*` server-side. Single instance only;
  a restart resets it. Behind a tunnel or proxy every request otherwise carries
  the proxy's address, which collapses the buckets into one and lets a stranger
  spend a chosen account's sign-in allowance — so `ADDRESS_HEADER` names the
  header holding the real client IP (`deploy.sh` sets `cf-connecting-ip` for the
  tunnel profiles). It must stay unset when the app is reachable directly, since
  a request without that header then has no address at all.
- **Sessions** are Better Auth database sessions with cookie caching disabled,
  so revoking a session or changing a password (which revokes other sessions)
  takes effect immediately.

## Quantities and units

- All arithmetic uses `Dec`, a BigInt fixed-point type with six decimals that
  mirrors the `numeric(14,6)` columns. Values cross JSON as strings; nothing
  is rounded until display (`toHuman`, two decimals).
- Units are immutable shared constants. Mass, volume and count convert within
  their dimension; cups and spoons convert using the recipe's stored
  convention (metric 250 ml / 15 ml or US 236.588 ml / 14.7868 ml). Volume to
  mass only happens with an explicit ingredient density. Package units (can,
  bag, clove ...) never convert and only match themselves.
- An unknown amount is `null`, distinct from zero. Unknown amounts stay visible
  in previews and lists but never enter arithmetic.
- A _unit system_ (`as-written`, `metric`, `us`) is a display setting and is not
  the same thing as a convention: the convention says how big a cup is, the
  system says which units the reader wants to see. Switching systems never
  rewrites stored amounts, never reaches the server, and defaults to
  `as-written`, so a recipe always renders exactly as entered until asked
  otherwise. The choice lives in `localStorage` only.
- Display conversion stays inside its dimension — mass to mass, volume to
  volume — and never uses density, even where one exists. A recipe where only
  the curated ingredients became cups would read worse than a consistent one.
  Converted volumes snap to fractions a measuring set actually has (1/8, 1/4,
  1/3, 1/2, 2/3, 3/4, 7/8) and masses to decimal steps, since scales are
  decimal. Snapped values are prefixed `~`.
- Unit switching is confined to the recipe page and cook mode's read-only
  ingredient list. Grocery lists, the pantry, and cook mode's deduction form
  stay in stored units, because there the unit is a contract for purchase
  crediting and lot matching rather than something being read off a page.

## Grocery snapshots

A list moves `draft → shopping → completed`.

- A **draft** stores planned batches (recipe id, title, revision, base
  servings, requested servings, and a snapshot of the requirements). The draft
  is recalculated from scratch whenever it changes: aggregate every batch's
  remaining demand first, then subtract current pantry once per line. Manual
  lines keep their own requested amount and are only pantry-subtracted when the
  user asks. The draft records the household pantry revision the preview used.
- **Start shopping** locks the household row, compares the recorded pantry
  revision and each batch's recipe revision with the current ones, and if any
  moved it commits a fresh preview and returns a review conflict instead of
  committing stale targets. Only when everything matches do the suggested
  amounts become committed purchase targets and the list becomes `shopping`.
- During shopping `remaining = max(0, target − net credited purchases)`. A
  purchase adds the full bought amount to the pantry as a new lot and credits
  the line once (converted to the line unit when possible). The pantry is never
  subtracted again. Deliberate remaining-target edits set
  `target = credited + new remaining` with a revision check. Recipe-derived
  targets are never recalculated automatically; more recipes go into a new
  draft.
- Separate lists do not reserve stock from each other; the UI says so.

## Transaction invariants

Every purchase, cooking action, correction, waste and undo:

1. Re-checks membership inside the transaction.
2. Claims a client-supplied **operation id** (primary key of `operation`) with
   a payload fingerprint before doing anything else. A retry with the same id
   and payload returns the stored result; the same id with a different payload
   is rejected with 409. Concurrent retries block on the primary key.
3. Locks in a fixed order: household row (which also bumps the revision
   counters), then affected lots ordered by id `FOR UPDATE`. Lot quantity
   updates are guarded (`quantity + delta >= 0`) and a `CHECK` constraint
   backs them up.
4. Writes the event, the append-only movements (with balance after), the lot
   balances, purchase allocations and batch fulfilment in the same
   transaction. Serialization failures and deadlocks are retried a bounded
   number of times.

Undo inserts one compensating `undo` event linked to the original (a unique
index makes a second undo impossible). It reverses the original deltas against
_current_ balances; if a purchase's lot has since been consumed the undo is
refused with a review conflict that points to a quantity correction instead.
Reversing a cooking event also restores the planned servings it fulfilled.

Balances are kept on the lot for fast reads; a maintenance consistency check
compares them with the movement log.

## Freshness without extra infrastructure

`household.pantry_revision` and `household.grocery_revision` change in the same
transaction as the data. Pantry and list screens poll `/api/revisions` (about
100 bytes, no-store) every 20 s while visible and online, with backoff on
failures, and only re-run their loads when a watched counter changed. If the
page has unsaved input, a notice is shown instead of replacing the form.

## Caching rules

| Response                                | Origin header                                              | Cloudflare |
| --------------------------------------- | ---------------------------------------------------------- | ---------- |
| `/_app/immutable/*`                     | `public, max-age=31536000, immutable` (SvelteKit)          | cache      |
| HTML, `__data.json`, auth, API, exports | `private, no-store`                                        | bypass     |
| `/media/{id}/{variant}`                 | `private, max-age=300` + `ETag`; auth happens before a 304 | bypass     |
| Errors, redirects, missing assets       | `private, no-store` (hook default)                         | not cached |
| `robots.txt`, favicon                   | `public, max-age=600, must-revalidate`                     | short TTL  |

The hook applies the default to every response that does not opt out, so a
long TTL cannot leak onto a dynamic route. Media keys are opaque and include
the image version, so a replaced photo gets a new URL. The five-minute media
window is an authorisation bound, not a freshness one: the bytes behind a URL
never change, but someone who has just lost access keeps what their browser
already cached for that long.

Every response also carries `X-Content-Type-Options`, `Referrer-Policy`,
`X-Frame-Options` and `Permissions-Policy`, plus `Strict-Transport-Security`
when the request arrived over https. The Content-Security-Policy comes from
`kit.csp`: SvelteKit nonces its own hydration script and everything else is
same-origin, apart from the Google Fonts stylesheet linked in `app.html`.

## Retention

Three things accumulate with no user-facing delete, so `hooks.server.ts` sweeps
them hourly (and once at start-up):

- **Images** no recipe references, older than an hour. An edit that replaces a
  photo leaves the old one behind, and a failed save leaves the new one.
- **Attachments** no recipe references, older than an hour. An import stores its
  source file during the _parse_ step, before the user decides to keep anything,
  so every abandoned import leaks one.
- **Operations** older than 30 days — idempotency records, one per pantry,
  grocery or cooking mutation, long past any window in which a client retries.

The grace period matters: a sweep that ran immediately would race a review form
the user still has open. Nothing referenced is ever a candidate.

## Deferred on purpose

Meal calendars, nutrition, barcode scanning, recommendations, public
publishing, cross-list stock reservations, offline mutation queues,
ingredient-to-step linking, email-based password reset, alias management UI for
custom ingredients, and signed direct S3 downloads.
