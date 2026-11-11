# Releasing

Merging to `main` ships nothing. The community catalog picks up new `vX.Y.Z` tags, so merged changes wait on `main` until the next release.

## Versions

- Feature and fix PRs leave `version` in `orca-plugin.json` alone.
- Choose the next version at release time, from the PRs merged since the last tag:
  - Minor (0.1.x to 0.2.0) only when one of them adds a major feature.
  - Patch (0.2.0 to 0.2.1) for fixes and minor features.
- An urgent fix can ship on its own as a patch release.

## Steps

1. List the changes since the last tag:

   ```sh
   git log --oneline "$(git describe --tags --abbrev=0)..main"
   ```

2. Open a PR titled `chore(release): X.Y.Z` that only bumps `version` in `orca-plugin.json`.
3. Merge once CI passes. It runs `orca plugin test .` and `orca plugin check .` on the latest Orca.
4. After it merges, tag the merge commit with the same version and push the tag:

   ```sh
   git tag -a vX.Y.Z -m vX.Y.Z <merge-commit>
   git push origin vX.Y.Z
   ```

5. Publish the release notes:

   ```sh
   gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <notes.md>
   ```

## Release notes

- Start with `## Power Sessions X.Y.Z` and one sentence on what changed for users.
- Add a bullet per user-visible change.
- End with "No new plugin capabilities. Updates install without re-approval." or name each capability added.

The catalog pins each tag. Never move or reuse a tag: a mistake ships as the next patch release.
