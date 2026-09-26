# macOS signing and notarization

The release workflow supports Developer ID signing and notarization on both Mac
architectures. Activation requires the six repository secrets below. Without any
Apple secrets, releases retain their previous unsigned/ad-hoc behavior and CI
prints a warning. Partial configuration fails before building.

## Why this is needed

[Issue #75](https://github.com/talayash/agentrium/issues/75) shows macOS requesting
the login Keychain password to read `com.claudeterminal.agentrium.auth`. This is
Agentrium's refresh token, shared by Google and email sign-in.

The previous release workflow only passed the Tauri updater signing key. That
verifies update downloads but does not establish the app's identity to macOS.
Unsigned/ad-hoc builds lack an identity that stays stable across rebuilds, so
Keychain can ask again after each update. A consistent Developer ID signature
allows Keychain to recognize subsequent versions as the same application.
See [Apple's code signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)
and [Tauri's signing guide](https://tauri.app/distribute/sign/macos/).

Signing and notarization also address Gatekeeper's first-launch warnings.
Keep the bundle identifier `com.claudeterminal.desktop` and Developer ID team
stable across releases. Do not change Keychain service names, delete users'
tokens, or broaden Keychain access permissions to work around signing prompts.

## One-time setup

Use an Apple Developer Program account to create a **Developer ID Application**
certificate. Import it on a Mac with its private key, then export the identity
from Keychain Access as a password-protected `.p12`. Obtain an app-specific
password for notarization from the Apple account settings.

Add these secrets under the repository's **Settings → Secrets and variables →
Actions**. Do not commit the certificate or passwords.

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Base64 of the exported `.p12`, generated with `openssl base64 -A -in certificate.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: Name (TEAMID)` identity from `security find-identity -v -p codesigning` |
| `APPLE_ID` | Apple account email used for notarization |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Developer team ID |

The macOS-only configuration step validates the set and exports it through
`GITHUB_ENV` for the Tauri build. Empty secrets are not exported: Tauri treats
some present-but-empty variables as configured credentials. The Tauri bundler
imports the certificate into a temporary keychain, signs the bundles, submits
them for notarization, and staples the tickets. Signing/notarization failures
fail the release rather than publishing a partially signed build.

Tauri enables hardened runtime by default. No extra JIT or library-validation
exceptions are introduced; this app uses the system WKWebView. No hard-coded
signing identity is needed in `tauri.conf.json` because the environment supplies it.

## Validation

Run the configuration regression tests locally:

```sh
node --test scripts/configure-macos-signing.test.mjs
```

After the first signed release, validate on both Apple Silicon and Intel Macs:

```sh
codesign --verify --deep --strict --verbose=2 /Applications/Agentrium.app
codesign -d -r- /Applications/Agentrium.app
spctl --assess --type execute -vvv /Applications/Agentrium.app
xcrun stapler validate /Applications/Agentrium.app
```

Expect a Developer ID designated requirement containing the correct identifier
and team, and `source=Notarized Developer ID` from Gatekeeper. Test a browser DMG
download on a clean Mac as well as an in-app update.

For the Keychain regression, sign in, quit, and install a second signed version
using the same team and bundle identifier. Launch and verify sign-in is restored
without another authorization prompt. Test a saved API key too: it uses the same
OS Keychain mechanism. This requires two real macOS builds; Windows tests cannot
validate Keychain trust.

## Existing users

The transition from an unsigned/ad-hoc build to Developer ID signing may still
prompt once for an existing Keychain item. In the dialog from issue #75, users
can enter their **Mac login Keychain password** and choose **Always Allow**.
Deleting the item and signing in again should not be necessary. An old or
separately configured login Keychain may use a different password from the
current Mac account password.

Until signing credentials are configured and signed releases ship, recurring
prompts after updates remain possible. The workflow change alone cannot fix
already-installed builds.
