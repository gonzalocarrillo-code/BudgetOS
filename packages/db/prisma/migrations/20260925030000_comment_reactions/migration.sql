-- T-030 reactions (plan §8.6, 0.6, ADR-025): an emoji reaction on a comment, by one account. The
-- set of emoji is fixed in @budget/domain (REACTIONS) and checked here too. Workspace-scoped with
-- the standard policy; reactions are removed by their account (a toggle), each add and remove is audited.
--
-- Reverse: DROP TABLE comment_reaction;
CREATE TABLE IF NOT EXISTS "comment_reaction" (
    "comment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reaction_pkey" PRIMARY KEY ("comment_id","user_id","emoji"),
    CONSTRAINT "comment_reaction_emoji_check" CHECK ("emoji" IN ('👍', '✅', '👀', '🎉', '❤️', '❓'))
);

DO $$ BEGIN
  ALTER TABLE "comment_reaction" ADD CONSTRAINT "comment_reaction_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "comment_reaction_workspace_id_comment_id_idx" ON "comment_reaction"("workspace_id", "comment_id");

ALTER TABLE comment_reaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_reaction FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON comment_reaction;
CREATE POLICY tenant_isolation ON comment_reaction
  USING (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id = ANY ((SELECT app_visible_workspace_ids())::uuid[]));

-- The read-only MCP role reads what budget_app reads (ADR-019).
GRANT SELECT ON comment_reaction TO budget_mcp;
