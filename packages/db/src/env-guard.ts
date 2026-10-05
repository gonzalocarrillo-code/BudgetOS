/**
 * Guard to prevent seed, reset, and load tooling from running against non-local databases.
 * Throws if the database URL points to a non-local host unless ALLOW_REMOTE_DB=1 is set.
 */

export function assertLocalDatabase(
  url: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  // Check if URL is set
  if (!url || url.trim() === '') {
    throw new Error('DATABASE_URL is not set');
  }

  // Check for ALLOW_REMOTE_DB override
  if (env.ALLOW_REMOTE_DB === '1') {
    return;
  }

  try {
    const parsedUrl = new URL(url);

    // Check if a host query parameter is set (Cloud SQL socket format)
    if (parsedUrl.searchParams.has('host')) {
      const hostParam = parsedUrl.searchParams.get('host');
      throw new Error(
        `Refusing to run against non-local database host ${hostParam}; set ALLOW_REMOTE_DB=1 to override`
      );
    }

    const hostname = parsedUrl.hostname;

    // List of allowed local hostnames (IPv6 ::1 is returned with brackets by URL parser)
    const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'db', 'postgres']);

    // Check if hostname is in the allowed list
    if (localHosts.has(hostname)) {
      return;
    }

    // Check if hostname ends with .localhost
    if (hostname.endsWith('.localhost')) {
      return;
    }

    // If we get here, it's a non-local host
    throw new Error(
      `Refusing to run against non-local database host ${hostname}; set ALLOW_REMOTE_DB=1 to override`
    );
  } catch (err) {
    // If the error is one we threw, re-throw it
    if (err instanceof Error && err.message.startsWith('Refusing to run')) {
      throw err;
    }

    // If URL parsing failed, it might be a malformed URL
    if (err instanceof TypeError) {
      throw new Error(`Invalid DATABASE_URL: ${err.message}`, { cause: err });
    }

    // Re-throw any other errors
    throw err;
  }
}
