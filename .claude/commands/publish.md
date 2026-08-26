# Publish a new release of ClaudeTerminal

You are performing a full release of ClaudeTerminal. Follow every step below in order. Stop and ask the user if anything is ambiguous or fails.

## Arguments

$ARGUMENTS - The new version number (e.g. `1.6.0`). If not provided, ask the user what version to publish.

## Step 1: Validate

1. Confirm the version number with the user before proceeding.
2. Read the current version from `package.json` and verify the new version is higher.
3. Ensure the working tree is clean (`git status`). If there are uncommitted changes, warn the user and ask whether to proceed or abort.
4. Ensure you are on the `master` branch. If not, warn the user.

## Step 2: Bump version in all files

Update the version string in **all five** of these files (replace the old version with the new one):

1. **`package.json`** - the `"version"` field
2. **`src-tauri/Cargo.toml`** - the `version` field under `[package]`
3. **`src-tauri/tauri.conf.json`** - the `"version"` field
4. **`README.md`** - update these version references:
   - The version badge: `version-X.Y.Z-green`
   - The NSIS download link filename: `ClaudeTerminal_X.Y.Z_x64-setup.exe` (both the link text and the URL)
   - The MSI download link filename: `ClaudeTerminal_X.Y.Z_x64_en-US.msi` (both the link text and the URL)
5. **`CLAUDE.md`** - the `Current version: **X.Y.Z**` line

After editing, verify each file was updated correctly by reading the changed lines.

## Step 2b: Add changelog entry

Add a new entry at the **top** of the `src/changelog.json` array for this version. Ask the user for a summary of the features/changes to include. Each entry has this format:

```json
{
  "version": "X.Y.Z",
  "date": "YYYY-MM-DD",
  "features": [
    { "title": "Feature name", "description": "Optional description" }
  ]
}
```

Use today's date. The features list should be based on what the user tells you (or inferred from recent commits since the last release tag).

## Step 3: Update Cargo.lock

Run `cargo check` inside `src-tauri/` so that `Cargo.lock` picks up the new version:

```
cd src-tauri && cargo check
```

## Step 4: Commit

Stage **only** these files:
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`
- `README.md`
- `CLAUDE.md`
- `src/changelog.json`

Create a commit with the message (using the heredoc pattern):

```
Release v{VERSION}
```

Do NOT use `--amend`. Do NOT add unrelated files.

## Step 5: Tag

Create an annotated git tag:

```
git tag -a v{VERSION} -m "Release v{VERSION}"
```

## Step 6: Push

Push the commit and tag to the remote:

```
git push origin master
git push origin v{VERSION}
```

This will trigger the `Release` GitHub Actions workflow which builds the installers and publishes the release with auto-update artifacts.

## Step 7: Confirm

After pushing, tell the user:
- The commit and tag have been pushed
- The GitHub Actions release workflow should now be running
- Provide the link: `https://github.com/talayash/claude-terminal/actions`
- Remind them that existing users will receive the update automatically via the in-app updater once the release is published
