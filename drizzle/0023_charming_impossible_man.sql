CREATE TABLE "whatsapp_kapso_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text DEFAULT 'kapso' NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" text,
	"display_name" text,
	"api_key_cipher" text NOT NULL,
	"api_key_iv" text NOT NULL,
	"api_key_tag" text NOT NULL,
	"webhook_secret_cipher" text NOT NULL,
	"webhook_secret_iv" text NOT NULL,
	"webhook_secret_tag" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_kapso_credentials" ADD CONSTRAINT "whatsapp_kapso_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_kapso_credentials_org_uq" ON "whatsapp_kapso_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_kapso_credentials_phone_number_id_uq" ON "whatsapp_kapso_credentials" USING btree ("phone_number_id");