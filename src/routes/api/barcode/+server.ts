import type { RequestEvent } from './$types';
import { assertMember, requireHousehold } from '$lib/server/access';
import { db } from '$lib/server/db';
import { AppError } from '$lib/server/errors';
import { guard, noStoreJson } from '$lib/server/http';
import { BARCODE_LIMITS, consume } from '$lib/server/ratelimit';
import { lookupBarcode } from '$lib/server/barcode/lookup';
import { suggestionFor } from '$lib/server/barcode/suggest';
import { identifyAs, identifyManual, SYMBOLOGIES, type Symbology } from '$lib/shared/gtin';

/**
 * What one barcode means, for the household the caller is signed in to.
 *
 * The lookup is a read: it may cache provider metadata, but it never changes
 * inventory and never writes anything personal. The number is validated here,
 * on the server, whatever the phone believed it had decoded.
 */
const GETImpl = async (event: RequestEvent) => {
	const { user, household } = requireHousehold(event);
	await assertMember(db, household.id, user.id);

	const limit = consume(`barcode:${user.id}`, BARCODE_LIMITS.lookup);
	if (!limit.allowed)
		throw new AppError(429, `Too many scans. Try again in ${limit.retryAfterSeconds} seconds.`);

	const code = (event.url.searchParams.get('code') ?? '').slice(0, 40);
	const raw = event.url.searchParams.get('symbology');
	const symbology = SYMBOLOGIES.includes(raw as Symbology) ? (raw as Symbology) : null;

	// A decoder reports the format it read, so the code is held to it. A typed
	// number has no format, and eight digits then need an explicit answer.
	const identified = symbology ? identifyAs(code, symbology) : identifyManual(code);
	if (!identified.ok)
		return noStoreJson(
			{ ok: false, reason: identified.reason, message: identified.message },
			{ status: identified.reason === 'ambiguous_length' ? 409 : 400 }
		);

	const lookup = await lookupBarcode(identified.identity, household.id);
	return noStoreJson({ ok: true, lookup, suggestion: suggestionFor(lookup) });
};

export const GET = guard(GETImpl);
