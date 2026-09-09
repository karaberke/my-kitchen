import { sql } from 'drizzle-orm';
import { guard } from '$lib/server/http';
import type { RequestEvent } from './$types';
import { db } from '$lib/server/db';

/** Liveness + readiness: `?ready=1` also checks the database. */
const GETImpl = async ({ url }: RequestEvent) => {
	const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' };
	if (url.searchParams.get('ready') !== '1')
		return new Response(JSON.stringify({ status: 'ok' }), { headers });
	try {
		await db.execute(sql`select 1`);
		return new Response(JSON.stringify({ status: 'ready' }), { headers });
	} catch (err) {
		return new Response(
			JSON.stringify({ status: 'database unavailable', error: (err as Error).message }),
			{ status: 503, headers }
		);
	}
};

export const GET = guard(GETImpl);
