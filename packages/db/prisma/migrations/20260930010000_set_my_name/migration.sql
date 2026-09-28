-- A person changes their own display name (product feedback 2026-09-28: greet people by name).
-- app_user is org-admin-write under RLS; this definer function changes only the caller's `name`,
-- never their email, identity or org.
CREATE OR REPLACE FUNCTION app_set_my_name(new_name text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  clean text := btrim(new_name);
BEGIN
  IF me IS NULL THEN RAISE EXCEPTION 'no user in this transaction'; END IF;
  IF clean IS NULL OR length(clean) = 0 OR length(clean) > 120 THEN RAISE EXCEPTION 'a name is 1 to 120 characters'; END IF;
  UPDATE app_user SET name = clean WHERE id = me;
  RETURN clean;
END $$;
REVOKE ALL ON FUNCTION app_set_my_name(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_my_name(text) TO budget_app;
