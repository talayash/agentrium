# macOS code-signing & notarization plan

## Why this is needed

Right now the macOS DMG and `.app` shipped from CI are **unsigned and un-notarized**:

- `src-tauri/tauri.conf.json` `bundle.macOS` only sets `minimumSystemVersion`. There's no `signingIdentity`, no `notarize` block.
- `.github/workflows/release.yml` passes `TAURI_SIGNING_PRIVATE_KEY` (the **updater**'s minisign key - a different thing) but no Apple Developer ID secrets to `tauri-action`.

When users download the DMG via Safari/Chrome, macOS attaches `com.apple.quarantine`. On first launch, Gatekeeper sees no Developer ID signature and shows the misleading "ClaudeTerminal is damaged and can't be opened" dialog. The `xattr -dr com.apple.quarantine` workaround works because it strips the quarantine bit - but it should not be required of normal users.

The fix is to sign with a **Developer ID Application** certificate and notarize with Apple's notary service so Gatekeeper recognizes the binary as trusted.

## Prerequisites (one-time)

You need to enroll in the Apple Developer Program (**$99/yr**, individual or organization). Then in Apple's developer portal create:

1. **Developer ID Application certificate** (NOT Mac App Store / Mac Installer). Download the `.cer`, double-click to install into Keychain, then export from Keychain Access as a `.p12` with a strong password. This is the file CI will use.
2. **App-specific password** for your Apple ID - from <https://appleid.apple.com> → "App-Specific Passwords". Used by `notarytool`.
3. Note your **Team ID** (10-character alphanumeric) from the developer portal.

## GitHub repo secrets to add

Under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` file: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | password used when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | full identity string, e.g. `Developer ID Application: Tal Ayash (ABCDE12345)` - found via `security find-identity -v -p codesigning` after importing |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password from step 2 |
| `APPLE_TEAM_ID` | the 10-character Team ID |

## Code changes

### 1. `src-tauri/tauri.conf.json`

Replace the current `bundle.macOS` block:

```json
"macOS": {
  "minimumSystemVersion": "10.15"
}
```

with:

```json
"macOS": {
  "minimumSystemVersion": "10.15",
  "signingIdentity": "-",
  "hardenedRuntime": true,
  "entitlements": "entitlements.plist"
}
```

`"signingIdentity": "-"` is a placeholder that `tauri-action` will override at build time using the `APPLE_SIGNING_IDENTITY` env var. Hardened Runtime is required for notarization.

### 2. `src-tauri/entitlements.plist` (new file)

Notarization requires a hardened runtime, and the app needs entitlements that match what it actually does - most importantly, the JIT entitlement that lets the embedded WebView2/WKWebView run, and `allow-unsigned-executable-memory` because Tauri's webview maps unsigned JIT pages.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

### 3. `.github/workflows/release.yml`

Add the Apple secrets to the `Build Tauri App` step's `env:`:

```yaml
- name: Build Tauri App
  uses: tauri-apps/tauri-action@73fb865345c54760d875b94642314f8c0c894afa # v0.6.1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
    CT_INGEST_TOKEN: ${{ secrets.CT_INGEST_TOKEN }}
    AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
    AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
    AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
    # NEW - macOS signing & notarization (no-ops on Windows runners):
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
    APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

`tauri-action` auto-detects these env vars and:
1. Imports `APPLE_CERTIFICATE` into a temporary keychain on the macOS runner.
2. Codesigns the `.app` and the embedded helper binaries with `APPLE_SIGNING_IDENTITY` and the entitlements.
3. Submits to Apple's notary service via `notarytool` using `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`.
4. Staples the notarization ticket onto the `.app` and `.dmg` so they validate offline.

The Windows job ignores Apple secrets (no `if:` guard needed; they're just unused env on that runner).

## Verification (after first signed release)

1. Pull the new DMG from the GitHub release on a fresh Mac (no developer mode, no `xattr` cleanup).
2. Mount, drag to Applications, double-click. The "damaged" dialog should not appear. macOS may show the standard "downloaded from internet, are you sure?" prompt once - that's expected and normal.
3. Verify on the command line:
   ```
   spctl --assess --type execute -vvv /Applications/ClaudeTerminal.app
   # → /Applications/ClaudeTerminal.app: accepted
   #   source=Notarized Developer ID
   ```
4. Verify the staple is attached:
   ```
   stapler validate /Applications/ClaudeTerminal.app
   # → The validate action worked!
   ```

If `spctl` shows `source=Developer ID` (without "Notarized"), the signing worked but the notarization step didn't - check the `tauri-action` logs for the `notarytool submit` output, which will include a submission ID you can pass to `notarytool log <id> --apple-id … --team-id … --password …` to see what Apple's automated checks complained about.

## Cost / time

- $99/yr for the developer program.
- ~10 minutes to add the secrets and merge the changes above.
- Each release adds ~3-5 min to the macOS jobs (signing + Apple notarization round-trip). Apple is usually fast (<1 min) but occasionally slow (10+ min) - fail open and let CI complete.

## Bridging until signed builds ship

Until the cert is set up, the README's macOS section can document the workaround so users don't get stuck:

```markdown
### First launch on macOS

The current macOS builds are unsigned. macOS will show "ClaudeTerminal is damaged and can't be opened" - this is Gatekeeper, not actual damage. To allow the app to run:

  xattr -dr com.apple.quarantine /Applications/ClaudeTerminal.app

This strips the quarantine flag set by your browser. We're working on getting the app signed and notarized so this step will not be needed.
```

Once the signed release ships, drop that section.
