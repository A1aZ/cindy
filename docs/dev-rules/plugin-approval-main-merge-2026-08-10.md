# Plugin Approval PR Main Merge Strategy (2026-08-10)

Second main merge for PR #1916 after merging `origin/main` at `9bcf7bd1a`.
The first merge (2026-08-09, `e78f44ae5`) is recorded in
`plugin-approval-main-merge-2026-08-09.md`. This note records the decisions for
this round only; it does not replace the authoritative security rules.

## Invariants (unchanged, carry forward)

- Host-owned approval receipts remain the only runtime authorization fact. Mutable
  install-directory trust mirrors are migration or display inputs only.
- A durable owner boundary is published before local session publication. Missing,
  malformed, pending, mismatched, or durability-uncertain state fails closed.
- Every owner-bound Ghost, Agent, broker, slot, skill-link, and IPC consumer must
  use the same durable owner and in-process owner generation.
- General Cindy account capabilities are also fail-closed unless the durable
  projection marker is `stable` for the active data owner.
- Ghost mutation owner capture and lease acquisition re-check durable owner
  stability at the mutation boundary.
- Passive shared-userData instances are read-only for the global projection.
- Content and manifest reads keep no-follow, containment, handle identity, and
  post-read stability checks.
- Existing approved plugins remain compatible without reinstall or reapproval.
  New security checks may reject only malformed or untrusted state.

## Conflict decisions (2026-08-10 round)

Six files conflicted. Resolutions below preserve the PR's invariants and absorb
main's changes without weakening fail-closed behavior.

- **GhostManager.ts:** main's newer receipt/approval/trust code and the PR's
  legacy-backfill hardening both landed. Resolution keeps the union: the PR's
  optional-icon degradation (`readLegacyIconDataUrlForApproval` catch → omit
  iconDataUrl), the removed `readInstalledHostMetadata` (mutable mirror no longer
  projected), and main's newer projection/approval helpers. Where main added a
  newer signature or helper, keep main's and route the PR's caller through it;
  never drop a containment/no-follow/identity check to satisfy a signature.
- **index.ts:** main's newer owner/mutation wiring and the PR's
  `captureGhostMutationOwner`/`beginGhostMutation` durable-stability re-check both
  land. Keep the PR's boundary re-check; incorporate main's newer session helpers
  where the call shape changed.
- **crossProcessLock.ts:** main's newer lock/reclaim code and the PR's
  nonce-bound `.released` release-marker + malformed-gate fail-closed reclaim both
  land. Keep the PR's marker bound to gate basename + valid nonce, and main's
  newer helper shapes; any release-marker/cleanup path must remove both gate and
  marker and stay fail-closed on identity-unresolvable / EPERM / EACCES.
- **shared/ghost.ts:** main introduced a narrower per-item fingerprint
  (`ghostPermissionItemFingerprint` = key + detail + detailKey + detailArgs)
  for the baseline key and `unreviewedGhostPermissionItems`. The PR's
  `ghostPermissionProjectionKey`/`Fingerprint` is a superset (also fingerprints
  `kind`, the GitHub-normalized `labelKey`, and `labelArgs`), and the projection
  docs explicitly treat `labelArgs` (hosts / tool names shown in preview) as
  authorization-relevant. Dropping those fields would silently miss a
  permission-surface change on an unchanged key. Resolution keeps the PR's
  superset for baseline and unreviewed (consistent with `diffGhostPermissionItems`,
  which already uses the same superset) and removes main's now-unused
  `ghostPermissionItemFingerprint`. The GitHub credential detailKey normalization
  is retained in both directions.
- **GhostManager.test.ts:** union of both sides' regression tests; adjust only
  where main renamed a fixture/expectation. Do not weaken a behavioral assertion
  to resolve a conflict.
- **plugin-security-and-authoring.md:** keep the PR's existing text and absorb
  main's newer security-rule paragraphs; no invariant is relaxed, no rule removed.

## Do not accept during conflict resolution

- Direct authorization from install-directory mirrors, renderer-provided tokens,
  mutable manifests, or a stale in-memory session.
- A path-based read/write that drops no-follow, containment, identity, or stability
  validation because main added a convenience helper.
- A lock-only solution that omits the owner lease, or an owner lease that omits the
  per-Ghost mutation lock where both are required.
- A test-only weakening, skipped test, or branch-specific assertion that hides a
  conflict instead of expressing the merged behavior.

## Additional resolution notes

