-- A workspace admin may decide any step of any request in their workspace, their own changes
-- included, and (in the engine) their approval completes the request, as an org admin's does
-- (product decision 2026-09-28, ADR-048). Same rule as eligibleApprover() in @budget/domain; the
-- app check there also holds the admin's assignment scope against the envelope.
CREATE OR REPLACE FUNCTION eligible_approver(request_id uuid, user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM approval_request r
    JOIN workspace w ON w.id = r.workspace_id
    JOIN app_user u ON u.id = eligible_approver.user_id AND u.org_id = w.org_id
    JOIN role_assignment ra ON ra.role = 'ORG_ADMIN' AND ra.workspace_id IS NULL AND ra.principal_type = 'user' AND ra.principal_id = u.id
    WHERE r.id = eligible_approver.request_id
      AND jsonb_typeof(r.policy_snapshot -> 'chain' -> r.current_step) = 'object'
  ) OR EXISTS (
    SELECT 1
    FROM approval_request r
    JOIN role_assignment ra ON ra.role = 'WORKSPACE_ADMIN' AND ra.workspace_id = r.workspace_id
    WHERE r.id = eligible_approver.request_id
      AND jsonb_typeof(r.policy_snapshot -> 'chain' -> r.current_step) = 'object'
      AND (
        (ra.principal_type = 'user' AND ra.principal_id = eligible_approver.user_id)
        OR (ra.principal_type = 'group' AND EXISTS (SELECT 1 FROM app_group_member gm WHERE gm.group_id = ra.principal_id AND gm.user_id = eligible_approver.user_id))
      )
  ) OR EXISTS (
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
