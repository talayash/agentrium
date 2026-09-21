# Security changes and rollout

Implemented against the 2026-09-17 review. These changes are local; this document does not record a production deployment.

## User-visible changes

- Switching to a new account starts with an empty sync dataset. Prior account snapshots stay available when signing back in. Genuine first-sign-in guest adoption remains supported. Running terminals and local session-history logs are not a multi-user OS isolation boundary.
- Environment values, CLI arguments, credential bindings and CLI session identifiers are not uploaded. Workspace sync uses a narrow allowlist. Downloads preserve device-only fields by profile/terminal ID. New devices need local configuration.
- Recognizable profile keys ending in `_API_KEY`, `_TOKEN` or `_SECRET` migrate to the OS credential store before guest migration. A verified keychain write precedes local removal. On failure, local values remain and are still excluded from sync. Other arbitrary environment values stay local. Existing workspace copies and account snapshots can still contain local plaintext until individually migrated/removed.
- Cloud sync requires verified OAuth email ownership. Password-only accounts continue working locally. Claiming an account through OAuth retires its password and quarantines old cloud data for reviewed operator recovery.
- Privacy settings contain an external-summary switch, default off. Rust checks consent too. Opt-in summaries read at most the last 16 KiB of the log and scrub known patterns/runtime secrets before invoking the configured Claude CLI. Turning this off keeps session logs local; it does not add a local AI model. Scrubbing cannot guarantee arbitrary sensitive content is removed.
- Sync limits preserve pending uploads, honor Retry-After, and expose actionable status messages. Logout makes a bounded server-revocation attempt and reports when it cannot confirm it.

## Deployment order

1. Back up application databases and verify restore on two isolated test accounts. Test first guest adoption, A/B/A switching, offline edits, same-timestamp pagination, missing credentials on a second device, and an older desktop client.
2. Release the updated desktop. This change does not bump a release version or publish installers.
3. Apply sibling API migration `0009_security_ownership` before deploying its code. API master pushes deploy production. Older clients' downloads will pause until updated; their local data is preserved.
4. Apply Worker D1 migration `0007_ingest_limits.sql` before deploying the Worker. Ingestion fails closed if admission storage is unavailable. Limits are 120/minute/IP and 10,000/minute/global, independent of installation IDs. Shared office/VPN addresses share a budget. Counters expire through daily cleanup; existing seen-installation retention is unchanged.
5. Run the API's `scripts/encrypt-legacy-sync.mjs` in dry-run mode, review counts, then apply to encrypt historical plaintext without losing recovery data. No production database was read or mutated during implementation. Protect the existing SYNC_ENCRYPTION_KEY and backups.
6. Verify the old compiled CT_INGEST_TOKEN was revoked and was never reused for administrative reads. Inspect deployment secrets/configuration through the operator account. Do not paste secret values into logs or this document.
7. Deploy the website dependency update separately after its tests and static build pass.

## Rollback and recovery

The database migration is additive. Do not revert the API to pre-fix authorization or plaintext-workspace handling. Roll forward for auth/sync incidents. Review encrypted ownership-claim quarantine before any recovery; never automatically import pre-verification rows into a claimed account. Account quotas include tombstones; operator compaction requires a policy for long-offline devices.

Historical cloud copies, backups, extracted tokens and already-distributed old applications cannot be repaired by a local code change. There has been no live production attack test or secret-validity probe.
