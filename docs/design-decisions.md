# Design decisions

Pantry & Plate is a single SvelteKit application with one PostgreSQL database.
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

| Response                                | Origin header                                           | Cloudflare |
| --------------------------------------- | ------------------------------------------------------- | ---------- |
| `/_app/immutable/*`                     | `public, max-age=31536000, immutable` (SvelteKit)       | cache      |
| HTML, `__data.json`, auth, API, exports | `private, no-store`                                     | bypass     |
| `/media/{id}/{variant}`                 | `private, no-cache` + `ETag`; auth happens before a 304 | bypass     |
| Errors, redirects, missing assets       | `private, no-store` (hook default)                      | not cached |
| `robots.txt`, favicon                   | `public, max-age=600, must-revalidate`                  | short TTL  |

The hook applies the default to every response that does not opt out, so a
long TTL cannot leak onto a dynamic route. Media keys are opaque and include
the image version, so a replaced photo gets a new URL.

## Deferred on purpose

Meal calendars, nutrition, barcode scanning, recommendations, public
publishing, cross-list stock reservations, offline mutation queues,
ingredient-to-step linking, recipe import (HTML/JSON/text/AI), email-based
password reset, alias management UI for custom ingredients, and signed direct
S3 downloads.
