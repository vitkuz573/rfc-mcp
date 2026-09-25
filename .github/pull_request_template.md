## What

<!-- One paragraph: the change, in plain terms. -->

## Why

<!-- The problem this solves, or the defect it fixes. Reference the issue. -->

## How it was verified

<!-- Commands run and what they showed. For a bug fix, the regression test that fails without it. -->

## Invariants

- [ ] Analysis still runs only on immutable, content-addressed snapshots
- [ ] Every new derived fact is citable and verifiable
- [ ] Uncertainty is reported (`warnings` / `status`), never silently repaired
- [ ] The model-visible surface stays read-only; corpus work happens in the CLI
- [ ] No new network egress outside the allow-listed IETF hosts
- [ ] Parser or extractor behaviour changed? Version string bumped and `docs/CONTRACT.md` updated

## Checklist

- [ ] `npm run verify` passes (format, types, tests, build)
- [ ] Tests added or updated; bug fixes include a regression test
- [ ] `docs/CONTRACT.md` updated if the public contract changed
- [ ] `CHANGELOG.md` updated under `Unreleased`
