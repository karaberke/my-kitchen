#!/usr/bin/env node
/**
 * Maintenance: permanently delete a person and everything they made.
 *
 * Households they were in are handled first: one they were alone in is deleted
 * with all its pantry, lists and history; one with other people in it survives,
 * and if they were its only owner, ownership passes to the longest-standing
 * remaining member so it is never left ownerless.
 *
 * Usage:
 *   node --env-file=.env scripts/delete-user.mjs <email> [--dry-run] [--yes]
 *
 * --dry-run prints the plan and changes nothing. Without --yes you are asked to
 * retype the address. Reads DATABASE_URL, DATABASE_SSL, STORAGE_BACKEND, UPLOAD_DIR.
 */
import postgres from 'postgres';
import { createInterface } from 'node:readline/promises';
import { rm } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const email = args
	.find((a) => !a.startsWith('--'))
	?.trim()
	.toLowerCase();
const dryRun = args.includes('--dry-run');
const assumeYes = args.includes('--yes');

if (!email) {
	console.error('Usage: node --env-file=.env scripts/delete-user.mjs <email> [--dry-run] [--yes]');
	process.exit(2);
}
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
let exitCode = 0;

try {
	const [person] = await sql`
		select id, name, email from "user" where lower(email) = ${email} limit 1`;
	if (!person) {
		console.error(`No account with the address ${email}`);
		process.exit(1);
	}

	// What they belong to, and who else is in it.
	const memberships = await sql`
		select hm.household_id, h.name, hm.role,
		       (select count(*)::int from household_member m2
		         where m2.household_id = hm.household_id) as members,
		       (select count(*)::int from household_member m3
		         where m3.household_id = hm.household_id and m3.role = 'owner'
		           and m3.user_id <> ${person.id}) as other_owners
		from household_member hm
		join household h on h.id = hm.household_id
		where hm.user_id = ${person.id}
		order by h.created_at, h.id`;

	const toDelete = memberships.filter((m) => m.members === 1);
	const toTransfer = memberships.filter(
		(m) => m.members > 1 && m.role === 'owner' && m.other_owners === 0
	);
	const untouched = memberships.filter(
		(m) => m.members > 1 && !(m.role === 'owner' && m.other_owners === 0)
	);

	// Who inherits each household that needs a new owner: longest-standing member.
	const heirs = new Map();
	for (const m of toTransfer) {
		const [heir] = await sql`
			select hm.user_id, u.name, u.email
			from household_member hm join "user" u on u.id = hm.user_id
			where hm.household_id = ${m.household_id} and hm.user_id <> ${person.id}
			order by hm.created_at, hm.user_id limit 1`;
		heirs.set(m.household_id, heir);
	}

	const [counts] = await sql`
		select
			(select count(*)::int from recipe where owner_user_id = ${person.id}) as recipes,
			(select count(*)::int from image where owner_user_id = ${person.id}) as images,
			(select count(*)::int from recipe_attachment where owner_user_id = ${person.id}) as attachments,
			(select count(*)::int from ingredient where owner_user_id = ${person.id}) as ingredients`;

	/*
	 * Their private ingredients cascade away with them, but stock_lot and
	 * inventory_movement point at ingredients with ON DELETE RESTRICT. Anything
	 * still sitting in someone's pantry or history would abort the whole delete,
	 * so those become shared catalog entries (owner null) instead.
	 */
	const keepAsCatalog = await sql`
		select i.id, i.name from ingredient i
		where i.owner_user_id = ${person.id}
		  and (exists (select 1 from stock_lot s where s.ingredient_id = i.id)
		    or exists (select 1 from inventory_movement m where m.ingredient_id = i.id))
		order by i.name`;

	console.log(`\nAccount:  ${person.name} <${person.email}>`);
	console.log(
		`Deletes:  ${counts.recipes} recipes, ${counts.images} photos, ` +
			`${counts.attachments} imported files, ${counts.ingredients} private ingredients`
	);
	for (const m of toDelete)
		console.log(`Household "${m.name}": deleted entirely (they were its only member)`);
	for (const m of toTransfer) {
		const heir = heirs.get(m.household_id);
		console.log(`Household "${m.name}": kept, ownership passes to ${heir.name} <${heir.email}>`);
	}
	for (const m of untouched) console.log(`Household "${m.name}": kept, they were only a ${m.role}`);
	if (keepAsCatalog.length)
		console.log(
			`Kept:     ${keepAsCatalog.length} ingredient(s) still stocked elsewhere ` +
				`become shared catalog entries (${keepAsCatalog.map((i) => i.name).join(', ')})`
		);
	console.log('Kept:     cooking and purchase history, with their name recorded on it\n');

	if (dryRun) {
		console.log('--dry-run: nothing was changed.');
		await sql.end();
		process.exit(0);
	}

	if (!assumeYes) {
		if (!process.stdin.isTTY) {
			console.error('Refusing to delete without --yes when not run interactively.');
			process.exit(2);
		}
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const typed = await rl.question(`Type ${person.email} to confirm deletion: `);
		rl.close();
		if (typed.trim().toLowerCase() !== person.email.toLowerCase()) {
			console.error('Did not match. Nothing was deleted.');
			process.exit(1);
		}
	}

	// Collect object keys before the rows go, so the files can be removed after.
	const blobs = await sql`
		select object_key from image where owner_user_id = ${person.id}
		union all
		select object_key from recipe_attachment where owner_user_id = ${person.id}`;

	await sql.begin(async (tx) => {
		for (const m of toTransfer) {
			const heir = heirs.get(m.household_id);
			await tx`update household_member set role = 'owner'
			         where household_id = ${m.household_id} and user_id = ${heir.user_id}`;
		}
		for (const m of toDelete) {
			// inventory_movement.lot_id -> stock_lot is RESTRICT and the cascade order
			// is not guaranteed, so clear movements before the household goes.
			await tx`delete from inventory_movement where household_id = ${m.household_id}`;
			await tx`delete from household where id = ${m.household_id}`;
		}
		if (keepAsCatalog.length)
			await tx`update ingredient set owner_user_id = null
			         where id in ${tx(keepAsCatalog.map((i) => i.id))}`;
		await tx`delete from "user" where id = ${person.id}`;
	});

	console.log(`Deleted ${person.email}.`);

	// Photos and imported files live outside the database.
	const backend = (process.env.STORAGE_BACKEND ?? 'local').toLowerCase();
	const prefixes = [...new Set(blobs.map((b) => b.object_key.split('/').slice(0, 2).join('/')))];
	if (!prefixes.length) {
		// nothing stored
	} else if (backend === 'local') {
		const root = process.env.UPLOAD_DIR || './data/uploads';
		for (const prefix of prefixes)
			await rm(path.join(root, prefix), { recursive: true, force: true });
		console.log(`Removed ${prefixes.length} storage folder(s) under ${root}.`);
	} else {
		console.log(`\nStorage backend is "${backend}", so these prefixes were left in place.`);
		console.log('Delete them from your bucket:');
		for (const prefix of prefixes) console.log(`  ${prefix}/`);
	}
} catch (err) {
	console.error('delete-user failed:', err instanceof Error ? err.message : err);
	exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
}
process.exit(exitCode);
