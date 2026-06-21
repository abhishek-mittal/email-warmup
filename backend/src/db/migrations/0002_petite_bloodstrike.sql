CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL
);
