import { z } from "zod";

/**
 * Shared environment variables across all services.
 * See .env.example at the repo root for placeholders and descriptions.
 */
const CommonEnv = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).optional().describe("Runtime environment; set by Node"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional().describe("Pino log level; defaults to info"),
  GOOGLE_CLOUD_PROJECT: z.string().optional().describe("GCP project ID for BigQuery and GCS; local only if unset"),
  UPLOAD_BUCKET: z.string().optional().describe("GCS bucket for uploads; defaults to dmus-gonzalo-budgetos-uploads in production"),
  CLOSURE_DATASET: z.string().optional().describe("BigQuery dataset for period closures; defaults to budgetos_closures in production"),
  CLOSURE_SINK: z.string().optional().describe("BigQuery load job sink URL; set in production"),

  // Observability
  API_PUBLIC_URL: z.string().url().optional().describe("The API's public URL Slack calls; set in production"),
  APP_BASE_URL: z.string().url().optional().describe("The web app URL for Slack links and MCP; defaults to http://localhost:5173 locally"),
  MCP_PUBLIC_URL: z.string().url().optional().describe("The MCP server's public URL; set in production with MCP_OAUTH_KEY"),

  // Caching and query
  REDIS_URL: z.string().optional().describe("Redis URL for /query cache; optional, defaults to in-memory locally"),
  QUERY_CACHE: z.string().optional().describe("Query cache mode: 'on' or 'off'; defaults to 'on' when REDIS_URL is set"),
  BIGQUERY_PROJECT: z.string().optional().describe("BigQuery project ID for the data warehouse replica; local only if unset"),
  BIGQUERY_DATASET: z.string().optional().describe("BigQuery dataset of the warehouse replica (project.dataset); local only if unset"),
  BIGQUERY_LOCATION: z.string().optional().describe("BigQuery location (us-central1, etc.); defaults to US"),

  // Retention (docs/DATA_PLAN.md D-002)
  FACT_RETENTION_ENABLED: z.string().optional().describe("Enable fact retention pruning; 'true' to enable"),
  FACT_RETENTION_MONTHS: z.string().optional().describe("Months to keep hot (minimum 7, default 13)"),

  // GCS emulator (ADR-011)
  GCS_EMULATOR_HOST: z.string().optional().describe("GCS emulator endpoint; local only (http://127.0.0.1:4443 from docker-compose)"),
});

/**
 * Environment variables for the API (apps/api).
 * Extends CommonEnv; see deploy.yml and docs/runbooks/local.md for Secret Manager names.
 */