- **Submodule alignment:** the merge advanced the `cindy-protocol` gitlink to
  `dbbf169` (identical to `origin/main`). The submodule working tree was still
  on the pre-merge `56d9d9f`; it was aligned to `dbbf169` (no protocol source
  change, no gitlink edit).
- **Icon byte cap:** the PR's local `MAX_GHOST_ICON_BYTES` duplicate was removed
  in favor of the shared `GHOST_ICON_MAX_BYTES` from `shared/ghost.ts` (same
  512 KiB value; renderer/Forge already use the shared constant).
- **Test fixtures:** main's new renderer tests (`composerHostCapability.test.ts`,
  `ghostComposerPlacement.test.ts`) construct `InstalledGhost` objects without
  the PR-required `approval` field; the fixtures were given a minimal
  `{ state: 'approved', revision }` approval so they typecheck against the
  receipt model.
- **iOS Simulator test adaptation:** main's new `ios-simulator.test.ts` /
  `ios-simulator-media.test.ts` default their owner-boundary probe to
  `isAppSessionBoundaryPending()`, which the PR hardens to fail closed on an
  uncommitted/durable-unstable owner — so the suites failed on every status
  probe / media capture in the (owner-less) test environment. The suites
  exercise simulator/ownership behavior, not boundary transitions, so both
  files now mock `../../appSessionState.js` to override only
  `isAppSessionBoundaryPending: () => false`. Owner-pending paths are still
  covered by the tests that pass explicit `isOwnerBoundaryPending` /
  `isOwnerScopeCurrent` overrides; no production behavior was changed.
- **Dependency linking:** local Node 22.14 < `undici@8.7.0` engines requirement
  blocks a strict install; `pnpm install --frozen-lockfile --prefer-offline
  --config.engine-strict=false` links the workspace without touching the
  lockfile. The lockfile in the merge matches `origin/main` byte-for-byte.

## Post-merge fixes (2026-08-10 round 2)

This round fixed two Linux CI failures plus one Codex review P1:

- **crossProcessLock legacy PID-reuse takeover was platform-dependent and
  unsound.** `isRecordOwnerActive` decided a legacy record's liveness from the
  lock file's `birthtimeMs`; on filesystems where birthtime is unavailable or 0
  the same legacy takeover decided differently from platforms with a real
  birthtime, so `reclaims a legacy lock when the recorded pid was reused`
  failed on Linux, and a mtime-based fallback made the "live owner must not be
  taken over" guard timing-dependent on the parent's age. A PID-reuse takeover
  cannot be proven soundly from a legacy record (a live pid could be the
  original still-running holder mid-drain with a stale mtime). Fix:
  `isRecordOwnerActive` now treats a live non-self pid (kill(pid,0) succeeds)
  as the active holder unconditionally (fail closed, timing-independent); a
  PID-reuse takeover is only accepted when the lock's recorded
  `processStartIdentity` demonstrably does not match the current process. The
  PID-reuse test was updated to record a mismatching identity (`start-ms:0`)
  instead of relying on a sentinel startedAt + stale mtime. This is
  cross-platform stable and never squeezes out a live drain/cleanup owner.
- **Silent default upgrade minted a fresh receipt for non-approved installs.**
  `applyDefaultUpgrades` passed `expectedInstalledApproval` +
  `allowPermissionExpansion` for `legacy-unapproved`/`invalid` org defaults,
  letting `installDetail` mint a new approved receipt without user reapproval
  (Codex P1). Fix: skip the silent upgrade when `approval.state !== 'approved'`
  and leave the plugin in `update-available` so it goes through the
  reapproval/recovery flow. Added a regression test covering both
  `legacy-unapproved` and `invalid`.
- **`readBoundedFile.test.ts` carried two merge-introduced assertions that
  contradicted the implementation.** Two tests asserted every `readBoundedFile*`
  open passes `O_NONBLOCK`, but the no-follow variants only enable it via the
  `nonBlocking` option (and the synchronous variant has no such option); only
  `readBoundedFileFollowLinks` always opens non-blocking. These assertions do
  not exist in `origin/main`'s test file and were introduced by the merge.
  Fixed the assertions to match the implementation: no-follow defaults to
  blocking, `{ nonBlocking: true }` opts in, follow-links always non-blocking.
  No production code changed.

## Post-merge gate

After all conflicts are resolved: inspect the complete diff, verify no unmerged
entries, run targeted plugin/auth/Forge tests, run the desktop typecheck, run the
full `pnpm test:unit` gate, then perform an independent review before committing
or pushing the merge result.
