-- W5-3 (audit S-11, S-12): a server-side session store (revocable sign-in) and rotating, reuse-
-- detecting MCP OAuth refresh tokens and single-use authorization codes.
--
-- auth_session   one row per issued session JWT (its `jti`). Created by app_create_session when
--                the signed-in Google account is a provisioned Budget OS user (apps/api's
--                loginCallback runs before any tenant context, so this goes through a SECURITY
--                DEFINER function, not withTenant). verifySession checks app_session_live(jti) on
--                every request (cached 60s, positive results only — see JwtVerifier). A Google
--                account nobody added yet still gets a session cookie (so /auth/me and the "not
--                added yet" page keep working from the JWT alone, spec ADR-067) but no row and no
--                `jti`: there is nothing to revoke for an account with no access regardless.
-- oauth_code     one row per issued MCP authorization code, keyed by a hash of the code (the code
--                itself is still a signed, self-contained JWT with its own PKCE/expiry checks;
--                this adds single-use on top — ADR-066 said a code "can be replayed within its
--                5 minutes", this closes that).
-- oauth_refresh  one row per issued MCP refresh token (`jti`, embedded in the refresh JWT).
--                app_consume_refresh rotates atomically: a token used once can never be used
--                again: reuse revokes every refresh token of that chain (same user_id+client_id).
--                chain_started_at carries forward across rotations so the chain's absolute
--                lifetime (90 days) is measured from the first issuance, not the latest refresh.
--
-- All eight new RPCs that touch these tables are SECURITY DEFINER, owned by the migrating role.
-- Since W2-3 (20261010050000_owner_bootstrap_policies, ADR-005) that role holds NO standing
-- BYPASSRLS in any deployed environment — only this checkout's local superuser happens to have
-- it, which is why that was wrongly assumed true everywhere in an earlier version of this comment
-- (audit follow-up to PR #166). FORCE ROW LEVEL SECURITY applies to the owner too, so each of the
-- three tables below gets its own `owner_rpc` policy, same pattern as `owner_bootstrap`: bound to
-- the literal role that runs this migration (and therefore owns these functions) via
-- `TO CURRENT_USER`, resolved once at migration-apply time. budget_app and budget_mcp get EXECUTE
-- on only the functions each side calls; no role gets a table-level grant beyond the narrow ones
-- below, so a direct write bypassing the rotation/reuse logic is refused by Postgres itself.
--
-- Reverse:
--   DROP POLICY IF EXISTS owner_rpc ON auth_session; DROP POLICY IF EXISTS owner_rpc ON oauth_code;
--   DROP POLICY IF EXISTS owner_rpc ON oauth_refresh;
--   REVOKE EXECUTE ON FUNCTION app_create_session(text,uuid,uuid,timestamptz,text) FROM budget_app;
--   REVOKE EXECUTE ON FUNCTION app_session_live(text) FROM budget_app;
--   REVOKE EXECUTE ON FUNCTION app_revoke_session(text) FROM budget_app;
--   REVOKE EXECUTE ON FUNCTION app_revoke_all_sessions(text) FROM budget_app;
--   REVOKE EXECUTE ON FUNCTION app_issue_code(text,timestamptz) FROM budget_app;
--   REVOKE EXECUTE ON FUNCTION app_consume_code(text) FROM budget_mcp;
--   REVOKE EXECUTE ON FUNCTION app_issue_refresh(text,text,uuid,timestamptz,timestamptz) FROM budget_mcp;
--   REVOKE EXECUTE ON FUNCTION app_consume_refresh(text) FROM budget_mcp;
--   DROP FUNCTION app_create_session(text,uuid,uuid,timestamptz,text);
--   DROP FUNCTION app_session_live(text); DROP FUNCTION app_revoke_session(text);
--   DROP FUNCTION app_revoke_all_sessions(text); DROP FUNCTION app_issue_code(text,timestamptz);
--   DROP FUNCTION app_consume_code(text);
--   DROP FUNCTION app_issue_refresh(text,text,uuid,timestamptz,timestamptz);
--   DROP FUNCTION app_consume_refresh(text);
--   DROP TABLE auth_session; DROP TABLE oauth_refresh; DROP TABLE oauth_code;

CREATE TABLE IF NOT EXISTS auth_session (
  jti text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_user (id),
  org_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  user_agent text NULL
);
CREATE INDEX IF NOT EXISTS auth_session_user ON auth_session (user_id);

CREATE TABLE IF NOT EXISTS oauth_code (
  code_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL
);

CREATE TABLE IF NOT EXISTS oauth_refresh (
  jti text PRIMARY KEY,
  client_id text NOT NULL,
  user_id uuid NOT NULL,
  chain_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  revoked_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS oauth_refresh_chain ON oauth_refresh (user_id, client_id);

-- Sessions -------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_create_session(p_jti text, p_user_id uuid, p_org_id uuid, p_expires_at timestamptz, p_user_agent text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO auth_session (jti, user_id, org_id, expires_at, user_agent) VALUES (p_jti, p_user_id, p_org_id, p_expires_at, p_user_agent);
  -- Opportunistic sweep: rows a week past expiry are no longer useful even for "sign out everywhere" history.
  DELETE FROM auth_session WHERE expires_at < now() - interval '7 days';
END $$;
REVOKE ALL ON FUNCTION app_create_session(text, uuid, uuid, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_create_session(text, uuid, uuid, timestamptz, text) TO budget_app;

CREATE OR REPLACE FUNCTION app_session_live(p_jti text) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM auth_session WHERE jti = p_jti AND revoked_at IS NULL AND expires_at > now())
$$;
REVOKE ALL ON FUNCTION app_session_live(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_session_live(text) TO budget_app;

CREATE OR REPLACE FUNCTION app_revoke_session(p_jti text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE auth_session SET revoked_at = now() WHERE jti = p_jti AND revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION app_revoke_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_revoke_session(text) TO budget_app;

-- "Sign out everywhere": revokes every live session of whoever this jti belongs to (including
-- itself), without a separate user lookup — the route that calls this already only knows its own
-- cookie's jti, not the app_user row (logout runs before any tenant context, same as login).
CREATE OR REPLACE FUNCTION app_revoke_all_sessions(p_jti text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  target uuid;
  n integer;
BEGIN
  SELECT user_id INTO target FROM auth_session WHERE jti = p_jti;
  IF target IS NULL THEN RETURN 0; END IF;
  UPDATE auth_session SET revoked_at = now() WHERE user_id = target AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app_revoke_all_sessions(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_revoke_all_sessions(text) TO budget_app;

-- budget_app: SELECT/UPDATE only (a future "your sessions" list/revoke reads and updates its own
-- rows under RLS below); INSERT goes only through app_create_session, DELETE only through the
-- sweep inside it. budget_mcp and budget_publisher have no business reading session data.
REVOKE INSERT, DELETE ON auth_session FROM budget_app;
REVOKE ALL ON auth_session FROM budget_mcp, budget_publisher;

ALTER TABLE auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows_select ON auth_session;
DROP POLICY IF EXISTS own_rows_update ON auth_session;
CREATE POLICY own_rows_select ON auth_session FOR SELECT USING (user_id = (SELECT app_user_id()));
CREATE POLICY own_rows_update ON auth_session FOR UPDATE
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
-- The SECURITY DEFINER path (app_create_session's INSERT, its sweep DELETE): the owner has no
-- BYPASSRLS (W2-3), so without this FORCE RLS would refuse those statements outright.
DROP POLICY IF EXISTS owner_rpc ON auth_session;
CREATE POLICY owner_rpc ON auth_session FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

-- MCP OAuth codes and refresh tokens -------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_issue_code(p_code_hash text, p_expires_at timestamptz) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO oauth_code (code_hash, expires_at) VALUES (p_code_hash, p_expires_at)
$$;
REVOKE ALL ON FUNCTION app_issue_code(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_issue_code(text, timestamptz) TO budget_app;

-- Single-use: an unknown code, an expired one and an already-used one all answer false alike.
CREATE OR REPLACE FUNCTION app_consume_code(p_code_hash text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer;
BEGIN
  UPDATE oauth_code SET used_at = now() WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION app_consume_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_code(text) TO budget_mcp;

CREATE OR REPLACE FUNCTION app_issue_refresh(p_jti text, p_client_id text, p_user_id uuid, p_chain_started_at timestamptz, p_expires_at timestamptz) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO oauth_refresh (jti, client_id, user_id, chain_started_at, expires_at) VALUES (p_jti, p_client_id, p_user_id, p_chain_started_at, p_expires_at)
$$;
REVOKE ALL ON FUNCTION app_issue_refresh(text, text, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_issue_refresh(text, text, uuid, timestamptz, timestamptz) TO budget_mcp;

-- Atomic rotate-and-check: locks the row, then (in order) refuses an unknown jti, a revoked or
-- expired one, and a chain past its 90-day absolute lifetime; a jti already used once (replay)
-- revokes every refresh token of that user+client chain and refuses; otherwise marks it used and
-- lets the caller mint the next one in the chain.
CREATE OR REPLACE FUNCTION app_consume_refresh(p_jti text)
  RETURNS TABLE(ok boolean, reused boolean, client_id text, user_id uuid, chain_started_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  row_ oauth_refresh%ROWTYPE;
BEGIN
  SELECT * INTO row_ FROM oauth_refresh WHERE jti = p_jti FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, NULL::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;
  IF row_.revoked_at IS NOT NULL OR row_.expires_at <= now() OR row_.chain_started_at <= now() - interval '90 days' THEN
    RETURN QUERY SELECT false, false, row_.client_id, row_.user_id, row_.chain_started_at;
    RETURN;
  END IF;
  IF row_.used_at IS NOT NULL THEN
    -- Table-qualified: the function's RETURNS TABLE output columns (user_id, client_id) would
    -- otherwise shadow oauth_refresh's own columns of the same name here.
    UPDATE oauth_refresh r SET revoked_at = now() WHERE r.user_id = row_.user_id AND r.client_id = row_.client_id AND r.revoked_at IS NULL;
    RETURN QUERY SELECT false, true, row_.client_id, row_.user_id, row_.chain_started_at;
    RETURN;
  END IF;
  UPDATE oauth_refresh SET used_at = now() WHERE jti = p_jti;
  RETURN QUERY SELECT true, false, row_.client_id, row_.user_id, row_.chain_started_at;
END $$;
REVOKE ALL ON FUNCTION app_consume_refresh(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_consume_refresh(text) TO budget_mcp;

-- Neither table is "app data": every access goes through the SECURITY DEFINER functions above, so
-- no role needs a table-level grant at all.
REVOKE ALL ON oauth_code FROM budget_app, budget_mcp, budget_publisher;
REVOKE ALL ON oauth_refresh FROM budget_app, budget_mcp, budget_publisher;

ALTER TABLE oauth_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_code FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS no_direct_access ON oauth_code;
CREATE POLICY no_direct_access ON oauth_code USING (false) WITH CHECK (false);
-- The SECURITY DEFINER path (app_issue_code's INSERT, app_consume_code's UPDATE): see auth_session's
-- owner_rpc above for why this is needed now that the owner has no BYPASSRLS (W2-3).
DROP POLICY IF EXISTS owner_rpc ON oauth_code;
CREATE POLICY owner_rpc ON oauth_code FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

ALTER TABLE oauth_refresh ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS own_rows ON oauth_refresh;
CREATE POLICY own_rows ON oauth_refresh FOR SELECT USING (user_id = (SELECT app_user_id()));
-- The SECURITY DEFINER path (app_issue_refresh's INSERT, app_consume_refresh's SELECT FOR UPDATE
-- and its two UPDATEs): see auth_session's owner_rpc above.
DROP POLICY IF EXISTS owner_rpc ON oauth_refresh;
CREATE POLICY owner_rpc ON oauth_refresh FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
