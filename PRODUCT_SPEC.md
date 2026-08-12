# Wayne's Browser Tools Portal — Product Specification

## Goal
Create a public, static GitHub Pages portal at `https://wayner84.github.io/tools/` that provides a fast central dashboard and stable route for every listed browser tool under `/tools/<slug>/`.

## Repository
- GitHub: `Wayner84/tools`
- Local: `W:/04_Software_Projects/Websites/tools`
- Hosting: GitHub Pages via GitHub Actions
- No secrets or user data in the repository.

## UX requirements
- Responsive, polished dark dashboard suitable for desktop and mobile.
- Search, category filters, keyboard-friendly navigation, favourites stored locally, and clear status badges.
- Every tool has a stable route `/tools/<slug>/` which launches either Wayne's deployment or the canonical official hosted app.
- Clearly label each integration as `Wayne-hosted`, `official hosted`, or `external service`; do not imply external services are bundled/self-hosted.
- Use same-tab launch by default with an obvious secondary new-tab control where appropriate.
- Include privacy/storage guidance: browser-only tools generally process locally, but external services have their own policies.

## Initial tools
1. CyberChef
2. IT-Tools
3. Excalidraw
4. Mermaid Live Editor
5. JSON Crack
6. Swagger UI
7. Hoppscotch
8. BentoPDF
9. BrowserPDF
10. MD2PDF
11. SQLite Viewer
12. SVGOMG
13. Squoosh
14. Photopea
15. JS Paint
16. tldraw
17. Monaco Editor
18. CodeMirror
19. Reveal.js
20. Graphviz WASM
21. diagrams.net / draw.io — route to `https://wayner84.github.io/drawio/src/main/webapp/`

Additional tools may be added only when browser-based, useful to Wayne as an engineering/developer utility, reputable, and license/source provenance is documented.

## Architecture
- Static HTML/CSS/JavaScript with no framework build dependency unless it materially improves reliability.
- `data/tools.json` is the single source of truth for tool metadata, launch URL, source repo, category, hosting mode, license, and tracked release/ref.
- A deterministic generator creates each route's `index.html` from the manifest.
- Route pages use a safe visible launch screen/redirect rather than iframes because many upstream apps block embedding and cross-origin embedding would be brittle.
- Dashboard must work under GitHub Pages project-site base `/tools/` and when served locally.

## Automated currency
- GitHub Actions workflow runs daily and on manual dispatch.
- It checks each GitHub-backed app's latest release or default-branch commit using GitHub APIs.
- It updates tracked metadata deterministically and commits only when upstream state changed.
- Deployment workflow validates the manifest, regenerates routes, runs tests/build checks, uploads Pages artifact, and deploys.
- For official external apps without a versioned GitHub source, record that limitation rather than fabricating a release check.
- GitHub Actions themselves should use current pinned major versions and minimal permissions.

## Quality gates
- Manifest schema/uniqueness/URL tests.
- Every declared slug has a generated route.
- No broken internal links or absolute `/` assumptions that break project Pages.
- Representative browser smoke tests for dashboard rendering, search/filter, and at least three launch routes.
- Accessibility basics: semantic elements, visible focus, labels, contrast, reduced-motion support.
- `git diff --check` clean.
- README documents architecture, tool classifications, local development, deployment, update behavior, and how to add a tool.

## Deliverables
- Working local repository with clean commits.
- Public GitHub repository.
- Successful GitHub Actions runs.
- Verified live dashboard and representative live routes.
