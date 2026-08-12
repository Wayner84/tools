# Tools Portal Agent Contract

## Product source of truth
Read `PRODUCT_SPEC.md` before making changes. Maintain a factual distinction between self/Wayne-hosted tools and official external services.

## Commands
- `npm test` — deterministic validation and unit tests
- `npm run build` — generate deployable `dist/`
- `npm run dev` — local static preview

## Engineering rules
- Static GitHub Pages project site; all internal paths must work beneath `/tools/`.
- Tool metadata belongs in `data/tools.json`; generated route pages are not hand-edited.
- Do not vendor full upstream applications into this repository.
- Never use iframes for third-party tools unless verified and explicitly documented.
- No secrets, tokens, telemetry, trackers, or private data.
- Keep dependencies minimal and pin deterministic versions.
- Preserve keyboard navigation, semantic markup, reduced-motion behavior, and mobile responsiveness.
- GitHub workflows use minimal permissions and must not run untrusted upstream code.
- Do not commit, push, alter git history, or touch files outside this repository unless the orchestration brief explicitly asks.

## Verification
Before reporting completion, run tests, build, inspect `dist/`, and run `git diff --check`. Report exact commands and outcomes.
