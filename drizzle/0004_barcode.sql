CREATE TABLE "barcode_link" (
	"household_id" uuid NOT NULL,
	"gtin" text NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"default_quantity" numeric(14, 6),
	"default_unit" text,
	"default_package_count" integer DEFAULT 1 NOT NULL,
	"package_label_text" text DEFAULT '' NOT NULL,
	"origin" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "barcode_link_household_id_gtin_pk" PRIMARY KEY("household_id","gtin"),
	CONSTRAINT "barcode_link_origin_chk" CHECK ("barcode_link"."origin" in ('usda','off','manual')),
	CONSTRAINT "barcode_link_gtin_chk" CHECK ("barcode_link"."gtin" ~ '^[0-9]{14}$'),
	CONSTRAINT "barcode_link_package_count_chk" CHECK ("barcode_link"."default_package_count" between 1 and 999)
);
--> statement-breakpoint
CREATE TABLE "barcode_miss" (
	"gtin" text NOT NULL,
	"source" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "barcode_miss_gtin_source_pk" PRIMARY KEY("gtin","source"),
	CONSTRAINT "barcode_miss_source_chk" CHECK ("barcode_miss"."source" in ('usda','off')),
	CONSTRAINT "barcode_miss_gtin_chk" CHECK ("barcode_miss"."gtin" ~ '^[0-9]{14}$')
);
--> statement-breakpoint
CREATE TABLE "barcode_product_nutrient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"nutrient_id" integer,
	"nutrient_number" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"value" numeric(16, 6),
	"basis" text NOT NULL,
	CONSTRAINT "barcode_product_nutrient_basis_chk" CHECK ("barcode_product_nutrient"."basis" in ('serving','per_100g','per_100ml'))
);
--> statement-breakpoint
CREATE TABLE "barcode_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gtin" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_version" text,
	"source_date" date,
	"brand" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"package_amount" numeric(14, 6),
	"package_unit" text,
	"package_label_text" text DEFAULT '' NOT NULL,
	"serving_amount" numeric(14, 6),
	"serving_unit" text,
	"serving_basis" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "barcode_product_source_chk" CHECK ("barcode_product"."source" in ('usda','off')),
	CONSTRAINT "barcode_product_gtin_chk" CHECK ("barcode_product"."gtin" ~ '^[0-9]{14}$'),
	CONSTRAINT "barcode_product_serving_basis_chk" CHECK ("barcode_product"."serving_basis" is null or "barcode_product"."serving_basis" in ('serving','per_100g','per_100ml'))
);
--> statement-breakpoint
ALTER TABLE "barcode_link" ADD CONSTRAINT "barcode_link_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcode_link" ADD CONSTRAINT "barcode_link_ingredient_id_ingredient_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcode_link" ADD CONSTRAINT "barcode_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcode_product_nutrient" ADD CONSTRAINT "barcode_product_nutrient_product_id_barcode_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."barcode_product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "barcode_link_ingredient_idx" ON "barcode_link" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "barcode_miss_expires_idx" ON "barcode_miss" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "barcode_product_nutrient_uq" ON "barcode_product_nutrient" USING btree ("product_id","nutrient_number","basis");--> statement-breakpoint
CREATE UNIQUE INDEX "barcode_product_gtin_source_uq" ON "barcode_product" USING btree ("gtin","source");--> statement-breakpoint
CREATE INDEX "barcode_product_expires_idx" ON "barcode_product" USING btree ("expires_at");