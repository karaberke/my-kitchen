CREATE TABLE "grocery_batch_requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"ingredient_id" uuid,
	"name" text NOT NULL,
	"base_amount" numeric(14, 6),
	"unit" text,
	"preparation" text DEFAULT '' NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"include" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grocery_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"recipe_id" uuid,
	"recipe_title" text NOT NULL,
	"recipe_revision" integer NOT NULL,
	"convention" text DEFAULT 'metric' NOT NULL,
	"base_servings" numeric(8, 3) NOT NULL,
	"servings" numeric(8, 3) NOT NULL,
	"fulfilled_servings" numeric(8, 3) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"client_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grocery_batch_status_chk" CHECK ("grocery_batch"."status" in ('planned','fulfilled'))
);
--> statement-breakpoint
CREATE TABLE "grocery_line_source" (
	"line_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"amount" numeric(14, 6),
	"unit" text,
	CONSTRAINT "grocery_line_source_line_id_batch_id_pk" PRIMARY KEY("line_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "grocery_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"plan_key" text,
	"ingredient_id" uuid,
	"name" text NOT NULL,
	"category" text DEFAULT 'Other' NOT NULL,
	"unit" text,
	"demand_amount" numeric(14, 6),
	"stock_considered" numeric(14, 6),
	"target_amount" numeric(14, 6),
	"purchased_amount" numeric(14, 6) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"unresolved_reason" text,
	"other_stock" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtract_pantry" boolean DEFAULT false NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grocery_line_kind_chk" CHECK ("grocery_line"."kind" in ('recipe','manual')),
	CONSTRAINT "grocery_line_status_chk" CHECK ("grocery_line"."status" in ('pending','purchased','handled'))
);
--> statement-breakpoint
CREATE TABLE "grocery_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"pantry_revision_at_preview" integer,
	"preview_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grocery_list_status_chk" CHECK ("grocery_list"."status" in ('draft','shopping','completed'))
);
--> statement-breakpoint
CREATE TABLE "household_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_member" (
	"household_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_member_household_id_user_id_pk" PRIMARY KEY("household_id","user_id"),
	CONSTRAINT "household_member_role_chk" CHECK ("household_member"."role" in ('owner','member'))
);
--> statement-breakpoint
CREATE TABLE "household" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"pantry_revision" integer DEFAULT 0 NOT NULL,
	"grocery_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"backend" text NOT NULL,
	"object_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"variants" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingredient_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"alias_normalized" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"category" text DEFAULT 'Other' NOT NULL,
	"grams_per_ml" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingredient_owner_name_uq" UNIQUE NULLS NOT DISTINCT("owner_user_id","name_normalized")
);
--> statement-breakpoint
CREATE TABLE "inventory_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" text,
	"actor_name" text DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation_id" uuid,
	"recipe_id" uuid,
	"recipe_title" text,
	"recipe_revision" integer,
	"servings" numeric(8, 3),
	"batch_id" uuid,
	"planned_servings_fulfilled" numeric(8, 3),
	"unplanned_servings" numeric(8, 3),
	"grocery_list_id" uuid,
	"reverses_event_id" uuid,
	"reversed_by_event_id" uuid,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "inventory_event_kind_chk" CHECK ("inventory_event"."kind" in ('purchase','cook','add_stock','correction','waste','undo'))
);
--> statement-breakpoint
CREATE TABLE "inventory_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"delta" numeric(14, 6) NOT NULL,
	"unit" text NOT NULL,
	"balance_after" numeric(14, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"amount" numeric(14, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_favorite" (
	"user_id" text NOT NULL,
	"recipe_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_favorite_user_id_recipe_id_pk" PRIMARY KEY("user_id","recipe_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"group_name" text DEFAULT '' NOT NULL,
	"ingredient_id" uuid,
	"name" text NOT NULL,
	"amount" numeric(14, 6),
	"unit" text,
	"preparation" text DEFAULT '' NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	CONSTRAINT "recipe_ingredient_amount_chk" CHECK ("recipe_ingredient"."amount" is null or "recipe_ingredient"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_share" (
	"recipe_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_share_recipe_id_household_id_pk" PRIMARY KEY("recipe_id","household_id")
);
--> statement-breakpoint
CREATE TABLE "recipe_step" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"section_title" text DEFAULT '' NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"base_servings" numeric(8, 3),
	"yield_note" text DEFAULT '' NOT NULL,
	"prep_minutes" integer,
	"cook_minutes" integer,
	"source" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"convention" text DEFAULT 'metric' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"image_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_recipe_id" uuid,
	"source_attribution" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_status_chk" CHECK ("recipe"."status" in ('draft','active','archived')),
	CONSTRAINT "recipe_servings_chk" CHECK ("recipe"."base_servings" is null or "recipe"."base_servings" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_lot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity" numeric(14, 6) NOT NULL,
	"unit" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"expires_on" date,
	"note" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_lot_quantity_chk" CHECK ("stock_lot"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_preference" (
	"user_id" text PRIMARY KEY NOT NULL,
	"active_household_id" uuid,
	"convention" text DEFAULT 'metric' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grocery_batch_requirement" ADD CONSTRAINT "grocery_batch_requirement_batch_id_grocery_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."grocery_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_batch_requirement" ADD CONSTRAINT "grocery_batch_requirement_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_batch" ADD CONSTRAINT "grocery_batch_list_id_grocery_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."grocery_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_batch" ADD CONSTRAINT "grocery_batch_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_line_source" ADD CONSTRAINT "grocery_line_source_line_id_grocery_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."grocery_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_line_source" ADD CONSTRAINT "grocery_line_source_batch_id_grocery_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."grocery_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_line" ADD CONSTRAINT "grocery_line_list_id_grocery_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."grocery_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_line" ADD CONSTRAINT "grocery_line_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_list" ADD CONSTRAINT "grocery_list_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_list" ADD CONSTRAINT "grocery_list_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invite" ADD CONSTRAINT "household_invite_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invite" ADD CONSTRAINT "household_invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invite" ADD CONSTRAINT "household_invite_used_by_user_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_member" ADD CONSTRAINT "household_member_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_member" ADD CONSTRAINT "household_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image" ADD CONSTRAINT "image_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient_alias" ADD CONSTRAINT "ingredient_alias_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingredient" ADD CONSTRAINT "ingredient_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event" ADD CONSTRAINT "inventory_event_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event" ADD CONSTRAINT "inventory_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event" ADD CONSTRAINT "inventory_event_operation_id_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event" ADD CONSTRAINT "inventory_event_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event" ADD CONSTRAINT "inventory_event_batch_id_grocery_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."grocery_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_event" ADD CONSTRAINT "inventory_event_grocery_list_id_grocery_list_id_fk" FOREIGN KEY ("grocery_list_id") REFERENCES "public"."grocery_list"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_event_id_inventory_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."inventory_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_lot_id_stock_lot_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_allocation" ADD CONSTRAINT "purchase_allocation_event_id_inventory_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."inventory_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_allocation" ADD CONSTRAINT "purchase_allocation_line_id_grocery_line_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."grocery_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_favorite" ADD CONSTRAINT "recipe_favorite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_favorite" ADD CONSTRAINT "recipe_favorite_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredient" ADD CONSTRAINT "recipe_ingredient_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_share" ADD CONSTRAINT "recipe_share_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_share" ADD CONSTRAINT "recipe_share_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_step" ADD CONSTRAINT "recipe_step_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_image_id_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lot" ADD CONSTRAINT "stock_lot_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_active_household_id_household_id_fk" FOREIGN KEY ("active_household_id") REFERENCES "public"."household"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grocery_batch_requirement_position_uq" ON "grocery_batch_requirement" USING btree ("batch_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "grocery_batch_client_key_uq" ON "grocery_batch" USING btree ("list_id","client_key");--> statement-breakpoint
CREATE INDEX "grocery_batch_list_idx" ON "grocery_batch" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "grocery_batch_recipe_idx" ON "grocery_batch" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "grocery_line_list_status_idx" ON "grocery_line" USING btree ("list_id","status","position");--> statement-breakpoint
CREATE UNIQUE INDEX "grocery_line_plan_key_uq" ON "grocery_line" USING btree ("list_id","plan_key");--> statement-breakpoint
CREATE INDEX "grocery_list_household_status_idx" ON "grocery_list" USING btree ("household_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "household_invite_token_uq" ON "household_invite" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "household_invite_household_idx" ON "household_invite" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "household_member_user_idx" ON "household_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "image_owner_idx" ON "image" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingredient_alias_uq" ON "ingredient_alias" USING btree ("ingredient_id","alias_normalized");--> statement-breakpoint
CREATE INDEX "ingredient_alias_prefix_idx" ON "ingredient_alias" USING btree ("alias_normalized" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "ingredient_name_prefix_idx" ON "ingredient" USING btree ("name_normalized" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "ingredient_owner_idx" ON "ingredient" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "inventory_event_household_time_idx" ON "inventory_event" USING btree ("household_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_event_reverses_uq" ON "inventory_event" USING btree ("reverses_event_id");--> statement-breakpoint
CREATE INDEX "inventory_event_batch_idx" ON "inventory_event" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "inventory_movement_lot_idx" ON "inventory_movement" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "inventory_movement_event_idx" ON "inventory_movement" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "inventory_movement_household_time_idx" ON "inventory_movement" USING btree ("household_id","created_at","id");--> statement-breakpoint
CREATE INDEX "operation_user_created_idx" ON "operation" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_allocation_event_line_uq" ON "purchase_allocation" USING btree ("event_id","line_id");--> statement-breakpoint
CREATE INDEX "purchase_allocation_line_idx" ON "purchase_allocation" USING btree ("line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_ingredient_position_uq" ON "recipe_ingredient" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "recipe_ingredient_ingredient_idx" ON "recipe_ingredient" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "recipe_share_household_idx" ON "recipe_share" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_step_position_uq" ON "recipe_step" USING btree ("recipe_id","position");--> statement-breakpoint
CREATE INDEX "recipe_owner_updated_idx" ON "recipe" USING btree ("owner_user_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "recipe_tags_gin_idx" ON "recipe" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "stock_lot_household_ingredient_idx" ON "stock_lot" USING btree ("household_id","ingredient_id");--> statement-breakpoint
CREATE INDEX "stock_lot_household_active_idx" ON "stock_lot" USING btree ("household_id","expires_on") WHERE "stock_lot"."quantity" > 0;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");