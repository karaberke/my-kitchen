import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { user } from './auth.schema';

export * from './auth.schema';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const qty = (name: string) => numeric(name, { precision: 14, scale: 6 });
const servingsCol = (name: string) => numeric(name, { precision: 8, scale: 3 });

export type HouseholdRole = 'owner' | 'member';
export type RecipeStatus = 'draft' | 'active' | 'archived';
export type ListStatus = 'draft' | 'shopping' | 'completed';
export type LineKind = 'recipe' | 'manual';
export type LineStatus = 'pending' | 'purchased' | 'handled';
export type BatchStatus = 'planned' | 'fulfilled';
export type EventKind = 'purchase' | 'cook' | 'add_stock' | 'correction' | 'waste' | 'undo';
export type StorageBackend = 'local' | 's3';

/* ------------------------------------------------------------------------ */
/* Households and membership                                                 */
/* ------------------------------------------------------------------------ */

export const households = pgTable('household', {
	id: uuid('id').primaryKey().defaultRandom(),
	name: text('name').notNull(),
	/** bumped in the same transaction as any pantry mutation; polled by clients */
	pantryRevision: integer('pantry_revision').notNull().default(0),
	/** bumped in the same transaction as any grocery list mutation */
	groceryRevision: integer('grocery_revision').notNull().default(0),
	createdAt: timestamptz('created_at').notNull().defaultNow()
});

export const householdMembers = pgTable(
	'household_member',
	{
		householdId: uuid('household_id')
			.notNull()
			.references(() => households.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role').$type<HouseholdRole>().notNull(),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [
		primaryKey({ columns: [t.householdId, t.userId] }),
		index('household_member_user_idx').on(t.userId),
		check('household_member_role_chk', sql`${t.role} in ('owner','member')`)
	]
);

export const householdInvites = pgTable(
	'household_invite',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		householdId: uuid('household_id')
			.notNull()
			.references(() => households.id, { onDelete: 'cascade' }),
		tokenHash: text('token_hash').notNull(),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		expiresAt: timestamptz('expires_at').notNull(),
		usedAt: timestamptz('used_at'),
		usedBy: text('used_by').references(() => user.id, { onDelete: 'set null' }),
		revokedAt: timestamptz('revoked_at'),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('household_invite_token_uq').on(t.tokenHash),
		index('household_invite_household_idx').on(t.householdId)
	]
);

export const userPreferences = pgTable('user_preference', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	activeHouseholdId: uuid('active_household_id').references(() => households.id, {
		onDelete: 'set null'
	}),
	convention: text('convention').notNull().default('metric'),
	updatedAt: timestamptz('updated_at').notNull().defaultNow()
});

/* ------------------------------------------------------------------------ */
/* Ingredient identities                                                     */
/* ------------------------------------------------------------------------ */

export const ingredients = pgTable(
	'ingredient',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/** null = read-only shared catalog entry */
		ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		nameNormalized: text('name_normalized').notNull(),
		category: text('category').notNull().default('Other'),
		/** explicit ingredient-specific density enabling volume<->mass conversion */
		gramsPerMl: numeric('grams_per_ml', { precision: 10, scale: 6 }),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [
		unique('ingredient_owner_name_uq').on(t.ownerUserId, t.nameNormalized).nullsNotDistinct(),
		index('ingredient_name_prefix_idx').on(t.nameNormalized.op('text_pattern_ops')),
		index('ingredient_owner_idx').on(t.ownerUserId)
	]
);

export const ingredientAliases = pgTable(
	'ingredient_alias',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ingredientId: uuid('ingredient_id')
			.notNull()
			.references(() => ingredients.id, { onDelete: 'cascade' }),
		aliasNormalized: text('alias_normalized').notNull()
	},
	(t) => [
		uniqueIndex('ingredient_alias_uq').on(t.ingredientId, t.aliasNormalized),
		index('ingredient_alias_prefix_idx').on(t.aliasNormalized.op('text_pattern_ops'))
	]
);

/* ------------------------------------------------------------------------ */
/* Media                                                                     */
/* ------------------------------------------------------------------------ */