export const ApiEnv = CommonEnv.extend({
  // Database (required)
  APP_DATABASE_URL: z.string().min(1).optional().describe("Postgres connection URL for the application role; Secret Manager: budgetos-app-database-url"),
  DATABASE_URL: z.string().min(1).optional().describe("Fallback owner connection URL (legacy); Secret Manager: budgetos-database-url"),

  // Server
  PORT: z.string().optional().describe("HTTP port; defaults to 3000"),
  LISTEN_HOST: z.string().optional().describe("HTTP listen host; defaults to 0.0.0.0"),
  WEB_HOST: z.string().optional().describe("Web dev server host; local only"),
  WEB_PORT: z.string().optional().describe("Web dev server port; local only"),
  WEB_DIST: z.string().optional().describe("Web app build directory; defaults to apps/web/dist"),

  // Authentication (ADR-067)
  AUTH_MODE: z.enum(["iap", "session"]).optional().describe("Sign-in mode: 'iap' (IAP assertion) or 'session' (OAuth); Secret Manager: SESSION_KEY for session mode"),
  AUTH_AUDIENCE: z.string().optional().describe("IAP service URL (/projects/NUM/locations/REGION/services/NAME); set in production for IAP mode"),
  AUTH_ISSUER: z.string().optional().describe("OIDC issuer URL; defaults to https://accounts.google.com"),
  AUTH_JWKS_URL: z.string().optional().describe("OIDC JWKS URL; defaults to Google's"),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional().describe("Google OAuth client ID; Secret Manager: budgetos-google-oauth-client-id"),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().describe("Google OAuth client secret; Secret Manager: budgetos-google-oauth-client-secret"),
  SESSION_KEY: z.string().optional().describe("Session signing key; Secret Manager: budgetos-session-key (session mode only)"),
  SUPERADMIN_EMAIL: z.string().email().optional().describe("Superadmin email for bootstrap; set in deploy.yml"),
  SUPERADMIN_NAME: z.string().optional().describe("Superadmin name for bootstrap; defaults to email prefix"),
  IAP_DEBUG: z.string().optional().describe("Log IAP assertion details; local testing only"),

  // MCP OAuth (ADR-066)
  MCP_OAUTH_KEY: z.string().optional().describe("MCP OAuth signing key; Secret Manager: budgetos-mcp-oauth-key"),

  // Integrations
  OPENAI_API_KEY: z.string().optional().describe("OpenAI API key; Secret Manager: budgetos-openai-api-key (if Slack is enabled)"),
  OPENAI_MODEL: z.string().optional().describe("OpenAI model ID; defaults to gpt-4o"),
  SLACK_BOT_TOKEN: z.string().optional().describe("Slack bot token; Secret Manager: budgetos-slack-bot-token"),
  SLACK_SIGNING_SECRET: z.string().optional().describe("Slack app signing secret; Secret Manager: budgetos-slack-signing-secret"),

  // Local dev
  LOCAL_PERSONA: z.string().optional().describe("Simulate a user's role; local only (test/admin/member)"),
  LOCAL_ORG_FROM: z.string().optional().describe("Local org to serve; defaults to 'local'"),
  LOCAL_WORKSPACE_PREFIX: z.string().optional().describe("Local workspace prefix filter; defaults to 'e2e-'"),
  LOAD_KEEP: z.string().optional().describe("Keep test load data; local only"),
  SEED_SLUG: z.string().optional().describe("Workspace slug to seed; local only"),
  PUBLIC_ROUTES: z.string().optional().describe("Routes behind IAP; defaults to 'none' (all behind IAP unless specified)"),
  UPDATE_OPENAPI: z.string().optional().describe("Regenerate openapi.json on startup; local dev only"),
  SNAPSHOT_INTEGRITY: z.string().optional().describe("Enable snapshot integrity checks; local only"),

  // Testing
  K_SERVICE: z.string().optional().describe("Cloud Run service name; set by Cloud Run"),
  VITEST: z.string().optional().describe("Set by vitest runner"),
  BENCH_RECORD: z.string().optional().describe("Record benchmark results; test only"),
  PERF_BUDGET_SCALE: z.string().optional().describe("Benchmark scale factor for slower CI; test only"),
  JWKS_PERSIST: z.string().optional().describe("Persist JWKS cache; test only"),
});

/**
 * Environment variables for workers (apps/workers).
 * Extends CommonEnv; used by pacing, rollup, export, notify, retention, ingest, search workers.
 */
