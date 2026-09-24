export function resolveChromePath(
  env?: Readonly<Record<string, string | undefined>>,
  platform?: NodeJS.Platform,
  exists?: (path: string) => boolean,
): string;