export const images = pgTable(
	'image',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerUserId: text('owner_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		backend: text('backend').$type<StorageBackend>().notNull(),
		/** opaque versioned key prefix; variants live at `${key}/original|detail|thumb.<ext>` */
		objectKey: text('object_key').notNull(),
		version: integer('version').notNull().default(1),
		mime: text('mime').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		variants: jsonb('variants')
			.$type<Record<string, { width: number; height: number; bytes: number; mime: string }>>()
			.notNull(),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [index('image_owner_idx').on(t.ownerUserId)]
);

/* ------------------------------------------------------------------------ */
/* Recipes                                                                   */
/* ------------------------------------------------------------------------ */

export const recipes = pgTable(
	'recipe',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerUserId: text('owner_user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		description: text('description').notNull().default(''),
		baseServings: servingsCol('base_servings'),
		yieldNote: text('yield_note').notNull().default(''),
		prepMinutes: integer('prep_minutes'),
		cookMinutes: integer('cook_minutes'),
		source: text('source').notNull().default(''),
		notes: text('notes').notNull().default(''),
		tags: text('tags')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		convention: text('convention').notNull().default('metric'),
		status: text('status').$type<RecipeStatus>().notNull().default('draft'),
		imageId: uuid('image_id').references(() => images.id, { onDelete: 'set null' }),
		revision: integer('revision').notNull().default(1),
		sourceRecipeId: uuid('source_recipe_id'),
		sourceAttribution: text('source_attribution').notNull().default(''),
		createdAt: timestamptz('created_at').notNull().defaultNow(),
		updatedAt: timestamptz('updated_at').notNull().defaultNow()
	},
	(t) => [
		index('recipe_owner_updated_idx').on(t.ownerUserId, t.updatedAt, t.id),
		index('recipe_tags_gin_idx').using('gin', t.tags),
		check('recipe_status_chk', sql`${t.status} in ('draft','active','archived')`),
		check('recipe_servings_chk', sql`${t.baseServings} is null or ${t.baseServings} > 0`)
	]
);

export const recipeIngredients = pgTable(
	'recipe_ingredient',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		recipeId: uuid('recipe_id')
			.notNull()
			.references(() => recipes.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		groupName: text('group_name').notNull().default(''),
		ingredientId: uuid('ingredient_id').references(() => ingredients.id, { onDelete: 'set null' }),
		name: text('name').notNull(),
		amount: qty('amount'),
		unit: text('unit'),
		preparation: text('preparation').notNull().default(''),
		optional: boolean('optional').notNull().default(false)
	},
	(t) => [
		uniqueIndex('recipe_ingredient_position_uq').on(t.recipeId, t.position),
		index('recipe_ingredient_ingredient_idx').on(t.ingredientId),
		check('recipe_ingredient_amount_chk', sql`${t.amount} is null or ${t.amount} >= 0`)
	]
);

export const recipeSteps = pgTable(
	'recipe_step',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		recipeId: uuid('recipe_id')
			.notNull()
			.references(() => recipes.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		sectionTitle: text('section_title').notNull().default(''),
		text: text('text').notNull()
	},
	(t) => [uniqueIndex('recipe_step_position_uq').on(t.recipeId, t.position)]
);

export const recipeShares = pgTable(
	'recipe_share',
	{
		recipeId: uuid('recipe_id')
			.notNull()
			.references(() => recipes.id, { onDelete: 'cascade' }),
		householdId: uuid('household_id')
			.notNull()
			.references(() => households.id, { onDelete: 'cascade' }),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [
		primaryKey({ columns: [t.recipeId, t.householdId] }),
		index('recipe_share_household_idx').on(t.householdId)
	]
);

export const recipeFavorites = pgTable(
	'recipe_favorite',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		recipeId: uuid('recipe_id')
			.notNull()
			.references(() => recipes.id, { onDelete: 'cascade' }),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [primaryKey({ columns: [t.userId, t.recipeId] })]
);

/* ------------------------------------------------------------------------ */
/* Pantry                                                                    */
/* ------------------------------------------------------------------------ */

export const stockLots = pgTable(
	'stock_lot',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		householdId: uuid('household_id')
			.notNull()
			.references(() => households.id, { onDelete: 'cascade' }),
		ingredientId: uuid('ingredient_id')
			.notNull()
			.references(() => ingredients.id, { onDelete: 'restrict' }),
		quantity: qty('quantity').notNull(),
		unit: text('unit').notNull(),
		location: text('location').notNull().default(''),
		/** user-entered calendar date, never a timestamp */
		expiresOn: date('expires_on', { mode: 'string' }),
		note: text('note').notNull().default(''),
		revision: integer('revision').notNull().default(1),
		createdAt: timestamptz('created_at').notNull().defaultNow(),
		updatedAt: timestamptz('updated_at').notNull().defaultNow()
	},
	(t) => [
		index('stock_lot_household_ingredient_idx').on(t.householdId, t.ingredientId),
		index('stock_lot_household_active_idx')
			.on(t.householdId, t.expiresOn)
			.where(sql`${t.quantity} > 0`),
		check('stock_lot_quantity_chk', sql`${t.quantity} >= 0`)
	]
);

/** Client-supplied operation ids give every mutation exactly-once semantics. */
export const operations = pgTable(
	'operation',
	{
		id: uuid('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		kind: text('kind').notNull(),
		fingerprint: text('fingerprint').notNull(),
		result: jsonb('result').notNull(),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [index('operation_user_created_idx').on(t.userId, t.createdAt)]
);

/* ------------------------------------------------------------------------ */
/* Grocery planning                                                          */
/* ------------------------------------------------------------------------ */

export const groceryLists = pgTable(
	'grocery_list',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		householdId: uuid('household_id')
			.notNull()
			.references(() => households.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		status: text('status').$type<ListStatus>().notNull().default('draft'),
		revision: integer('revision').notNull().default(1),
		/** household pantry revision the last preview was computed against */
		pantryRevisionAtPreview: integer('pantry_revision_at_preview'),
		previewAt: timestamptz('preview_at'),
		startedAt: timestamptz('started_at'),
		completedAt: timestamptz('completed_at'),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: timestamptz('created_at').notNull().defaultNow(),
		updatedAt: timestamptz('updated_at').notNull().defaultNow()
	},
	(t) => [
		index('grocery_list_household_status_idx').on(t.householdId, t.status, t.updatedAt),
		check('grocery_list_status_chk', sql`${t.status} in ('draft','shopping','completed')`)
	]
);

export const groceryBatches = pgTable(
	'grocery_batch',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		listId: uuid('list_id')
			.notNull()
			.references(() => groceryLists.id, { onDelete: 'cascade' }),
		recipeId: uuid('recipe_id').references(() => recipes.id, { onDelete: 'set null' }),
		recipeTitle: text('recipe_title').notNull(),
		recipeRevision: integer('recipe_revision').notNull(),
		convention: text('convention').notNull().default('metric'),
		baseServings: servingsCol('base_servings').notNull(),
		servings: servingsCol('servings').notNull(),
		fulfilledServings: servingsCol('fulfilled_servings').notNull().default('0'),
		status: text('status').$type<BatchStatus>().notNull().default('planned'),
		/** idempotency key so a repeated request cannot add the batch twice */
		clientKey: text('client_key').notNull(),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('grocery_batch_client_key_uq').on(t.listId, t.clientKey),
		index('grocery_batch_list_idx').on(t.listId),
		index('grocery_batch_recipe_idx').on(t.recipeId),
		check('grocery_batch_status_chk', sql`${t.status} in ('planned','fulfilled')`)
	]
);

export const groceryBatchRequirements = pgTable(
	'grocery_batch_requirement',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		batchId: uuid('batch_id')
			.notNull()
			.references(() => groceryBatches.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		ingredientId: uuid('ingredient_id').references(() => ingredients.id, { onDelete: 'set null' }),
		name: text('name').notNull(),
		baseAmount: qty('base_amount'),
		unit: text('unit'),
		preparation: text('preparation').notNull().default(''),
		optional: boolean('optional').notNull().default(false),
		include: boolean('include').notNull().default(true)
	},
	(t) => [uniqueIndex('grocery_batch_requirement_position_uq').on(t.batchId, t.position)]
);

export const groceryLines = pgTable(
	'grocery_line',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		listId: uuid('list_id')
			.notNull()
			.references(() => groceryLists.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<LineKind>().notNull(),
		/** stable key from the planner so recalculation keeps line identity */
		planKey: text('plan_key'),
		ingredientId: uuid('ingredient_id').references(() => ingredients.id, { onDelete: 'set null' }),
		name: text('name').notNull(),
		category: text('category').notNull().default('Other'),
		unit: text('unit'),
		/** original aggregated recipe demand (recipe lines) or requested amount (manual lines) */
		demandAmount: qty('demand_amount'),
		stockConsidered: qty('stock_considered'),
		/** suggested (draft) or committed (shopping) purchase target */
		targetAmount: qty('target_amount'),
		purchasedAmount: qty('purchased_amount').notNull().default('0'),
		status: text('status').$type<LineStatus>().notNull().default('pending'),
		unresolvedReason: text('unresolved_reason'),
		otherStock: jsonb('other_stock')
			.$type<{ quantity: string; unit: string }[]>()
			.notNull()
			.default([]),
		subtractPantry: boolean('subtract_pantry').notNull().default(false),
		note: text('note').notNull().default(''),
		position: integer('position').notNull().default(0),
		revision: integer('revision').notNull().default(1),
		createdAt: timestamptz('created_at').notNull().defaultNow(),
		updatedAt: timestamptz('updated_at').notNull().defaultNow()
	},
	(t) => [
		index('grocery_line_list_status_idx').on(t.listId, t.status, t.position),
		uniqueIndex('grocery_line_plan_key_uq').on(t.listId, t.planKey),
		check('grocery_line_kind_chk', sql`${t.kind} in ('recipe','manual')`),
		check('grocery_line_status_chk', sql`${t.status} in ('pending','purchased','handled')`)
	]
);

export const groceryLineSources = pgTable(
	'grocery_line_source',
	{
		lineId: uuid('line_id')
			.notNull()
			.references(() => groceryLines.id, { onDelete: 'cascade' }),
		batchId: uuid('batch_id')
			.notNull()
			.references(() => groceryBatches.id, { onDelete: 'cascade' }),
		amount: qty('amount'),
		unit: text('unit')
	},
	(t) => [primaryKey({ columns: [t.lineId, t.batchId] })]
);

/* ------------------------------------------------------------------------ */
/* Inventory events, movements, allocations                                  */
/* ------------------------------------------------------------------------ */

export const inventoryEvents = pgTable(
	'inventory_event',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		householdId: uuid('household_id')
			.notNull()
			.references(() => households.id, { onDelete: 'cascade' }),
		kind: text('kind').$type<EventKind>().notNull(),
		actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
		actorName: text('actor_name').notNull().default(''),
		occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
		operationId: uuid('operation_id').references(() => operations.id, { onDelete: 'set null' }),
		recipeId: uuid('recipe_id').references(() => recipes.id, { onDelete: 'set null' }),
		recipeTitle: text('recipe_title'),
		recipeRevision: integer('recipe_revision'),
		servings: servingsCol('servings'),
		batchId: uuid('batch_id').references(() => groceryBatches.id, { onDelete: 'set null' }),
		plannedServingsFulfilled: servingsCol('planned_servings_fulfilled'),
		unplannedServings: servingsCol('unplanned_servings'),
		groceryListId: uuid('grocery_list_id').references(() => groceryLists.id, {
			onDelete: 'set null'
		}),
		/** an event may be reversed at most once (unique) */
		reversesEventId: uuid('reverses_event_id'),
		reversedByEventId: uuid('reversed_by_event_id'),
		summary: text('summary').notNull(),
		details: jsonb('details').$type<Record<string, unknown>>().notNull().default({})
	},
	(t) => [
		index('inventory_event_household_time_idx').on(t.householdId, t.occurredAt, t.id),
		uniqueIndex('inventory_event_reverses_uq').on(t.reversesEventId),
		index('inventory_event_batch_idx').on(t.batchId),
		check(
			'inventory_event_kind_chk',
			sql`${t.kind} in ('purchase','cook','add_stock','correction','waste','undo')`
		)
	]
);

export const inventoryMovements = pgTable(
	'inventory_movement',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		eventId: uuid('event_id')
			.notNull()
			.references(() => inventoryEvents.id, { onDelete: 'cascade' }),
		householdId: uuid('household_id')
			.notNull()
			.references(() => households.id, { onDelete: 'cascade' }),
		lotId: uuid('lot_id')
			.notNull()
			.references(() => stockLots.id, { onDelete: 'restrict' }),
		ingredientId: uuid('ingredient_id')
			.notNull()
			.references(() => ingredients.id, { onDelete: 'restrict' }),
		delta: qty('delta').notNull(),
		unit: text('unit').notNull(),
		balanceAfter: qty('balance_after').notNull(),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [
		index('inventory_movement_lot_idx').on(t.lotId),
		index('inventory_movement_event_idx').on(t.eventId),
		index('inventory_movement_household_time_idx').on(t.householdId, t.createdAt, t.id)
	]
);

export const purchaseAllocations = pgTable(
	'purchase_allocation',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		eventId: uuid('event_id')
			.notNull()
			.references(() => inventoryEvents.id, { onDelete: 'cascade' }),
		lineId: uuid('line_id')
			.notNull()
			.references(() => groceryLines.id, { onDelete: 'cascade' }),
		/** credited amount in the line's unit; negative for undo */
		amount: qty('amount').notNull(),
		createdAt: timestamptz('created_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('purchase_allocation_event_line_uq').on(t.eventId, t.lineId),
		index('purchase_allocation_line_idx').on(t.lineId)
	]
);
