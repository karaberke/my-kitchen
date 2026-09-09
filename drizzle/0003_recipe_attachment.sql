CREATE TABLE "recipe_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"backend" text NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"page_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recipe" ADD COLUMN "source_attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "recipe_attachment" ADD CONSTRAINT "recipe_attachment_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_attachment_owner_idx" ON "recipe_attachment" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "recipe" ADD CONSTRAINT "recipe_source_attachment_id_recipe_attachment_id_fk" FOREIGN KEY ("source_attachment_id") REFERENCES "public"."recipe_attachment"("id") ON DELETE set null ON UPDATE no action;