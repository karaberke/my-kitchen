#!/usr/bin/env node
/**
 * Maintenance: compare current lot balances with the append-only movement log
 * and purchase credits with allocations. Read-only. Exit code 1 on mismatch.
 * Usage: node scripts/consistency-check.mjs   (reads DATABASE_URL)
 */
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set');
	process.exit(2);
}
const ssl = process.env.DATABASE_SSL
	? process.env.DATABASE_SSL === 'require'
		? 'require'
		: { rejectUnauthorized: false }
	: undefined;
const sql = postgres(url, { max: 1, ssl, onnotice: () => {} });
try {
	const lots = await sql`
		select l.id, l.household_id, l.quantity, coalesce(sum(m.delta), 0) as movement_sum
		from stock_lot l left join inventory_movement m on m.lot_id = l.id
		group by l.id having l.quantity <> coalesce(sum(m.delta), 0)`;
	const lines = await sql`
		select g.id, g.purchased_amount, coalesce(sum(a.amount), 0) as allocation_sum
		from grocery_line g left join purchase_allocation a on a.line_id = g.id
		group by g.id having g.purchased_amount <> coalesce(sum(a.amount), 0)`;
	const [{ count }] = await sql`select count(*)::int as count from stock_lot`;
	console.log(
		`lots checked: ${count}; lot mismatches: ${lots.length}; line credit mismatches: ${lines.length}`
	);
	for (const l of lots)
		console.log(
			`  lot ${l.id} household ${l.household_id}: balance ${l.quantity} vs movements ${l.movement_sum}`
		);
	for (const g of lines)
		console.log(
			`  line ${g.id}: purchased ${g.purchased_amount} vs allocations ${g.allocation_sum}`
		);
	process.exitCode = lots.length || lines.length ? 1 : 0;
} finally {
	await sql.end();
}
