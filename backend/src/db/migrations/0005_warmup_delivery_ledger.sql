CREATE TABLE "warmup_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"schedule_date" text NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"warmup_day" integer NOT NULL,
	"planned_volume" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inboxes" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "status" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "delivery_key" text;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "slot_index" integer;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "smtp_response" text;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "receive_enqueued_at" timestamp;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "reply_message_id" text;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "reply_status" text;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "reply_filed_at" timestamp;--> statement-breakpoint
ALTER TABLE "warmup_schedules" ADD CONSTRAINT "warmup_schedules_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "warmup_schedules_inbox_date_policy_uq" ON "warmup_schedules" USING btree ("inbox_id","schedule_date","policy_version");--> statement-breakpoint
CREATE UNIQUE INDEX "warmup_sends_message_id_uq" ON "warmup_sends" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warmup_sends_delivery_key_uq" ON "warmup_sends" USING btree ("delivery_key");--> statement-breakpoint
CREATE UNIQUE INDEX "warmup_sends_schedule_slot_uq" ON "warmup_sends" USING btree ("schedule_id","slot_index");--> statement-breakpoint
CREATE INDEX "warmup_sends_receiver_inbox_id_idx" ON "warmup_sends" USING btree ("receiver_inbox_id");--> statement-breakpoint
CREATE INDEX "warmup_sends_receiver_pool_inbox_id_idx" ON "warmup_sends" USING btree ("receiver_pool_inbox_id");