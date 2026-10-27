CREATE TABLE "email_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"imap_host" text NOT NULL,
	"imap_port" integer DEFAULT 993 NOT NULL,
	"imap_secure" boolean DEFAULT true NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer DEFAULT 465 NOT NULL,
	"smtp_secure" boolean DEFAULT true NOT NULL,
	"username" text NOT NULL,
	"password_cipher" text NOT NULL,
	"password_iv" text NOT NULL,
	"password_tag" text NOT NULL,
	"uid_validity" text,
	"last_seen_uid" integer,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"last_check_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_profile" ADD COLUMN "email_signature" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "email_message_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "email_subject" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "email_in_reply_to" text;--> statement-breakpoint
ALTER TABLE "email_credentials" ADD CONSTRAINT "email_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_credentials_org_uq" ON "email_credentials" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_email_message_id_unique" UNIQUE("email_message_id");