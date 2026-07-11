# Contributing to Readsmith

Thanks for helping make Readsmith better. Bug reports, docs fixes, and
features are all welcome.

## Development setup

Node 22+ and pnpm are required. Postgres is optional: without a database the
site builds and serves docs-only (no search or Ask AI).

```bash
pnpm install
pnpm dev        # the web app, serving the sample content
pnpm test       # per-package test suites
pnpm typecheck
```

The monorepo is pnpm workspaces plus Turborepo: `apps/web` is the serving
shell, `packages/*` are the pipeline (model, config, mdx, components, ai,
api-reference, db, storage, cache, api).

## Quality bars

These are enforced by CI and by review:

- **Determinism.** Builds are byte-identical for the same input. No
  `Date.now()` or `Math.random()` in build or render paths.
- **Accessibility.** WCAG 2.1 AA. New UI ships with keyboard support and
  passes axe in both themes.
- **Tests.** Behavior changes come with tests; pure pipeline stages are
  fixture-tested.

## Sign-off and licensing

- Sign your commits with `git commit -s` (Developer Certificate of Origin).
- Contributions are accepted under the repository license, inbound equals
  outbound: your contribution is licensed under FSL-1.1-MIT and, like the
  rest of each release, automatically becomes MIT two years after that
  release ships.

## Reporting security issues

Never open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).
