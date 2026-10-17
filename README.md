# Wayne’s Tools

A public launchpad for browser-based engineering, diagramming, developer, document, data and media tools.

**Live site:** https://wayner84.github.io/tools/

## What this repository hosts

This repository hosts the dashboard, stable launch routes and 22 dependency-free engineering worksheets that run locally in the browser. It does not copy the linked upstream applications. Each card identifies the destination type and one of these hosting boundaries:

- **WAYNE-HOSTED** — Wayne’s own deployments, including the native engineering worksheets and diagrams.net/draw.io.
- **UPSTREAM-HOSTED** — the upstream project’s canonical hosted app, demo, playground, documentation or reference.
- **EXTERNAL SERVICE** — a third-party web service which may have its own accounts, telemetry or privacy policy.

This avoids brittle iframes, incompatible monorepo builds, licensing confusion and running untrusted upstream build scripts. The native worksheets perform their calculations and file parsing in the current browser tab without uploading inputs. For linked external apps, users should check the destination’s policy before opening sensitive data.

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

Native worksheets additionally use `implementation: "native"`, `destinationType: "worksheet"`, `hosting: "wayne-hosted"` and the Tool Deck repository as `sourceUrl`. Their implementation and accessible form definition live in `src/native-tools.js`; shared presentation is in `src/native-tool.css`.

Run `npm test` and `npm run build` to validate the catalogue and generate every stable route. Do not hand-edit generated `dist/`.

## Staying current

`update-tools.yml` runs daily and on demand. For each `sourceRepo`, it records the latest GitHub release; where upstream has no release it records the current default-branch commit. It commits only deterministic `data/tools.json` changes. External-only services without a canonical GitHub repository are deliberately not assigned a fabricated version.

`pages.yml` tests, builds and deploys the static artifact on every push to `main`. Both workflows use minimal permissions.

## License and provenance

The portal code is MIT licensed. Each catalogue entry records upstream source and license separately. Upstream applications retain their own licenses and trademarks.
