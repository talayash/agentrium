# Retrieve end-user error reports from ct-analytics

You are pulling end-user error/exception reports stored by the `ct-analytics` Cloudflare Worker (D1 table `errors`) and writing a human-readable summary inline. Errors are populated by `POST /error_report` from three sources: `rust_panic`, `rust_command`, `frontend`. Retention is 90 days.

## Arguments

`$ARGUMENTS` - Window in days (e.g. `1`, `7`, `30`). Plain integer or with trailing `d` (e.g. `7d`). Defaults to **7** if empty. Clamped to [1, 90].

## Step 1: Resolve the window

1. Parse `$ARGUMENTS`. Strip a trailing `d` if present. Coerce to integer. If empty or invalid, use `7`.
2. Clamp to [1, 90].
3. Tell the user the resolved window (e.g. "Pulling errors for the last 7 days...").

## Step 2: Try the Worker endpoint first (preferred)

1. Resolve the stats token, in this order:
   - `$env:CT_STATS_TOKEN` if set
   - Otherwise, retrieve `STATS_TOKEN` from your auto-memory at `ct_analytics_tokens.md` (memory type `reference`, slug `ct-analytics-tokens`). Do **not** print the token to the user or include it in any saved file.
2. If a token is available, call:
   ```
   GET https://ct-analytics.claude-terminal.workers.dev/errors/summary?days={N}&limit=20
   Header: x-ct-token: {STATS_TOKEN}
   ```
   On Windows PowerShell, use `Invoke-RestMethod` with `-Headers @{ 'x-ct-token' = $token }` and capture to a variable; do **not** echo the token.
3. If the request returns HTTP 200 with JSON, parse it and skip to Step 4.
4. If the request returns 404 (endpoint not deployed yet), tell the user the Worker needs a one-time deploy and offer to run it:
   ```
   Run from workers/ct-analytics/: npx wrangler deploy
   ```
   Ask before running. If they decline, fall through to Step 3.
5. If the request fails for any other reason (no token, non-2xx, network error), fall through to Step 3.

## Step 3: Fallback - query D1 directly via wrangler

Run wrangler from `workers/ct-analytics/` against the production D1 (`--remote`). Use `--json` so the output is parseable. Run all queries; capture stdout per query.

The five queries (replace `{SINCE}` with `'-{N} days'`):

```sql
-- totals
SELECT COUNT(*) AS total,
       COUNT(DISTINCT installation_id) AS affected_installations,
       COUNT(DISTINCT fingerprint) AS unique_fingerprints
FROM errors WHERE ts >= datetime('now', {SINCE});

-- top groups
SELECT fingerprint, COUNT(*) AS occurrences,
       COUNT(DISTINCT installation_id) AS users,
       MAX(ts) AS last_seen, MIN(ts) AS first_seen,
       MAX(source) AS source, MAX(kind) AS kind,
       MAX(message) AS message, MAX(stack) AS stack,
       GROUP_CONCAT(DISTINCT app_version) AS versions
FROM errors WHERE ts >= datetime('now', {SINCE})
GROUP BY fingerprint ORDER BY occurrences DESC LIMIT 20;

-- by source
SELECT source, COUNT(*) AS count FROM errors
WHERE ts >= datetime('now', {SINCE}) GROUP BY source ORDER BY count DESC;

-- by version
SELECT app_version AS version, COUNT(*) AS count FROM errors
WHERE ts >= datetime('now', {SINCE}) GROUP BY app_version ORDER BY count DESC;

-- by os
SELECT os, COUNT(*) AS count FROM errors
WHERE ts >= datetime('now', {SINCE}) GROUP BY os ORDER BY count DESC;
```

Invocation pattern (single line; queries can be `;`-separated in a single `--command` call, but it's cleaner to run one query per invocation and `--json` each result):

```
npx wrangler d1 execute ct-analytics-db --remote --json --command "<query>"
```

If wrangler is not authenticated, it will fail with an auth error - tell the user to run `npx wrangler login` and abort.

## Step 4: Format and print the summary inline

Print **only** to chat (no files written). Use this structure:

```
## Error report - last {N} days  (as of {generated_at})

**Totals**: {total_errors} events from {affected_installations} installations across {unique_fingerprints} unique fingerprints.

**By source**: rust_panic={c}, rust_command={c}, frontend={c}
**By version**: 1.21.0={c}, 1.20.5={c}, ...   (top 5)
**By OS**: windows={c}, ...
**Daily volume**: {date}={c}, ... (or sparkline if many days)

### Top issues

1. **[source] [kind]** - {occurrences} events, {users} users, versions={versions}
   First seen: {first_seen}  Last seen: {last_seen}
   Fingerprint: `{fingerprint}`
   Message: {message}
   Stack (first 6 lines, indented):
       {stack lines}

2. ...
```

Show up to 10 top issues by default (the Worker returns 20; trim for display). Truncate each message to ~200 chars and each stack to first 6 non-empty lines. If `kind` is null, omit it.

## Step 5: Write the human summary

After the structured listing, add a `### Summary` section in prose (3–6 sentences). It must:

- Call out the single highest-impact issue (most users affected, not just most occurrences).
- Note any version that is over-represented vs. its share of DAU (suggests a regression introduced in that version).
- Note any source that dominates (e.g., "Most errors come from `rust_panic` - likely a single recurring crash" vs. "Spread across all three sources").
- If a fingerprint appears only in one specific version, flag it as likely-introduced-in-that-version.
- If totals are zero or trivially low (<5), say so plainly and don't fabricate analysis.

End with **one** concrete next step the user might take (e.g., "Reproduce fingerprint `abc123` on 1.21.0 against the `terminal.rs` PTY reader - message references that file").

## Notes

- Never print or save the `STATS_TOKEN` value.
- Do not write any report file - output is inline only.
- The Worker endpoint must be deployed at least once before HTTPS path works. If `/errors/summary` 404s on production but exists in the code, run `npx wrangler deploy` from `workers/ct-analytics/`.
- If the user passes anything that looks like a version (e.g. `since-v1.21.0`), tell them this command only supports day windows and ask them to use a day count instead.
