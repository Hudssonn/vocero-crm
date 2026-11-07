ALTER TABLE "voice_call" DROP CONSTRAINT "voice_call_conversation_id_unique";--> statement-breakpoint
ALTER TABLE "voice_call" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_call_org_conversation_uq" ON "voice_call" USING btree ("organization_id","conversation_id");