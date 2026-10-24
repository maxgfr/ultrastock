# Contributing

## Architecture in one minute

A thin, deterministic CLI and a markdown playbook. `src/` fetches public data
(`providers/`), computes figures (`analytics/`), registers each as an evidence
`[E#]` (`core/evidence.ts`) and checks answers against them (`check.ts`).
`skills/ultrastock/SKILL.md` and its `references/` tell the agent how to use
it. tsup bundles everything — the vendored webindex engine included — into one
dependency-free `scripts/ultrastock.mjs`, copied byte for byte into the skill.

## Prerequisites

Node ≥ 20.19 and pnpm for development; the published bundle runs on Node ≥ 18.

```bash
pnpm install
pnpm run engine:gate   # typecheck, lint, test, reproducible bundle + packaging gates, offline evals
```

## Code changes — TDD first

1. Write the failing test (`tests/*.test.ts`) or eval case (`evals/cases/<name>/`).
2. Make it pass with the smallest change; reuse an engine export before writing a helper (`pnpm verify:engine` refuses a re-declared one).
3. A new data source gets a parser test on a real answer and, when it feeds `analyze`, a recorded fixture: `ultrastock analyze <symbol> --out /tmp/x --record assets/fixtures/<name>`.
4. Every figure a command produces is registered as evidence with its provenance; nothing reaches the agent unnumbered.
5. `pnpm run build` and commit the bundle with the source: CI fails when they differ.

## Playbook changes

- `SKILL.md` description ≤ 1000 characters, ending with its explicit-request trigger clause.
- Every reference is linked from `SKILL.md`; every `--flag` the docs mention exists in `--help` (`pnpm verify:bundle`).
- Try the install: `npx skills add . --agent universal --copy -y` in a scratch directory.

## Commits & releases

[Conventional Commits](https://www.conventionalcommits.org/): `feat:` → minor,
`fix:` → patch, `!` or `BREAKING CHANGE:` → major. semantic-release cuts the
release from `main` in CI. Commits are signed.

MIT © maxgfr
