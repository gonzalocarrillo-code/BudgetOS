import type { NestFastifyApplication } from "@nestjs/platform-fastify";

/**
 * What the server and the test harness both set up. Slack posts form-encoded bodies and signs the
 * raw bytes (x-slack-signature), so form bodies keep their raw text next to the parsed fields.
 */
export function configureApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix("api/v1");
  const fastify = app.getHttpAdapter().getInstance();
  // The app is created with bodyParser: false (Nest would register its own form parser); JSON is Fastify's.
  if (fastify.hasContentTypeParser("application/x-www-form-urlencoded")) fastify.removeContentTypeParser("application/x-www-form-urlencoded");
  fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (request, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    (request as unknown as { rawBody?: string }).rawBody = raw;
    done(null, Object.fromEntries(new URLSearchParams(raw)));
  });
}
