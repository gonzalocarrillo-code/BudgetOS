-- HO-004 (docs/HOME_OVERVIEW_PLAN.md, finding B-5): countries read by the names people use. A
-- built-in country value that still carries its ISO 3166 formal name ("United Kingdom of Great
-- Britain and Northern Ireland") takes the short name ("United Kingdom") and keeps the formal one as
-- the external id `iso_name`, which search indexes. A value someone renamed keeps its name.
--
-- One statement: each change is audited as the system; each workspace that sees the dimension gets
-- its data version bumped and a registry.changed event, so caches drop and the search index rebuilds
-- its registry documents. Idempotent: a second run matches nothing.
WITH names(code, official, short) AS (
  VALUES
    ('BO', 'Bolivia, Plurinational State of', 'Bolivia'),
    ('BN', 'Brunei Darussalam', 'Brunei'),
    ('CC', 'Cocos (Keeling) Islands', 'Cocos Islands'),
    ('CD', 'Congo, Democratic Republic of the', 'DR Congo'),
    ('FK', 'Falkland Islands (Malvinas)', 'Falkland Islands'),
    ('IR', 'Iran, Islamic Republic of', 'Iran'),
    ('KP', 'Korea, Democratic People''s Republic of', 'North Korea'),
    ('KR', 'Korea, Republic of', 'South Korea'),
    ('LA', 'Lao People''s Democratic Republic', 'Laos'),
    ('FM', 'Micronesia, Federated States of', 'Micronesia'),
    ('MD', 'Moldova, Republic of', 'Moldova'),
    ('NL', 'Netherlands, Kingdom of the', 'Netherlands'),
    ('PS', 'Palestine, State of', 'Palestine'),
    ('RU', 'Russian Federation', 'Russia'),
    ('SH', 'Saint Helena, Ascension and Tristan da Cunha', 'Saint Helena'),
    ('MF', 'Saint Martin (French part)', 'Saint Martin'),
    ('SX', 'Sint Maarten (Dutch part)', 'Sint Maarten'),
    ('SY', 'Syrian Arab Republic', 'Syria'),
    ('TW', 'Taiwan, Province of China', 'Taiwan'),
    ('TZ', 'Tanzania, United Republic of', 'Tanzania'),
    ('GB', 'United Kingdom of Great Britain and Northern Ireland', 'United Kingdom'),
    ('US', 'United States of America', 'United States'),
    ('UM', 'United States Minor Outlying Islands', 'US Minor Outlying Islands'),
    ('VE', 'Venezuela, Bolivarian Republic of', 'Venezuela'),
    ('VN', 'Viet Nam', 'Vietnam'),
    ('VG', 'Virgin Islands (British)', 'British Virgin Islands'),
    ('VI', 'Virgin Islands (U.S.)', 'US Virgin Islands')
),
renamed AS (
  UPDATE dimension_value dv
     SET label = n.short,
         external_ids = coalesce(dv.external_ids, '{}'::jsonb) || jsonb_build_object('iso_name', n.official)
    FROM names n, dimension d
   WHERE d.id = dv.dimension_id AND d.key = 'country' AND dv.code = n.code AND dv.label = n.official
  RETURNING dv.id, dv.dimension_id, d.org_id, d.workspace_id, n.official, n.short
),
audited AS (
  INSERT INTO audit_event (workspace_id, actor_id, actor_type, action, entity_type, entity_id, before, after, reason)
  SELECT r.workspace_id, NULL, 'system', 'registry.value.updated', 'dimension_value', r.id,
         jsonb_build_object('label', r.official),
         jsonb_build_object('label', r.short, 'externalIds', jsonb_build_object('iso_name', r.official)),
         'HO-004: countries read by their short names'
    FROM renamed r
  RETURNING 1
),
dims AS (
  SELECT DISTINCT dimension_id, org_id, workspace_id FROM renamed
),
bumped AS (
  UPDATE workspace w
     SET settings = jsonb_set(coalesce(w.settings, '{}'::jsonb), '{dataVersion}', to_jsonb(coalesce((w.settings->>'dataVersion')::bigint, 0) + 1))
   WHERE w.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM dims x WHERE x.org_id = w.org_id AND (x.workspace_id IS NULL OR x.workspace_id = w.id))
  RETURNING w.id, w.org_id
)
INSERT INTO outbox (workspace_id, topic, payload)
SELECT b.id, 'registry.changed', jsonb_build_object('orgId', b.org_id::text, 'kind', 'value.updated', 'dimensionId', x.dimension_id::text)
  FROM bumped b
  JOIN dims x ON x.org_id = b.org_id AND (x.workspace_id IS NULL OR x.workspace_id = b.id);
