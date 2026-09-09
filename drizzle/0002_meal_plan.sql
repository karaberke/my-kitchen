CREATE TABLE "meal_plan_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"planned_on" date NOT NULL,
	"recipe_id" uuid,
	"title" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meal_plan_entry_title_chk" CHECK (length(btrim("meal_plan_entry"."title")) > 0)
);
--> statement-breakpoint
ALTER TABLE "household" ADD COLUMN "plan_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_plan_entry" ADD CONSTRAINT "meal_plan_entry_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_entry" ADD CONSTRAINT "meal_plan_entry_recipe_id_recipe_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipe"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meal_plan_entry" ADD CONSTRAINT "meal_plan_entry_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meal_plan_entry_household_date_idx" ON "meal_plan_entry" USING btree ("household_id","planned_on","created_at");