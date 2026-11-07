CREATE TABLE "voice_call" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text,
	"conversation_id" text,
	"phone" text NOT NULL,
	"caller_name" text,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"transcript" text,
	"recording_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "voice_call_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
ALTER TABLE "voice_call" ADD CONSTRAINT "voice_call_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_call_org_created_idx" ON "voice_call" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "voice_call_org_agent_idx" ON "voice_call" USING btree ("organization_id","agent_id");