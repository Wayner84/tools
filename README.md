# Wayne’s Tools

A public launchpad for browser-based engineering, diagramming, developer, document, data and media tools.

**Live site:** https://wayner84.github.io/tools/

## What this repository hosts

This repository hosts the dashboard and stable launch routes—not copies of all upstream applications. Each card identifies the destination type and one of these hosting boundaries:

- **WAYNE-HOSTED** — Wayne’s own deployment, currently diagrams.net/draw.io.
- **UPSTREAM-HOSTED** — the upstream project’s canonical hosted app, demo, playground, documentation or reference.
- **EXTERNAL SERVICE** — a third-party web service which may have its own accounts, telemetry or privacy policy.

This avoids brittle iframes, incompatible monorepo builds, licensing confusion and running untrusted upstream build scripts. Browser-only apps often process files locally, but users should check each external app’s policy before opening sensitive data.

## Development

Requires Node.js 22 or later; there are no npm dependencies.

```sh
npm test
npm run build
npm run dev
```

Then open `http://localhost:4173/tools/`.

## Adding a tool

Add one record to `data/tools.json`. Each record requires:

- a unique lowercase kebab-case `slug`;
- HTTPS `launchUrl` and, when available, HTTPS `sourceUrl`;
- `name`, `description`, `category`, `hosting`, `license`, `destinationType` and `operator`;
- searchable string `aliases`;
- honest `functionalCheck` and `dataBoundary` text.

Run `npm test` and `npm run build` to validate the catalogue and generate every stable route. Do not hand-edit generated `dist/`.

## Staying current

`update-tools.yml` runs daily and on demand. For each `sourceRepo`, it records the latest GitHub release; where upstream has no release it records the current default-branch commit. It commits only deterministic `data/tools.json` changes. External-only services without a canonical GitHub repository are deliberately not assigned a fabricated version.

`pages.yml` tests, builds and deploys the static artifact on every push to `main`. Both workflows use minimal permissions.

## License and provenance

The portal code is MIT licensed. Each catalogue entry records upstream source and license separately. Upstream applications retain their own licenses and trademarks.
