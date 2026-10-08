import { z } from 'zod';
import { command } from '$app/server';
import { remote } from '$lib/server/http';
import { reopenListFor } from '$lib/server/grocery';
import { tidyGroceryList as tidyGroceryListFor } from '$lib/server/llm/grocery';

/** Revert an accidental completion of a grocery trip. */
export const reopenList = command(
	z.object({ listId: z.string(), expectedRevision: z.number() }),
	remote(reopenListFor)
);

/**
 * Proposed tidier names, amounts and aisles for a list; saves nothing. A
 * command, not a query: it spends assistant quota, so it runs only when asked
 * and is never re-run by a refresh.
 */
export const tidyGroceryList = command(
	z.object({ listId: z.string() }),
	remote(tidyGroceryListFor)
);
