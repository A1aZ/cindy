# Windows input device detection — validation report

## Scope and baseline

User journeys: discover Codex Micro and gamepads in Keyboard Shortcuts on Windows,
without changing enabled preferences or regressing macOS. No supplied plan.
Branch `codex/fix-windows-input-device-detection` was created from freshly fetched
`origin/main` at `1b379ba5d3dc5caf53e387540d70a9d24f8e6353` on 2026-09-09.
Implementation and local validation were completed before PR submission.
A pre-migration stash was retained as a recovery copy.

## Evidence

- Desktop RED: `pnpm --filter desktop exec vitest run src/main/worklouder-codex/__tests__/sdkResolver.test.ts src/main/xbox-gamepad/__tests__/host.test.ts`
  reproduced missing Store discovery (query never called) and Windows helper rejection
  (`Xbox gamepad helper is not available on win32`). 3 failed, 17 passed.
- Native RED: `cargo test --manifest-path apps/desktop/native/xbox-gamepad/windows-gamepad-helper/Cargo.toml`
  executed the initial mapping regressions: 2 failed (null frame and generic family).
- Desktop GREEN: the same tests passed after implementation. Adding controller tests
  (`src/main/xbox-gamepad/__tests__/controller.test.ts`) and SDK cooldown/path tests yielded 34 passing tests.
- Native GREEN: `cargo test --locked --manifest-path apps/desktop/native/xbox-gamepad/windows-gamepad-helper/Cargo.toml`
  passed 5 tests: all supported digital buttons, analog inputs, neutral release,
  vendor family recognition, and vendor precedence over display name.
- `pnpm test:unit:related`: PASS (Desktop, 198.4 seconds).
- `cargo build --locked --release --manifest-path apps/desktop/native/xbox-gamepad/windows-gamepad-helper/Cargo.toml`: PASS on Windows x64.
- `cargo clippy --locked --manifest-path apps/desktop/native/xbox-gamepad/windows-gamepad-helper/Cargo.toml -- -D warnings`: PASS.
- Targeted ESLint and `git diff --check`: PASS.
- Desktop typecheck initially failed on a missing workspace dependency link for
  `@cindy/model-providers/pi-thinking-levels`. `pnpm install --frozen-lockfile --ignore-scripts`
  restored the link without source/lockfile changes; the repeat check passed.

## Bridge-specific correction after hardware confirmation

- The user confirmed the target is the N4 Bridge virtual device, not original hardware.
  Windows exposes two collections for VID/PID `303A:8360`: primary `FF00/1` and
  companion `FF70/1`, with interface number `-1`. The new helper matches only the
  primary collection, without assuming USB interface 0 or using the companion stream.
- Added an independent Windows native Micro backend using HIDAPI and the public
  Micro-compatible JSON report format. It does not import, copy, or redistribute
  the proprietary SDK or the external bridge's implementation.
- A locally available SDK / ordinary app installation keeps its existing precedence.
  Without one, Windows uses Cindy's bundled native helper, before Store SDK lookup.
- Native bridge RED: all 5 initial framing/filter/input/lighting tests failed before
  implementation. GREEN: 7 native tests pass, including buffer bounds and release lighting.
- Desktop backend RED: native fallback returned null. GREEN: SDK resolver and native
  child adapter tests pass, including queued startup, disposal races, bounded malformed
  output and exactly-once failure/exit delivery.
- Full device suites: `pnpm --filter desktop exec vitest run src/main/worklouder-codex/__tests__ src/main/xbox-gamepad/__tests__`
  passed 298 tests, with 1 pre-existing skipped test. A subsequently added adapter
  buffer-bound regression also passed (4 adapter tests total).
- Real Windows bridge validation passed both directly and through
  `WorkLouderCodexHostClient` + `WindowsMicroHost`: `presence=true`, firmware
  `0.1.0-n4-emulator`, `connected`, then clean disposal. Only a status RPC was sent;
  no synthetic keys were injected into the user's running applications.
- Both native helpers built release binaries; Clippy passed. Their Cargo manifests
  are included in the license generator; regenerated notices and all 9 notice tests pass.
- Final Desktop typecheck passed. An earlier total gate attempt was blocked before
  Desktop tests: `test:runner` scans unrelated `.cindy-worktrees/silent-bohr` tests and
  failed its Windows symlink-skip rule. Reproduced twice before cleanup was authorized.

## P1 review fixes

- Trigger hysteresis: Windows now emits digital LT/RT from per-device `TriggerState`.
  State survives periodic enumeration and forced probes, but resets on replacement.
  The RED reproducer had missing digital trigger fields; GREEN covers pressure
  `0 → 0.6 → 0.5 → 0.6 → 0.41 → 0.4 → 0.5 → 0.55` for both triggers.
  Controller integration tests verify one voice press/release rather than recording churn.
