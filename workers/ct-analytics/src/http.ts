/**
 * Tiny HTTP helpers shared by index.ts and insights-route.ts. Kept in their
 * own module, imported one-way by both, so neither file has to import the
 * other (a previous version had insights-route.ts importing back from
 * index.ts, a circular dependency that happened to work because both
 * imports were hoisted function declarations, but was fragile and out of
 * step with every other split module in this codebase).
 */

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // x-ct-token remains available for the protected administrative stats
  // endpoints. Public ingestion routes deliberately do not authenticate with
  // a secret embedded in the desktop client.
  'Access-Control-Allow-Headers': 'Content-Type, x-ct-token',
  'Access-Control-Max-Age': '86400',
};

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}
