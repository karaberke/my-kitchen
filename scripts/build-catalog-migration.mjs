#!/usr/bin/env node
/** Generates the SQL body for the catalog data migration from catalog-data.mjs. */
import { createHash } from 'node:crypto';
import { CATALOG } from './catalog-data.mjs';

const NAMESPACE = 'pantry-and-plate-catalog-v1';
function uuidV5(name) {
	const h = createHash('sha1').update(NAMESPACE).update(name).digest();
	h[6] = (h[6] & 0x0f) | 0x50;
	h[8] = (h[8] & 0x3f) | 0x80;
	const hex = h.subarray(0, 16).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
const norm = (s) =>
	s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const lines = ['-- Shared read-only ingredient catalog (owner_user_id is null). Idempotent.'];
lines.push(
	'INSERT INTO "ingredient" ("id", "owner_user_id", "name", "name_normalized", "category", "grams_per_ml") VALUES'
);
lines.push(
	CATALOG.map(
		([name, category, density]) =>
			`(${q(uuidV5(name))}, NULL, ${q(name)}, ${q(norm(name))}, ${q(category)}, ${density ? q(density) : 'NULL'})`
	).join(',\n')
);
lines.push(
	'ON CONFLICT ("owner_user_id", "name_normalized") DO UPDATE SET "category" = EXCLUDED."category", "grams_per_ml" = EXCLUDED."grams_per_ml";'
);
const aliasRows = [];
for (const [name, , , aliases] of CATALOG) {
	for (const alias of aliases) aliasRows.push(`(${q(uuidV5(name))}, ${q(norm(alias))})`);
}
lines.push('INSERT INTO "ingredient_alias" ("ingredient_id", "alias_normalized") VALUES');
lines.push(aliasRows.join(',\n'));
lines.push('ON CONFLICT ("ingredient_id", "alias_normalized") DO NOTHING;');
process.stdout.write(lines.join('\n') + '\n');
