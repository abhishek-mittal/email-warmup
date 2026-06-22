CREATE TABLE "inbox_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid,
	"pool_inbox_id" uuid,
	"spf_valid" boolean,
	"dkim_valid" boolean,
	"dmarc_valid" boolean,
	"mx_valid" boolean,
	"rdns_valid" boolean,
	"placement_estimate" text,
	"health_score" integer,
	"issues" text[],
	"analysed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_inboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"display_name" text,
	"encrypted_credentials" jsonb NOT NULL,
	"last_used_at" timestamp,
	"active_pairs" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "warmup_sends" ALTER COLUMN "receiver_inbox_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "receiver_pool_inbox_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_inbox_analysis_inbox_id" ON "inbox_analysis" USING btree ("inbox_id");--> statement-breakpoint
CREATE INDEX "idx_inbox_analysis_pool_inbox_id" ON "inbox_analysis" USING btree ("pool_inbox_id");--> statement-breakpoint
CREATE INDEX "idx_pool_inboxes_user_id" ON "pool_inboxes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_pool_inboxes_status" ON "pool_inboxes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pool_inboxes_email" ON "pool_inboxes" USING btree ("email");