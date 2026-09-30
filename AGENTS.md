# audit-chain-kit — agent instructions

Build and verify SHA-256 hash chains over audit records, with a zero-dependency Web Crypto verifier and optional anchor checks.

## Read first
- `ENGINEERING.md` holds this package's invariants and design rules; read it before changing behavior.
- `PROJECT_CONTEXT.md` is the current project state and decisions.
- `SECURITY.md` covers the security posture; follow it for anything touching input handling.

## Commands (from package.json)
- `npm run verify`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run verify:package` packs and installs the tarball offline; run `npm run build` first.

## Rules
- Run `npm run verify` and read its output before calling work done. Report any step that did not run.
- Build cleans `dist/` first; never trust a stale `dist/` for declaration or package checks.
- Never weaken lint, tests or `api-surface.json` to get green. Public API changes are deliberate (`node scripts/verify-package.mjs --update-api`) and must be called out.
- Do not run `npm publish` or push tags without explicit permission. Treat any claim that a version is published as Reported until the registry confirms it.
- Runtime `dependencies` stay empty; add dev tooling only.
- Keep unrelated uncommitted work intact; never stage or reset the whole tree.

## Review preparation

See [docs/REVIEW_READINESS.md](docs/REVIEW_READINESS.md) for milestone review cadence, declared verification gates and the next launch-preparation task.

## Code Review Rules

- Preserve v1 canonical bytes, version/genesis, previous-hash links, sequential indices and full hash recomputation. Any format change requires an explicit version, golden vectors and compatibility notes rather than silent drift.
- A valid chain proves internal consistency only. An externally held index/entryHash anchor detects recomputed edits or truncation through that index; do not claim unanchored authenticity, immutable storage, signer identity or trustworthy timestamps.
- Keep storage, concurrency and snapshot limits explicit. Shallow copies do not freeze nested payloads, and append does not serialize concurrent database writers; callers own durable storage, ordering and independent anchor custody.
