# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Project instructions

## Commands

Package manager is pnpm (Node 24). First-time setup:

```sh
pnpm install
pnpm db:dev            # PostgreSQL 17 on 127.0.0.1:5433 (compose.dev.yaml)
cp .env.example .env   # the defaults point at that database
pnpm db:migrate
pnpm dev               # http://localhost:5173
```

| Task                   | Command                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| Types                  | `pnpm check` (svelte-check; there is no `typecheck` script)         |
| Format + lint          | `pnpm lint` (prettier --check, then eslint), `pnpm format` to write |
| Unit + integration     | `pnpm test`                                                         |
| Unit only              | `pnpm test:unit` (`src/**/*.test.ts`, no database)                  |
| Integration only       | `pnpm test:integration` (`tests/integration/`, real database)       |
| One test file          | `pnpm vitest run --project unit src/lib/shared/units.test.ts`       |
| One test by name       | add `-t "part of the test name"`                                    |
| Browser tests          | `pnpm build && pnpm test:e2e`                                       |
| One browser spec       | `pnpm exec playwright test tests/e2e/plan.spec.ts`                  |
| New migration          | `pnpm db:generate` after you edit `src/lib/server/db/schema.ts`     |
| Apply migrations       | `pnpm db:migrate` (dev), `pnpm db:migrate:test` (test database)     |
| Data consistency check | `pnpm db:check`                                                     |
| Auth tables            | `pnpm auth:schema` after a Better Auth configuration change         |

Make the test database once, then migrate it:

```sh
docker compose -f compose.dev.yaml -p my-kitchen-dev exec db \
  psql -U recipe -d recipe_dev -c 'create database recipe_test'
pnpm db:migrate:test
```

The integration project refuses to start unless `DATABASE_URL` contains
`recipe_test`. Browser tests start the built app on port 4173 against the same
test database; the Docker install serves on `APP_PORT` (3003 by default).

## Architecture

One SvelteKit 2 application (Svelte 5 runes, Tailwind 4, adapter-node) with one
PostgreSQL database through Drizzle ORM, and Better Auth for accounts.
`docs/design-decisions.md` gives the reasons behind the rules below; read it
before you change ownership, quantities, grocery state or the cache policy.

**Layers.** `src/lib/server/` is server-only (database, access control, domain
operations). `src/lib/shared/` is pure logic that runs on both sides (units,
`Dec` arithmetic, ingredient text, GTIN). `src/lib/client/` is browser-only.
Routes hold no domain logic: a `+page.server.ts` parses the form, calls a
function in `src/lib/server/`, and maps the error.

**Request lifecycle.** `src/hooks.server.ts` resolves the session one time per
request into `event.locals` (`user`, `session`, `memberships`, `household`,
`requestId`). No module-level user state exists on the server.
`applyResponsePolicy` puts the cache and security headers on every response;
the default is `private, no-store`, and a route must opt out of it. `init()`
creates the `ADMIN_*` account and starts the hourly sweep of unreferenced
images, attachments, operation records and barcode cache rows.

**Access control.** `locals` is a cache, not an authority. Each load and each
action calls `requireUser` / `requireHousehold` from `src/lib/server/access.ts`
and then `assertMember(db, householdId, userId)` against the database — again
inside the transaction for a write. Recipes belong to a user and become visible
to a household only through `recipe_share`; pantry stock and grocery lists
belong to a household.

**Writes.** Each pantry, grocery and cooking mutation goes through
`withTransaction` in `src/lib/server/operations.ts`: claim the client-supplied
operation id with a payload fingerprint (idempotency), lock the household row
first and then the lots by id, write the event plus the append-only
`inventory_movement` rows, and let serialization failures retry. Undo is a
compensating event, not a delete. Routes supply the operation id from
`randomUUID()` in the load.

**Errors.** `AppError` and `ReviewConflict` from `src/lib/server/errors.ts`
carry the status. Loads wrap in `guard()` from `src/lib/server/http.ts`;
actions map to `fail()`. Use `pgError()` to read a SQLSTATE, because Drizzle
wraps driver errors.

**Freshness.** `household.pantry_revision`, `grocery_revision` and
`plan_revision` change in the same transaction as the data, and the client
polls `/api/revisions`. Bump the correct counter, or screens stop refreshing.

**Quantities.** All arithmetic uses `Dec` (BigInt, six decimals) to mirror the
`numeric(14,6)` columns, and crosses JSON as a string. `null` means unknown and
is not zero. Unit conversion stays inside its dimension; a display unit system
never rewrites stored amounts.

**Media and barcode.** `src/lib/server/media/` stores images and attachments
(local disk or S3) and `/media/...` checks access before it answers, including
before a 304. `src/lib/server/barcode/` asks USDA first and Open Food Facts
second; `src/lib/shared/gtin.ts` holds the canonical 14-digit identity.

**Configuration.** `src/lib/server/env.ts` validates every environment variable
with zod; add new ones there. The Content-Security-Policy lives in
`svelte.config.js`, so a new external origin needs a directive there as well.

## Working style

- Short, technical answers. No preamble, no restating what you just did.
- Read a file before you change it.
- Match the surrounding code. Do not add a library, pattern, or abstraction when
  one already exists in the repo for the same job.
- Change only what the task requires. Never revert, reformat, or "clean up"
  unrelated code.

## Reuse before you write

Write the helper one time, in the module that owns the subject, and import it
everywhere else. Do not write a new function, constant or type for each task
when one already exists.

Before you add a helper, search for one: `grep -rn "<name or keyword>" src`.

Where a shared helper belongs:

