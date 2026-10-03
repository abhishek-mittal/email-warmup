CREATE TABLE "placement_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_id" uuid NOT NULL,
	"seed_inbox_id" uuid NOT NULL,
	"seed_email" text NOT NULL,
	"provider" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"detail" text,
	"observed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "placement_tests" ALTER COLUMN "completed_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "placement_tests" ALTER COLUMN "completed_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD COLUMN "status" text DEFAULT 'complete' NOT NULL;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD COLUMN "started_at" timestamp;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD COLUMN "observed_count" integer;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD COLUMN "other_inbox_count" integer;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD COLUMN "error_count" integer;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "seed_inboxes" ADD COLUMN "last_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "seed_inboxes" ADD COLUMN "last_ok_at" timestamp;--> statement-breakpoint
ALTER TABLE "seed_inboxes" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "seed_inboxes" ADD COLUMN "quarantined_at" timestamp;--> statement-breakpoint
ALTER TABLE "placement_results" ADD CONSTRAINT "placement_results_test_id_placement_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."placement_tests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "placement_results_test_seed_uq" ON "placement_results" USING btree ("test_id","seed_inbox_id");--> statement-breakpoint
-- Rows written before `status` existed: a null score means the test never
-- finished (its completed_at was only an insert-time placeholder).
UPDATE "placement_tests" SET "created_at" = COALESCE("completed_at", "created_at");--> statement-breakpoint
UPDATE "placement_tests" SET "status" = 'failed', "failure_reason" = 'did not finish (recorded before per-seed results existed)', "completed_at" = NULL WHERE "placement_score" IS NULL;--> statement-breakpoint
UPDATE "placement_tests" SET "observed_count" = "seed_count" WHERE "placement_score" IS NOT NULL AND "observed_count" IS NULL;
