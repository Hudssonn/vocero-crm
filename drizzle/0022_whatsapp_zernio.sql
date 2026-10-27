CREATE TABLE "whatsapp_zernio_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text DEFAULT 'zernio' NOT NULL,
	"account_ref" text NOT NULL,
	"display_name" text,
	"token_cipher" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"webhook_secret" text,
	"webhook_secret_cipher" text,
	"webhook_secret_iv" text,
	"webhook_secret_tag" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_zernio_credentials" ADD CONSTRAINT "whatsapp_zernio_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_zernio_credentials_org_uq" ON "whatsapp_zernio_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_zernio_credentials_account_ref_uq" ON "whatsapp_zernio_credentials" USING btree ("account_ref");