# macOS input helper trust boundary

The input helper authenticates its caller before inspecting any command or
requesting Accessibility permission. Node's macOS stdio socket pairs carry kernel
audit tokens; stdin, stdout and stderr must all belong to the direct Main parent
and the current user. A regular pipe, redirected channel, missing identity or
failed signature check exits with status 77 without returning clipboard content.

Packaged builds require an Apple-signed, hardened Cindy Main executable in the
same application bundle and with the helper's signing team. The application must
seal the exact helper bytes in its signed resources. This prevents transplanting
the helper into an older signed application with weaker Electron fuses. The
existing package configuration disables RunAsNode, NODE_OPTIONS and CLI inspector
arguments and enforces the sealed ASAR. Input batches and the watchdog recheck
the audit-token-bound process; loss of its identity releases held inputs and exits.
Existing Main remote-control permissions, leases and system TCC checks still apply.

Source development is a different trust boundary: generic Electron loads writable
JavaScript and exposes debugging facilities. `inputHost.ts` explicitly compiles a
development variant bound to that Electron executable's path and designated code
requirement, retaining kernel channel checks. This does **not** protect against
arbitrary code already running in that development runtime. Its cache identity is
stable across Main restarts. Neither CLI arguments nor environment variables can
enable this variant in a packaged helper; failed production authentication never
falls back to it. Ad-hoc/unsigned packaged builds fail closed and are not a
substitute for the development workflow or a properly signed distribution.

The native tests exercise real audit-token and Security APIs without posting
events, reading selections or prompting for permissions. They cover ordinary
process calls to every production command, channel redirection, forged runtime
development flags, stale audit tokens, and signed-resource helper replacement.
The resource fixture is ad-hoc signed: it verifies resource sealing, **not** the
production Apple/team acceptance path. A signed application launch and TCC flow
must still be checked during release validation.
