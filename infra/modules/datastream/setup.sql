-- One-time Postgres setup for the Datastream replica (docs/DATA_PLAN.md D-001). Run by an operator
-- as a Cloud SQL superuser (cloudsqlsuperuser) after setting the cloudsql.logical_decoding flag;
-- idempotent. Not a migration: it needs wal_level = logical and superuser rights the app never has.

-- Every table, with partitioned facts published under their parent (spend_fact, not
-- spend_fact_2026_09), so BigQuery gets one table per fact.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'budget_os_datastream') THEN
    CREATE PUBLICATION budget_os_datastream FOR ALL TABLES WITH (publish_via_partition_root = true);
  END IF;
END $$;

SELECT pg_create_logical_replication_slot('budget_os_datastream', 'pgoutput')
WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = 'budget_os_datastream');

-- The replication user reads every tenant's rows (the replica is the whole database), writes none.
-- Its password is set out of band and stored in Secret Manager.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'budget_datastream') THEN
    CREATE ROLE budget_datastream WITH LOGIN REPLICATION BYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO budget_datastream;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO budget_datastream;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO budget_datastream;
