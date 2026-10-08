CREATE INDEX "grocery_line_source_batch_idx" ON "grocery_line_source" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "inventory_event_operation_idx" ON "inventory_event" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "inventory_event_recipe_idx" ON "inventory_event" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "inventory_event_grocery_list_idx" ON "inventory_event" USING btree ("grocery_list_id");--> statement-breakpoint
CREATE INDEX "recipe_image_idx" ON "recipe" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "recipe_source_attachment_idx" ON "recipe" USING btree ("source_attachment_id");