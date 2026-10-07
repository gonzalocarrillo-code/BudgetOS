-- Round 11 (PR 1): remember when a person last signed in, and bind their account id on the first
-- email-matched sign-in, so "Not signed in yet" clears for someone who was added by email.
-- Reverse: DROP FUNCTION IF EXISTS app_record_sign_in(text); ALTER TABLE app_user DROP COLUMN IF EXISTS last_sign_in_at;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz;

-- Anyone who already has an account id has signed in before.
UPDATE app_user SET last_sign_in_at = created_at WHERE google_sub IS NOT NULL AND last_sign_in_at IS NULL;

-- Runs inside withIdentity(): touches only the row that the verified token already exposes
-- (app.auth_subs / app.auth_email), the same rows the app_user identity policy
-- (20260924030000_rls_identity_tables) shows. Writes at most once per 15 minutes. Binds
-- google_sub only when it is still empty. SECURITY DEFINER, owned by the migrating role: the
-- owner_bootstrap policy on app_user (20261010050000_owner_bootstrap_policies) already covers
-- writes made by a SECURITY DEFINER function owned by the owner, the same way app_set_my_name does.
CREATE OR REPLACE FUNCTION app_record_sign_in(p_sub text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  bound boolean := false;
  target uuid;
BEGIN
  SELECT id INTO target FROM app_user
   WHERE google_sub = ANY (app_auth_subs())
      OR (app_auth_email() IS NOT NULL AND email = app_auth_email())
   ORDER BY (google_sub = ANY (app_auth_subs())) DESC NULLS LAST
   LIMIT 1;
  IF target IS NULL THEN RETURN false; END IF;
  UPDATE app_user
     SET google_sub = coalesce(google_sub, p_sub),
         last_sign_in_at = now()
   WHERE id = target
     AND (last_sign_in_at IS NULL OR last_sign_in_at < now() - interval '15 minutes' OR google_sub IS NULL)
  RETURNING (google_sub = p_sub AND p_sub IS NOT NULL) INTO bound;
  RETURN coalesce(bound, false);
END $$;
REVOKE ALL ON FUNCTION app_record_sign_in(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_sign_in(text) TO budget_app;