export const WorkerEnv = CommonEnv.extend({
  // Database (required for app role)
  APP_DATABASE_URL: z.string().min(1).describe("Postgres connection URL for the application role; Secret Manager: budgetos-app-database-url"),
  // Database (optional for owner role, used by bootstrap and local-runner)
  DATABASE_URL: z.string().optional().describe("Owner connection URL for bootstrap and outbox loop; Secret Manager: budgetos-database-url (local-runner only)"),
  // Database (optional for publisher role, used by outbox loop)
  PUBLISHER_DATABASE_URL: z.string().optional().describe("Postgres connection for outbox publisher; Secret Manager: budgetos-database-url (W2-3: used instead of DATABASE_URL)"),

  // Server (local-runner and push subscribers)
  PORT: z.string().optional().describe("HTTP port for Pub/Sub push; defaults to 8080"),
  LISTEN_HOST: z.string().optional().describe("HTTP listen host for local-runner; defaults to 127.0.0.1"),

  // Integrations
  OPENAI_API_KEY: z.string().optional().describe("OpenAI API key; Secret Manager: budgetos-openai-api-key (if enabled)"),
  OPENAI_MODEL: z.string().optional().describe("OpenAI model ID; defaults to gpt-4o"),
  SLACK_BOT_TOKEN: z.string().optional().describe("Slack bot token; Secret Manager: budgetos-slack-bot-token (notify worker)"),
  SLACK_SIGNING_SECRET: z.string().optional().describe("Slack app signing secret; Secret Manager: budgetos-slack-signing-secret (notify worker)"),

  // Pacing (Cloud Scheduler trigger, ADR-012)
  PACING_ORG_IDS: z.string().optional().describe("Comma-separated org IDs to evaluate; set by Cloud Scheduler in production"),
  PACING_EVERY_MS: z.string().optional().describe("Pacing evaluation interval in ms; set in production (900000 = 15 min), 0/unset = disabled"),

  // Push server (for ingest, rollup, notify, search, export workers)
  PW_CHANNEL: z.string().optional().describe("Pub/Sub push subscription channel; set by Pub/Sub infrastructure"),
  SANDBOX_CHANNEL: z.string().optional().describe("Sandbox notification channel; local only"),

  // Local dev (local-runner)
  LOCAL_ORG_FROM: z.string().optional().describe("Local org to serve; defaults to null (all orgs)"),
  LOCAL_WORKSPACE_PREFIX: z.string().optional().describe("Local workspace prefix filter; defaults to 'e2e-'"),

  // Testing
  E2E_PORT_OFFSET: z.string().optional().describe("Port offset for E2E tests; test only"),
  E2E_PROFILE: z.string().optional().describe("Playwright profile; test only"),
  VITEST: z.string().optional().describe("Set by vitest runner"),
  LOAD_KEEP: z.string().optional().describe("Keep test load data; local only"),
});

/**
 * Environment variables for the MCP server (apps/mcp).
 * Extends CommonEnv; a read-only HTTP service that runs on the MCP role.
 */
export const McpEnv = CommonEnv.extend({
  // Database (required)
  MCP_DATABASE_URL: z.string().min(1).describe("Postgres connection URL for the read-only budget_mcp role; Secret Manager: budgetos-mcp-database-url"),

  // Server
  PORT: z.string().optional().describe("HTTP port; defaults to 8080"),
  LISTEN_HOST: z.string().optional().describe("HTTP listen host; defaults to 0.0.0.0"),

  // OAuth (ADR-066)
  MCP_OAUTH_KEY: z.string().optional().describe("MCP OAuth signing key; Secret Manager: budgetos-mcp-oauth-key"),

  // Testing
  K_SERVICE: z.string().optional().describe("Cloud Run service name; set by Cloud Run"),
  VITEST: z.string().optional().describe("Set by vitest runner"),
});

/**
 * Parse and validate environment variables against a schema.
 * @returns The parsed environment object
 * @throws Error with a multi-line message listing all validation failures
 */
export function parseEnv<T>(schema: z.ZodSchema<T>, env: Record<string, string | undefined>): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      if (issue.code === "invalid_enum_value") {
        return `${issue.path.join(".")}: expected one of ${JSON.stringify(issue.options)}, got ${JSON.stringify(issue.received)}`;
      }
      if (issue.code === "invalid_type") {
        return `${issue.path.join(".")}: expected ${issue.expected}, got ${typeof issue.received}`;
      }
      return `${issue.path.join(".")}: ${issue.message}`;
    });
    throw new Error(`Invalid environment: ${issues.join("; ")}`);
  }
  return result.data;
}
