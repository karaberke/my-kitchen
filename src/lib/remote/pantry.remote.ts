import { z } from 'zod';
import { command, query } from '$app/server';
import { remote } from '$lib/server/http';
import { pantryLotsFor } from '$lib/server/cooking';
import { scanBarcode } from '$lib/server/barcode/lookup';
import { undoFor } from '$lib/server/undo';

/** Lots of one ingredient in the active household, for cooking substitutions and manual lot choice. */
export const pantryLots = query(
	z.object({ ingredient: z.string(), unit: z.string().nullable(), convention: z.string() }),
	remote(pantryLotsFor)
);

/**
 * What one barcode means for the active household. A read: it may cache
 * provider metadata, but it never changes inventory.
 */
export const barcodeLookup = query(
	z.object({ code: z.string(), symbology: z.string().nullable() }),
	remote(scanBarcode)
);

/** Undo one pantry or grocery event with a compensating event. */
export const undo = command(
	z.object({ operationId: z.string(), eventId: z.string() }),
	remote(undoFor)
);
