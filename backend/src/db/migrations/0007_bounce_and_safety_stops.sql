CREATE TABLE "safety_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"key" text DEFAULT '*' NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"cleared_by" text,
	"cleared_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "bounced_at" timestamp;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "bounce_type" text;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD COLUMN "bounce_detail" text;--> statement-breakpoint
CREATE INDEX "safety_stops_scope_key_idx" ON "safety_stops" USING btree ("scope","key");