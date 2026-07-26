export function createReleaseTokens(
  manifest: unknown,
  repository: string,
): Record<string, string>;

export function injectReleaseTokens(
  html: string,
  tokens: Record<string, string>,
): string;
