# Generate changelog

Generate a changelog for version $ARGUMENTS by analyzing git history.

## Steps

1. Find the previous version tag using `git describe --tags --abbrev=0 HEAD^` or `git tag --sort=-version:refname`
2. Get all commits since that tag: `git log {previous_tag}..HEAD --oneline`
3. For each commit, read the message and categorize it

## Categories

Group changes into these sections (omit empty sections):

- **New Features** - New functionality added
- **Bug Fixes** - Issues resolved
- **Improvements** - Enhancements to existing features
- **Internal** - Refactoring, dependency updates, CI changes

## Output format

```markdown
## What's New in v{VERSION}

### New Features
- Description of feature (#PR if available)

### Bug Fixes
- Description of fix (#PR if available)

### Improvements
- Description of improvement (#PR if available)
```

Present the changelog to the user for review. If they approve, offer to copy it for use in a GitHub Release description.
