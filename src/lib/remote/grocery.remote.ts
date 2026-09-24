import { z } from 'zod';
import { command } from '$app/server';
import { remote } from '$lib/server/http';
import { reopenListFor } from '$lib/server/grocery';

/** Revert an accidental completion of a grocery trip. */
export const reopenList = command(
	z.object({ listId: z.string(), expectedRevision: z.number() }),
	remote(reopenListFor)
);
