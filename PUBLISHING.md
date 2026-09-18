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

The workflow needs one repository secret, `NPM_PUBLISH_TOKEN` — an npm granular
access token with write access to the `@dustfeather` scope. The separate,
read-only `NPM_TOKEN` secret is what the test workflow uses for authenticated
installs and audits; keep the two distinct so a compromised CI log cannot
publish.

To publish by hand instead (a first release, or a broken runner):

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
