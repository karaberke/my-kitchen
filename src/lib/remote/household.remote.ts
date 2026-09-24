import { z } from 'zod';
import { query } from '$app/server';
import { remote } from '$lib/server/http';
import { revisionsFor } from '$lib/server/households';

/** Tiny authorized poll target: the { pantry, grocery, plan } revision counters of a household. */
export const householdRevisions = query(
	z.object({ household: z.string().optional() }),
	remote(revisionsFor)
);
