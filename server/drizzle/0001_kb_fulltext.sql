-- Full-text search over KB chunks: heading weighted above body text.
ALTER TABLE "kb_chunks" DROP COLUMN IF EXISTS "tsv";--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("heading", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("content", '')), 'B')
) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_chunks_tsv_idx" ON "kb_chunks" USING GIN ("tsv");
