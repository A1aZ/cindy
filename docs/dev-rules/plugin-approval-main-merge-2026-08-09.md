# Plugin Approval PR Main Merge Strategy (2026-08-09)

This note records the merge decisions for PR #1916 after merging `origin/main` at
`e78f44ae5`. It is a decision record, not a replacement for the authoritative
security rules.

## Invariants

- Host-owned approval receipts remain the only runtime authorization fact. Mutable
  install-directory trust mirrors are migration or display inputs only.
- A durable owner boundary is published before local session publication. Missing,
  malformed, pending, mismatched, or durability-uncertain state fails closed.
- Every owner-bound Ghost, Agent, broker, slot, skill-link, and IPC consumer must
  use the same durable owner and in-process owner generation.
- Passive shared-userData instances are read-only for the global projection. They
  must not sweep links, publish a different owner, or turn a primary owner's
  projection into another account's projection.
- Content and manifest reads keep no-follow, containment, handle identity, and
  post-read stability checks. A main-branch convenience path must not reintroduce
  path-based TOCTOU reads.
- Existing approved plugins remain compatible without reinstall or reapproval.
  New security checks may reject only malformed or untrusted state, not a valid
  historical receipt that can be migrated equivalently.

## Conflict decisions

- **Trust and GhostManager:** retain main's complete official-trust validation and
  the PR's rule that a mutable `.cindy-trust.json` cannot mint approval. Keep the
  PR's receipt, approval projection, journal, owner, and failure-closed paths.
- **Bounded reads:** combine the PR's no-follow/stable-read implementation with
  main's optional non-blocking, hard-link, and stat-returning APIs. No caller may
  downgrade a stability or containment failure into an approved projection.
- **Built-in provisioning:** retain the PR's seed fingerprint, link-free checks,
  durable tombstone/seed ledger, and rollback semantics; wrap the complete per-id
  installed-directory exchange in main's Ghost install lock. Locking does not
  replace owner lease or the durable provisioning state machine.
- **Market install/update:** retain `expectedInstalledApproval`, reviewed manifest
  and baseline checks, and the receipt token at the final commit. Also retain
  main's `beforeCommitInLock` callback and stale-baseline behavior, executing the
  callback while the per-Ghost lock is held and the owner lease remains held.
- **Permission fingerprints:** use main's `detailKey/detailArgs` projection for
  user-visible permission explanations, while preserving the PR's stable approval
  baseline and `diffInstalledGhostPermissionItems` behavior. Normalize equivalent
  GitHub credential detail keys only where the existing compatibility rule says the
  capability is unchanged.
- **Auth cold start:** retain the PR's account-free recovery for local and
  signed-out exits. Incorporate main's same-owner cold-start fast path and delayed
  teardown only when `shouldTeardownColdStartRuntime` proves a real owner change;
  never dispose a newly-created same-owner runtime as an account switch.
- **Subscription hooks:** retain the PR's captured owner validation before and after
  wake. Incorporate main's deadline-aware wake and resolved context payload, but
  discard the result if the hook was cancelled or the durable owner changed.
- **Tests and documentation:** keep the union of security regression tests and main
  behavioral tests. A source-contract test may supplement, but never replace,
  behavioral coverage for authorization, locking, recovery, or filesystem state.

## Do not accept during conflict resolution

- Direct authorization from install-directory mirrors, renderer-provided tokens,
  mutable manifests, or a stale in-memory session.
- A fast return that leaves an old global skill projection visible to local,
  signed-out, or passive sessions.
- A path-based read/write that drops no-follow, containment, identity, or stability
  validation because main added a convenience helper.
- A lock-only solution that omits the owner lease, or an owner lease that omits the
  per-Ghost mutation lock where both are required.
- A test-only weakening, skipped test, or branch-specific assertion that hides a
  conflict instead of expressing the merged behavior.

## Post-merge gate

After all conflicts are resolved: inspect the complete diff, verify no unmerged
entries, run targeted plugin/auth/Forge tests, run all workspace typechecks, run the
full `pnpm test:unit` gate, then perform an independent review before committing or
 pushing the merge result.