- Micro joystick: `v.oai.rad` and bare `{a,d}` now produce `kind: joystick`; finite
  normalized `[0,1]` bounds, direction samples and centering are tested. The RED
  reproducer returned `None`; GREEN includes native parsing plus adapter validation.
- Development cache: the build directory now includes a hash of the canonical source
  checkout path. Two older checkouts sharing a dev profile build distinct binaries,
  while repeated resolution in the same checkout still reuses its cache. The RED
  reproducer returned the first checkout's binary for both; GREEN covers both helpers.
  These are in-memory tests and never touch real userData or another worktree.
- P1 verification: 25 Desktop test files passed (304 tests, 1 existing skip);
  6 gamepad Rust tests and 9 Micro Rust tests passed; both release builds and Clippy
  passed. Targeted ESLint, `git diff --check`, and the new Desktop typecheck passed.
- The first P1 `pnpm test:unit:related` rerun was blocked by the unrelated
  `.cindy-worktrees/silent-bohr` symlink-test scan (504 runner tests pass, 1 fails).
  No test bypass, foreign worktree edit, commit or push was performed.

## Authorized blocker cleanup and final gate

- The user explicitly authorized discarding `.cindy-worktrees/silent-bohr`.
  Its 9 untracked architecture documents/screenshots were archived and verified
  before removing the worktree. Branch `cindy/silent-bohr` was retained.
- After removal, `pnpm test:unit:related` passed: runner 505 passed / 0 failed
  (8 existing skips, 21.1 seconds); Desktop related unit tier passed (154.1 seconds).
  No gate was bypassed. The device-fix branch and its source changes were preserved.

## Hardware and platform limits

- The actual Store inventory query found the installed `OpenAI.Codex` package.
  The SDK exists below `app/resources/app.asar/node_modules/@worklouder/device-kit-oai`.
- Loading that SDK from both Cindy's Electron runtime and Node failed with
  `ERR_DLOPEN_FAILED: Access is denied` on its bundled serialport native addon.
  The native fallback now avoids that failure for the confirmed bridge.
  No ACL changes, SDK copying, or native-loader substitutions were attempted.
- The Windows release helper emitted all four initial absence messages, responded
  to `probe`, and exited with code 0 on `stop`. No active controller was enumerated
  during the smoke test; live button/axis input and unplug/replug remain unverified.
- Windows PnP showed a paired Xbox controller and the user-confirmed
  `Mirabox N4 Codex Micro bridge`.
- Uses Windows.Gaming.Input's mapped Gamepad interface. Does not implement arbitrary
  raw HID mappings, Switch 2 USB claiming, or the OS-reserved Xbox guide button.
- macOS hardware, Windows ARM64, and UI end-to-end testing were not run.
  Native Rust tests were run explicitly, not by the Vitest related gate.
- No numerical coverage measurement was taken; an 80% coverage claim is not made.

## Local Windows test installer

- `pnpm --filter desktop release:package -- --platform win32 --arch x64 --region global --no-sign`
  completed on 2026-09-09. The first attempt exhausted Node's default 4 GB heap;
  the successful retry used command-scoped `NODE_OPTIONS=--max-old-space-size=12288`,
  restoring the original environment afterwards. No build gate was skipped.
- Output: `apps/desktop/release/artifacts/global/unversioned/win32-x64/cindy-unversioned-Setup.exe`
  (233650646 bytes). SHA-256:
  `e101b588cf6a37c6fb9c434382b1fb1086bc4e50bf9231de6e67f49413fbb591`.
- Both packaged input helpers are PE x64 and byte-for-byte SHA-256 matches of the
  current Rust target builds. The native Micro entry is present in the packaged
  `bootstrap-electron` JavaScript chunk.
- Packaged migration resource verification passed (105 SQL files). The normal
  packaged smoke test passed against a temporary, isolated userData directory:
  exit 0, schema version 104, empty sessions/messages.
- This unsigned 0.0.0 local test package does not participate in automatic updates.
  It was not installed or published. It includes the uncommitted fixes; the build-info
  commit SHA identifies the base commit, not a newly committed revision.

## Self-check

Accuracy 4/5: passing tests and actual native-load failure recorded; live input unverified.
Completeness 4/5: bridge connection verified; physical input and full UI still need validation.
Clarity 4/5: separates path discovery from functional support; findings span two different devices.
Actionability 4/5: reviewable branch and required local checks pass; physical/UI validation remains.
Conciseness 4/5: scoped main/native changes; the helper necessarily adds a native build path.
Overall 4.0/5. Would the user agree? Backend connection success is evidenced, UI success is not claimed.
Priority improvements: verify actual connected-controller input and full UI behavior.
Verdict: implementation ready for PR review and hardware/UI validation after the required local gates pass. The user authorized PR submission on 2026-09-10.
