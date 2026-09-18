# Publishing to npm

This package is published as `@dustfeather/deckrun` on npm.

## Pre-publish checklist

- All changes are committed and the working tree is clean
- `npm run build` succeeds without errors
- The `dist/` directory reflects the latest source
- `package.json` has `"files": ["dist/", "THIRD-PARTY-NOTICES.md"]` so only compiled
  output and the upstream attribution are shipped

## Updating the version

Edit `package.json` manually or use npm's version command, which also commits and tags:

```bash
# patch: 1.0.0 → 1.0.1
npm version patch

# minor: 1.0.0 → 1.1.0
npm version minor

# major: 1.0.0 → 2.0.0
npm version major
```

`npm version` updates `package.json`, creates a git commit (`v1.2.3`), and tags it. Push both the commit and the tag:

```bash
git push origin master --tags
```

## Building and publishing

Pushing the tag is the whole release. `.github/workflows/release.yml` runs the
shared `node-test` gates, refuses a tag whose name disagrees with
`package.json`, then publishes:

```bash
npm version patch          # writes package.json, commits, tags v1.2.3
git push origin master --tags
```

The job builds **once**: `npm ci` -> `npm run build` -> `npm pack`, then
publishes that exact tarball and uploads it unzipped as a run artifact, so what
a user installs is byte-for-byte what the run tested. Before publishing it
installs the tarball into a scratch directory and runs `deckrun --version`, so a
file missing from `files[]` or a broken bin link fails the release rather than a
user's install.

Publishing a tarball skips one normalisation npm applies to a directory publish:
`pkgJson.fix()` runs only for `spec.type === 'directory'` (npm's
`lib/commands/publish.js`). A `bin` target written as `./dist/index.js` is
silently rewritten to `dist/index.js` on a directory publish and shipped verbatim
on a tarball publish, so the pack step asserts no `bin` target starts with `./`.

The gates run on the repo's own ARC pool; the publish job runs on a
GitHub-hosted runner. npm attaches a provenance attestation automatically under
trusted publishing and its registry accepts one only from a github-hosted
runner — a self-hosted publish is rejected with `422 ... Error verifying
sigstore provenance bundle`. Keeping the pool would mean `--provenance=false`
and no attestation; this repo is public, so hosted minutes cost nothing and the
attestation is worth more than the minute.

The workflow stores no publish credential. It authenticates with npm **trusted
publishing**: the job requests an OIDC token from GitHub, npm exchanges it for a
short-lived publish credential, and provenance is attached automatically. npm
announced on 2026-07-08 that 2FA-bypass granular access tokens lose direct
publish around January 2027, so a stored publish token would be a dead end even
if it were safe to keep one.

That needs a one-time setup on npmjs.com, after the package exists: open the
package's Settings, add a trusted publisher for the `dustfeather/deckrun`
repository and the `Release` workflow. This is configured. Until it was, the
publish step failed with nothing to fall back to, which is the intended
behaviour.

The read-only `NPM_TOKEN` secret is unrelated and still used: the test workflow
reads it so installs and audits authenticate rather than running anonymously. It
has no publish grant.

The **first** publish has to be manual, because a trusted publisher cannot be
configured for a package that does not exist yet. Do it interactively, with 2FA:

```bash
npm run build
npm publish --access public
```

`--access public` is required for a scoped package on the first publish.
Subsequent publishes do not need it, but it is safe to include every time.

## Verifying the release

```bash
npm info @dustfeather/deckrun
```

Check that the `version` field and `dist-tags.latest` match what you just published.

## Running without installation

```bash
npx @dustfeather/deckrun slides.md
```

`npx` downloads and runs the package on the fly — no global install needed.

## Installing the published package

```bash
npm install -g @dustfeather/deckrun
```
