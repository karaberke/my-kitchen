#!/usr/bin/env node
/** Runs EXPLAIN (ANALYZE, BUFFERS) for representative queries against the seeded database. */
import postgres from 'postgres';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const sql = postgres(url, { max: 1, onnotice: () => {} });
const [u] = await sql`select id from "user" where email = 'perf1@example.test'`;
if (!u) {
	console.error('run scripts/seed-perf.mjs first');
	process.exit(1);
}
const [h] = await sql`select household_id from household_member where user_id = ${u.id} limit 1`;
const queries = {
	'membership lookup': sql`explain (analyze, buffers) select role from household_member where household_id = ${h.household_id} and user_id = ${u.id}`,
	'recipe list page (readable, ordered, limit 24)': sql`explain (analyze, buffers) select r.id, r.title from recipe r where (r.owner_user_id = ${u.id} or exists (select 1 from recipe_share rs join household_member hm on hm.household_id = rs.household_id where rs.recipe_id = r.id and hm.user_id = ${u.id})) and r.status in ('active','draft') order by r.updated_at desc, r.id desc limit 24`,
	'pantry overview (active lots by ingredient)': sql`explain (analyze, buffers) select l.id, i.name from stock_lot l join ingredient i on i.id = l.ingredient_id where l.household_id = ${h.household_id} and l.quantity > 0 order by i.name_normalized, l.expires_on asc nulls last, l.created_at`,
	'shopping list lines': sql`explain (analyze, buffers) select * from grocery_line where list_id = (select id from grocery_list where household_id = ${h.household_id} order by updated_at desc limit 1) order by category, position, name, id`,
	'history page': sql`explain (analyze, buffers) select * from inventory_event where household_id = ${h.household_id} order by occurred_at desc, id desc limit 31`,
	'ingredient autocomplete prefix': sql`explain (analyze, buffers) select id, name from ingredient where (owner_user_id is null or owner_user_id = ${u.id}) and name_normalized like 'chi%' order by name_normalized limit 8`
};
for (const [name, q] of Object.entries(queries)) {
	console.log(`\n== ${name}`);
	for (const row of await q) console.log('  ' + row['QUERY PLAN']);
}
await sql.end();
