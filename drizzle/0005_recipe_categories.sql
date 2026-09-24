CREATE TABLE "recipe_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_category_id_household_uq" UNIQUE("id","household_id"),
	CONSTRAINT "recipe_category_name_trim_chk" CHECK ("recipe_category"."name" = btrim("recipe_category"."name")),
	CONSTRAINT "recipe_category_name_length_chk" CHECK (char_length("recipe_category"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "recipe_category_item" (
	"category_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_category_item_category_id_recipe_id_pk" PRIMARY KEY("category_id","recipe_id")
);
--> statement-breakpoint
ALTER TABLE "recipe_category" ADD CONSTRAINT "recipe_category_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_category_item" ADD CONSTRAINT "recipe_category_item_category_fk" FOREIGN KEY ("category_id","household_id") REFERENCES "public"."recipe_category"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_category_item" ADD CONSTRAINT "recipe_category_item_share_fk" FOREIGN KEY ("recipe_id","household_id") REFERENCES "public"."recipe_share"("recipe_id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_category_name_uq" ON "recipe_category" USING btree ("household_id",lower("name"));--> statement-breakpoint
CREATE INDEX "recipe_category_item_household_recipe_idx" ON "recipe_category_item" USING btree ("household_id","recipe_id");