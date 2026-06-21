CREATE TABLE "blacklist_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"is_clean" boolean,
	"listed_count" integer,
	"rbl_results" jsonb,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"issue_codes" jsonb,
	"ai_analysis" jsonb,
	"readiness_report" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"spf_valid" boolean,
	"spf_record" text,
	"dkim_valid" boolean,
	"dkim_selector" text,
	"dmarc_valid" boolean,
	"dmarc_record" text,
	"mx_valid" boolean,
	"mx_records" text[],
	"rdns_valid" boolean,
	"rdns_value" text,
	"score" integer,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"provider" text NOT NULL,
	"oauth_provider" text,
	"oauth_access_token" text,
	"oauth_refresh_token" text,
	"oauth_token_expiry" timestamp,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_user" text,
	"smtp_pass" text,
	"imap_host" text,
	"imap_port" integer,
	"imap_user" text,
	"imap_pass" text,
	"dkim_selector" text,
	"sending_ip" text,
	"warmup_speed" text DEFAULT 'medium',
	"warmup_day" integer DEFAULT 0,
	"status" text DEFAULT 'pending' NOT NULL,
	"pool_consent_at" timestamp,
	"enrolled_in_pool_at" timestamp,
	"graduated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"inbox_id" uuid,
	"type" text NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "placement_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"seed_count" integer,
	"primary_count" integer,
	"promotions_count" integer,
	"spam_count" integer,
	"missing_count" integer,
	"primary_pct" integer,
	"promotions_pct" integer,
	"spam_pct" integer,
	"placement_score" integer,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"email" text NOT NULL,
	"domain" text NOT NULL,
	"provider" text NOT NULL,
	"industry" text,
	"reputation" integer DEFAULT 50,
	"active" boolean DEFAULT true,
	"quarantined" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reputation_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbox_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"dns_score" integer NOT NULL,
	"blacklist_score" integer NOT NULL,
	"placement_score" integer NOT NULL,
	"trend" text,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"plan" text DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp,
	"stripe_customer_id" text,
	"stripe_sub_id" text,
	"slack_webhook_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "warmup_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_inbox_id" uuid NOT NULL,
	"receiver_inbox_id" uuid NOT NULL,
	"message_id" text,
	"subject" text,
	"body_hash" text,
	"warmup_day" integer NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"sent_at" timestamp,
	"opened_at" timestamp,
	"replied_at" timestamp,
	"starred_at" timestamp,
	"rescued_at" timestamp,
	"filed_at" timestamp,
	"landed_in_spam" boolean DEFAULT false,
	"landed_in_tab" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blacklist_checks" ADD CONSTRAINT "blacklist_checks_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostics" ADD CONSTRAINT "diagnostics_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_checks" ADD CONSTRAINT "dns_checks_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inboxes" ADD CONSTRAINT "inboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_tests" ADD CONSTRAINT "placement_tests_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_members" ADD CONSTRAINT "pool_members_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_scores" ADD CONSTRAINT "reputation_scores_inbox_id_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD CONSTRAINT "warmup_sends_sender_inbox_id_inboxes_id_fk" FOREIGN KEY ("sender_inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warmup_sends" ADD CONSTRAINT "warmup_sends_receiver_inbox_id_inboxes_id_fk" FOREIGN KEY ("receiver_inbox_id") REFERENCES "public"."inboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "placement_tests_inbox_id_idx" ON "placement_tests" USING btree ("inbox_id");--> statement-breakpoint
CREATE INDEX "pool_members_domain_idx" ON "pool_members" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "pool_members_provider_idx" ON "pool_members" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "reputation_scores_inbox_recorded_idx" ON "reputation_scores" USING btree ("inbox_id","recorded_at");--> statement-breakpoint
CREATE INDEX "warmup_sends_sender_inbox_id_idx" ON "warmup_sends" USING btree ("sender_inbox_id");--> statement-breakpoint
CREATE INDEX "warmup_sends_created_at_idx" ON "warmup_sends" USING btree ("created_at");