| Subject                                        | File                           |
| ---------------------------------------------- | ------------------------------ |
| Pure logic for both sides (units, `Dec`, text) | `src/lib/shared/<subject>.ts`  |
| Small string helpers                           | `src/lib/shared/text.ts`       |
| Display formatting in the browser              | `src/lib/client/format.ts`     |
| HTTP wrappers (`guard`, `fail` mapping)        | `src/lib/server/http.ts`       |
| Error types and `pgError()`                    | `src/lib/server/errors.ts`     |
| Session and membership checks                  | `src/lib/server/access.ts`     |
| Transactions, idempotency, locks               | `src/lib/server/operations.ts` |
| Markup used more than one time                 | `src/lib/components/*.svelte`  |
| Browser test helpers                           | `tests/e2e/helpers.ts`         |
| Integration test helpers and fixtures          | `tests/integration/helpers.ts` |

Rules:

- A value used in more than one file becomes an exported constant, not a second
  literal. Magic numbers and repeated strings are a defect.
- Put a new helper in the existing topic module. Make a new file only for a new
  subject, and name it for that subject. Do not make a `utils.ts` catch-all and
  do not make a one-off helper file for each task.
- If you find two copies of the same logic, replace both with one call. Say
  that you did it.
- Give a helper parameters instead of writing a near-copy of it.

## Do not read these paths

They are generated, binary, private or very large. They tell you nothing that
the source does not tell you, and they fill the context window. Do not open,
`cat`, or search them. Use `git status`, `pnpm check` or the source file
instead.

- `node_modules/` — read the package API from its types only if you must, never
  the tree.
- `.svelte-kit/`, `build/`, `test-results/`, `playwright-report/`, `coverage/`
  — build output and run artifacts.
- `.claude/worktrees/` — other agents' checkouts, more than 1 GB.
- `.git/` — use `git` commands.
- `pnpm-lock.yaml`, `package-lock.json` — the lockfile is generated.
- `drizzle/*.sql` and `drizzle/meta/` — generated by `pnpm db:generate`. Read
  `src/lib/server/db/schema.ts` instead.
- `data/uploads/`, `data/test-uploads/` — user media at runtime.
- `src/lib/fonts/*.woff2`, `static/*.png`, `static/*.ico`,
  `tests/e2e/fixtures/*` — binary files.
- `.env`, `.env.test` — secrets. Read `.env.example` if you need the names of
  the variables.

If a task truly needs one of these paths, say why first, then read one file,
not the directory.

## Token economy

Context is a budget. Keep it small on purpose.

- Read a part, not the whole. Use `grep -rn` to find the line, then
  `sed -n '120,180p' <file>`. Open a full file only if it is short or you will
  change most of it.
- Search with a pattern, not with `ls -R` or `cat` of many files.
- Do not read a file again after you change it. The edit tools report a
  failure; silence is success.
- Do not repeat in your answer what a tool already showed. Give the result and
  the file path with the line number.
- While you work, run the narrow test: `pnpm vitest run --project unit <file>`
  or add `-t "<name>"`. Run the full `pnpm check`, `pnpm lint` and `pnpm test`
  one time, before you report the task complete.
- Give a noisy search (a sweep of many files, a log trawl) to a subagent and
  keep only its conclusion.
- Do not paste large code blocks into your answer. Point at the file.
- Plan one time. Do not write the plan again after each step.

## When to ask vs. decide

Ask first when a change touches:

- Authentication, authorization, or permission checks
- A public API contract, or a database schema or migration
- Personal data, credentials, or anything logged to a third party
- A new runtime dependency
- Scope beyond what was requested

Decide yourself on: naming, file placement within an existing convention,
control flow, local refactors, and test structure.

## Definition of done

Before reporting a task complete:

1. `pnpm check`, `pnpm lint`, and `pnpm test` pass.
2. New behavior has a test that fails without the change.
3. No secrets, keys, tokens, or real user data in code, tests, or fixtures.
4. The diff contains nothing unrelated to the task.

## Guardrails

- Do not commit, push, or open a PR unless asked.
- Do not run destructive database commands (drop, truncate, reset) against any
  environment, including local.
- Do not hand-edit `.env*`, lockfiles, or generated files.
- Do not disable a test, silence a type error, or add a lint-ignore to make a
  build pass. Fix the cause, or stop and explain why you can't.

## Agent routing

Subagents are defined in `.claude/agents/`. Delegate implementation by default:

- `ui-engineer` - Svelte, CSS, Tailwind, design tokens, layout, responsive behavior,
  component markup, accessibility.
- `backend-engineer`- API routes, services, schema and migrations, auth,
  background jobs, performance.
- `test-engineer` - unit and integration tests, fixtures, test utilities, claude-chrome.

Keep planning, task decomposition, cross-cutting decisions, and final review in
the main session. A subagent starts with no conversation history, so hand it the
file paths, the acceptance criteria, and any constraint it can't infer. Don't
delegate a change smaller than the cost of explaining it.

## Gotchas

- Schema changes need `pnpm db:generate`; the files in `drizzle/` are generated.
  Migrations are applied by `scripts/migrate.mjs`, never by `drizzle-kit push`.
- Browser tests run against `build/`, so run `pnpm build` first or the run uses
  the previous build.
- Accounts are created only by the `/register` action or the `ADMIN_*`
  bootstrap. `hooks.server.ts` answers 404 to Better Auth's own sign-up
  endpoint.
- `docs/` holds the long-form notes: `design-decisions.md` (architecture),
  `deployment.md`, `social-sign-in.md`, `measurements.md`.
