const RELAY_ROUTE =
  /\/(Items\/[^/]+\/Images|Videos\/[^/]+\/[^/]+\/Subtitles)(\/|$)/i;

export function isRelayLoop(
  url: string,
  selfOrigins: ReadonlySet<string>
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!selfOrigins.has(parsed.origin)) return false;
  return RELAY_ROUTE.test(parsed.pathname);
}
