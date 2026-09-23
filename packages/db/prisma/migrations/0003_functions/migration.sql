-- eligible_approver: current step role, group membership, and blockSelfApproval (spec §6.1 / §9).
-- FilterGroup scope is evaluated in application code (matchesScope), not in this function.
CREATE OR REPLACE FUNCTION eligible_approver(request_id uuid, user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM approval_request r
    CROSS JOIN LATERAL (
      SELECT r.policy_snapshot -> 'chain' -> r.current_step AS step
    ) s
    WHERE r.id = eligible_approver.request_id
      AND s.step IS NOT NULL
      AND jsonb_typeof(s.step) = 'object'
      AND (
        COALESCE((r.policy_snapshot ->> 'blockSelfApproval')::boolean, true) = false
        OR r.requested_by IS DISTINCT FROM eligible_approver.user_id
      )
      AND (
        s.step ->> 'groupId' IS NULL
        OR EXISTS (
          SELECT 1
          FROM app_group_member gm
          WHERE gm.group_id = (s.step ->> 'groupId')::uuid
            AND gm.user_id = eligible_approver.user_id
        )
      )
      AND EXISTS (
        SELECT 1
        FROM role_assignment ra
        WHERE ra.role::text = s.step ->> 'role'
          AND (ra.workspace_id IS NULL OR ra.workspace_id = r.workspace_id)
          AND (
            (ra.principal_type = 'user' AND ra.principal_id = eligible_approver.user_id)
            OR (
              ra.principal_type = 'group'
              AND EXISTS (
                SELECT 1
                FROM app_group_member gm
                WHERE gm.group_id = ra.principal_id
                  AND gm.user_id = eligible_approver.user_id
              )
            )
          )
      )
  );
$$;

-- functions in 0003_functions/migration.sql (spec §10)
CREATE OR REPLACE FUNCTION effective_target(p_envelope uuid, p_metric text)
RETURNS TABLE(target_id uuid, value numeric, comparator text, inherited_from uuid)
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE chain AS (
    SELECT e.id, e.parent_id, 0 AS depth FROM envelope e WHERE e.id = p_envelope
    UNION ALL
    SELECT p.id, p.parent_id, c.depth + 1 FROM envelope p JOIN chain c ON p.id = c.parent_id
  )
  SELECT t.id, tv.value, tv.comparator, CASE WHEN c.depth = 0 THEN NULL ELSE c.id END
  FROM chain c
  JOIN target t ON t.envelope_id = c.id AND t.metric_key = p_metric AND t.scope_type = 'envelope'
  JOIN target_version tv ON tv.id = t.current_version_id
  ORDER BY c.depth
  LIMIT 1;
$$;

-- subscription(user_id, entity_type, entity_id) plus workspace_id for tenant RLS (spec §13).
CREATE TABLE IF NOT EXISTS subscription (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- notification(user_id, kind, payload, read_at) (spec §19).
CREATE TABLE IF NOT EXISTS notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  read_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- processed_event(consumer, outbox_id) is the publisher dedupe key (spec §19), not a tenant table.
CREATE TABLE IF NOT EXISTS processed_event (
  consumer text NOT NULL,
  outbox_id bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, outbox_id)
);

-- bulk_change lists the version ids committed together (spec §7.4).
CREATE TABLE IF NOT EXISTS bulk_change (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  version_ids uuid[] NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['subscription', 'notification', 'bulk_change'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_is_org_admin() OR workspace_id = app_workspace_id()) WITH CHECK (app_is_org_admin() OR workspace_id = app_workspace_id())',
      t
    );
  END LOOP; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO budget_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO budget_app;
