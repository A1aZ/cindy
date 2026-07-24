/**
 * RemoteHost — one SSH connection to one remote machine.
 *
 * State machine:
 *   disconnected → connecting → authenticating → ready
 *                                                  ↓
 *                          (socket loss / keepalive timeout)
 *                                                  ↓
 *                     reconnecting (exp backoff, capped) → ready | failed
 *
 * Phase A: lifecycle (connect/disconnect/keepalive/reconnect).
 * Phase B: exec / execStream channels for one-shot commands and
 *          streaming spawns (Claude/Codex on remote, bootstrap.sh).
 *
 * NOT YET (Phase C): shell PTY tab, sftp, session ingest.
 */

import { EventEmitter } from 'node:events';
import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';

import type { HostConfig, HostSnapshot, RemoteStatus } from './types.js';
import { resolveAuth } from './credentials.js';
import { type HostKeyStore, hostKeyFingerprint, hostKeyId, decideHostKey } from './hostKeys.js';

export interface RemoteHostDeps {
  logger: {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
  };
  /**
   * Persisted trusted host-key fingerprints (TOFU). When omitted, connects
   * fail closed — we refuse rather than silently trust an unverified key.
   * ConnectionPool injects one built from its `knownHostsPath`.
   */
  hostKeys?: HostKeyStore;
}

const READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const KEEPALIVE_COUNT_MAX = 3;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;

export type StatusListener = (snapshot: HostSnapshot) => void;

export interface ExecOpts {
  /** stdin payload; channel is `end()`-ed after the write. */
  /** Stdin payload — string for text scripts, Buffer for binary bundles (e.g. cc-manager .mjs upload). */
  input?: string | Buffer;
  /** kill the channel after this many ms. Default 60_000. */
  timeoutMs?: number;
  /** environment vars sent to remote (subject to sshd `AcceptEnv`). */
  env?: Record<string, string>;
  /**
   * Caller-controlled label used in timeout / error messages — the raw
   * `cmd` is deliberately NEVER echoed (cmd may carry secrets via inline
   * env vars or wrapper scripts). Falls back to literal `"exec"`.
   */
  label?: string;
  /**
   * Per-stream byte cap enforced **while reading the channel** — the moment
   * stdout or stderr crosses the cap, buffering stops and the remote command
   * is torn down (TERM + close), resolving with `truncated: true`. Without
   * this, an arbitrary command (`cat` on a multi-GB log, `yes`) accumulates
   * unbounded strings in the Electron main process until timeout. Callers
   * running untrusted / model-authored commands (cindy_ssh MCP) MUST set it.
   * Default: unlimited (legacy behavior for short trusted probes).
   */
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  /** true when `maxOutputBytes` kicked in — output is partial and the command was torn down early. */
  truncated?: boolean;
}

export interface ExecStreamOpts {
  pty?: boolean;
  env?: Record<string, string>;
}

export interface ExecStreamHandle {
  write(data: string | Buffer): void;
  end(data?: string | Buffer): void;
  /** UTF-8 解码后的文本流; 二进制 transport (codex app-server proxy 的 WS frame)
   *  必须改用 `onStdoutBytes`, 否则 toString 会破坏字节。 */
  onStdout(cb: (chunk: string) => void): () => void;
  /** 原始字节流; 用于在 ssh channel 上跑二进制协议 (e.g. WebSocket frames). */
  onStdoutBytes(cb: (chunk: Buffer) => void): () => void;
  onStderr(cb: (chunk: string) => void): () => void;
  onClose(cb: (info: { code: number | null; signal: string | null }) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
  /**
   * Try to terminate the remote process. ssh2's `channel.signal()` is
   * subject to OpenSSH server config (`AcceptEnv` / `PermitSignal`); many
   * servers reject it silently. As a fallback we also close the channel,
   * which sends SIGHUP via SSH session teardown.
   */
  kill(signal?: string): void;
}

/**
 * Heuristic — does this ssh2 error message indicate an auth failure
 * (as opposed to network / DNS / handshake)? Auth failures are
 * deterministic: retrying with the same credentials will produce the same
 * outcome, so we use this to short-circuit the auto-reconnect loop AND
 * to swap in an actionable "fix your auth" message in place of the
 * opaque "All configured authentication methods failed".
 *
 * Match list comes from ssh2 source + observed messages from common
 * sshd implementations. False positives here just suppress retries
 * (acceptable); false negatives let the loop spin (already capped at 5).
 */
export function isAuthFailure(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('all configured authentication') ||
    lower.includes('authentication failed') ||
    lower.includes('auth failed') ||
    lower.includes('permission denied') ||
    lower.includes('no matching authentication') ||
    // authFailureHint() 的改写产物也必须被识别:connect() 失败时 lastError /
    // reject message 已被换成友好文案,后续判定(reconnect 跳过、IPC 分类、
    // cindy_ssh 错误码)都跑在改写后的字符串上。不识别会把确定性的认证失败
    // 降级成"可重试的连接失败"。与 authFailureHint 的三种文案一一对应,
    // 改 hint 措辞时必须同步这里(有 invariant 单测拦截)。
    lower.includes('has no key the remote accepts') ||
    lower.includes('was rejected by the remote')
  );
}

/**
 * Build a one-line user-facing message for an auth failure. Subtitle in
 * the host row + toast both show this verbatim — keep it under ~120 chars
 * so it doesn't ellipsize. CLI command text stays English (shell commands
 * are English) but a future improvement could split this into structured
 * fields for full i18n.
 */
export function authFailureHint(cfg: HostConfig): string {
  const portArg = cfg.port && cfg.port !== 22 ? `-p ${cfg.port} ` : '';
  if (cfg.authMethod === 'agent') {
    return `SSH agent has no key the remote accepts. Run \`ssh-copy-id ${portArg}${cfg.user}@${cfg.hostname}\` from your terminal to install your pubkey, or re-add this host with "Identity file" auth.`;
  }
  if (cfg.authMethod === 'key') {
    const file = cfg.identityFile ?? '(unset)';
    return `Identity file ${file} was rejected by the remote. Verify the file is the right key for ${cfg.user}@${cfg.hostname}, or run \`ssh-copy-id ${portArg}-i ${file}.pub ${cfg.user}@${cfg.hostname}\` to install it.`;
  }
  return `Authentication failed connecting as ${cfg.user}@${cfg.hostname}.`;
}

function wrapChannel(channel: ClientChannel): ExecStreamHandle {
  const stdoutListeners = new Set<(s: string) => void>();
  const stdoutBytesListeners = new Set<(b: Buffer) => void>();
  const stderrListeners = new Set<(s: string) => void>();
  const closeListeners = new Set<(i: { code: number | null; signal: string | null }) => void>();
  const errorListeners = new Set<(e: Error) => void>();

  channel.on('data', (chunk: Buffer) => {
    // Bytes 路径优先 (二进制协议如 WS frame), 然后 text 路径 — 同一 chunk 可能两边
    // 都有 listener (虽然实际不该混用)。
    if (stdoutBytesListeners.size > 0) {
      for (const cb of stdoutBytesListeners) cb(chunk);
    }
    if (stdoutListeners.size > 0) {
      const s = chunk.toString('utf8');
      for (const cb of stdoutListeners) cb(s);
    }
  });
  channel.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    for (const cb of stderrListeners) cb(s);
  });
  channel.on('close', (code: number | null, signal: string | null) => {
    for (const cb of closeListeners) cb({ code, signal });
  });
  channel.on('error', (err: Error) => {
    for (const cb of errorListeners) cb(err);
  });

  return {
    write: (data) => { channel.write(data); },
    end: (data) => { if (data != null) channel.end(data); else channel.end(); },
    onStdout: (cb) => { stdoutListeners.add(cb); return () => { stdoutListeners.delete(cb); }; },
    onStdoutBytes: (cb) => { stdoutBytesListeners.add(cb); return () => { stdoutBytesListeners.delete(cb); }; },
    onStderr: (cb) => { stderrListeners.add(cb); return () => { stderrListeners.delete(cb); }; },
    onClose: (cb) => { closeListeners.add(cb); return () => { closeListeners.delete(cb); }; },
    onError: (cb) => { errorListeners.add(cb); return () => { errorListeners.delete(cb); }; },
    kill: (signal = 'TERM') => {
      try { channel.signal(signal); } catch { /* server may reject */ }
      try { channel.close(); } catch { /* already gone */ }
    },
  };
}

export class RemoteHost {
  readonly id: string;
  private cfg: HostConfig;
  private status: RemoteStatus = 'disconnected';
  private lastError: string | undefined;
  /**
   * Human-readable label for the credential that succeeded on the most
   * recent successful connect, e.g. "ssh-agent" or "key:id_ed25519".
   * Surfaced to the UI so the user can verify *which* key actually got
   * them in — important when an identityFile is set but agent fallback
   * means the named key isn't actually being used (or vice versa).
   */
  private lastAuthLabel: string | undefined;
  private statusChangedAt = Date.now();
  private client: Client | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** true = user explicitly asked to disconnect; suppress auto-reconnect. */
  private userDisconnected = false;
  private events = new EventEmitter();
  private readonly log: RemoteHostDeps['logger'];
  private readonly hostKeys?: HostKeyStore;
  /**
   * Set by the host-key verifier when it rejects a connect, so onError can
   * surface an actionable message instead of ssh2's opaque handshake error.
   * Reset at the start of every connect attempt.
   */
  private hostKeyError: string | null = null;

  constructor(config: HostConfig, deps: RemoteHostDeps) {
    this.id = config.id;
    this.cfg = config;
    this.log = deps.logger;
    this.hostKeys = deps.hostKeys;
  }

  get config(): HostConfig {
    return this.cfg;
  }

  getStatus(): RemoteStatus {
    return this.status;
  }

  /**
   * Replace config (e.g. user edited hostname/port). Caller is responsible
   * for reconnecting — we don't auto-bounce because the caller might have
   * already disconnected first, and bouncing here would re-trigger auth.
   *
   * Emits a `status` event with the new snapshot so renderer's host-list
   * mirror updates without a separate IPC round-trip.
   */
  updateConfig(next: HostConfig): void {
    if (next.id !== this.cfg.id) {
      throw new Error(`RemoteHost.updateConfig: id mismatch (${next.id} != ${this.cfg.id})`);
    }
    this.cfg = next;
    this.events.emit('status', this.snapshot());
  }

  snapshot(): HostSnapshot {
    return {
      config: this.cfg,
      status: this.status,
      lastError: this.lastError,
      lastAuthLabel: this.lastAuthLabel,
      statusChangedAt: this.statusChangedAt,
    };
  }

  onStatus(listener: StatusListener): () => void {
    this.events.on('status', listener);
    return () => this.events.off('status', listener);
  }

  /**
   * Open the connection. Idempotent — if already ready/connecting, returns
   * the in-flight promise. Throws on definitive failure (auth, network).
   */
  async connect(): Promise<void> {
    if (this.status === 'ready') return;
    if (this.status === 'connecting' || this.status === 'authenticating') {
      // Wait for the in-flight attempt to settle (success or fail). After
      // the await `this.status` is mutated; TS still has the pre-await
      // narrowing, so we re-read through `getStatus()`.
      await this.waitForTerminal();
      if (this.getStatus() === 'ready') return;
      throw new Error(this.lastError ?? 'connect failed');
    }

    // 'reconnecting' / 'disconnected' / 'failed' 都走立即新建连接路径。
    // 关键: 'reconnecting' 状态下 reconnectTimer 仍在跑, 它稍后还会再调一次
    // doConnect() 覆盖我们刚建好的 SSH client, 产生泄漏的旧连接 + 乱序的
    // status/channel 事件。必须在 doConnect() 前显式清掉 timer 才安全。
    this.clearReconnectTimer();
    this.userDisconnected = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  /**
   * Close the connection. Idempotent. Suppresses auto-reconnect until
   * next explicit `connect()` call.
   */
  async disconnect(): Promise<void> {
    this.userDisconnected = true;
    this.clearReconnectTimer();
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // swallow — `end` on a half-dead client occasionally throws
      }
      this.client = null;
    }
    this.setStatus('disconnected');
  }

  // ── channels (Phase B) ──────────────────────────────────────────────────

  /**
   * Run a one-shot command and collect stdout/stderr/exit. Use for short,
   * non-interactive commands (version probes, install scripts).
   *
   * `input`, when set, is written to stdin then the channel is closed.
   * `timeoutMs` defaults to 60 s — long enough for `npm install`. Caller
   * should raise it for known-slow ops (e.g. agent install on a clean box).
   *
   * Error messages NEVER include the cmd string — callers routinely pass
   * commands containing secrets (e.g. `ANTHROPIC_API_KEY=...` env injection
   * via wrapper scripts). Leaking cmd into an error would land it in
   * xdt-maker logs via the unified IPC error path. Use `label` for caller-
   * controlled context in error messages.
   */
  async exec(cmd: string, opts?: ExecOpts): Promise<ExecResult> {
    const client = this.requireReady();
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const label = opts?.label ?? 'exec';

    return await new Promise<ExecResult>((resolve, reject) => {
      client.exec(cmd, { env: opts?.env }, (err, channel) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';
        let exitCode: number | null = null;
        let signal: string | null = null;
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { channel.signal('TERM'); } catch { /* server may reject SIGTERM */ }
          try { channel.close(); } catch { /* already gone */ }
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        // maxOutputBytes:边读边计数,越界即停止缓冲并 teardown 远端命令,
        // 防止任意命令把无上限输出攒进 main 进程内存。teardown 后照常等
        // 'close' 事件 resolve(truncated 标记),与超时路径共用 TERM+close
        // 兜底(channel.signal 可能被 sshd 静默拒绝,close 触发 SIGHUP)。
        const maxOutputBytes = opts?.maxOutputBytes;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let truncated = false;
        const teardownOnCap = (): void => {
          if (truncated) return;
          truncated = true;
          try { channel.signal('TERM'); } catch { /* server may reject SIGTERM */ }
          try { channel.close(); } catch { /* already gone */ }
        };
        const takeCapped = (chunk: Buffer, usedBytes: number): Buffer | null => {
          if (maxOutputBytes == null) return chunk;
          if (usedBytes >= maxOutputBytes) { teardownOnCap(); return null; }
          if (usedBytes + chunk.length <= maxOutputBytes) return chunk;
          teardownOnCap();
          return chunk.subarray(0, maxOutputBytes - usedBytes);
        };

        channel.on('data', (chunk: Buffer) => {
          const kept = takeCapped(chunk, stdoutBytes);
          if (!kept) return;
          stdoutBytes += kept.length;
          stdout += kept.toString('utf8');
        });
        channel.stderr.on('data', (chunk: Buffer) => {
          const kept = takeCapped(chunk, stderrBytes);
          if (!kept) return;
          stderrBytes += kept.length;
          stderr += kept.toString('utf8');
        });
        channel.on('close', (code: number | null, sig: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          exitCode = code;
          signal = sig;
          resolve({ stdout, stderr, exitCode, signal, ...(truncated ? { truncated: true } : {}) });
        });
        channel.on('error', (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        });

        if (opts?.input != null) {
          channel.write(opts.input);
          channel.end();
        }
      });
    });
  }

  /**
   * Open a streaming exec channel. Caller drives stdin (for interactive
   * tools like Claude Code's `--input-format stream-json`) and consumes
   * stdout / stderr via callbacks. Lifecycle ends on `close` or `kill()`.
   *
   * No timeout — caller owns lifetime. Streams stay open across long
   * agent sessions.
   */
  async execStream(cmd: string, opts?: ExecStreamOpts): Promise<ExecStreamHandle> {
    const client = this.requireReady();
    return await new Promise<ExecStreamHandle>((resolve, reject) => {
      const execOpts: { pty?: boolean | object; env?: Record<string, string> } = {};
      if (opts?.pty) execOpts.pty = true;
      if (opts?.env) execOpts.env = opts.env;

      client.exec(cmd, execOpts, (err, channel) => {
        if (err) return reject(err);
        resolve(wrapChannel(channel));
      });
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Guard for channel ops. */
  private requireReady(): Client {
    if (this.status !== 'ready' || !this.client) {
      throw new Error(`remote host "${this.id}" is not ready (status=${this.status})`);
    }
    return this.client;
  }

  /**
   * ssh2 `hostVerifier` — TOFU against the injected store. Returns true to
   * accept the handshake, false to reject it (ssh2 then emits an error which
   * onError maps to `hostKeyError`). Fails closed: a missing store or a read
   * error refuses the connect rather than trusting an unverified key.
   */
  private async verifyHostKey(hostKey: Buffer): Promise<boolean> {
    const store = this.hostKeys;
    if (!store) {
      this.hostKeyError =
        'SSH host key verification is not configured; refusing to connect without it.';
      this.log.error('ssh host key store missing — refusing connect', { id: this.id });
      return false;
    }
    // Discard any stale in-memory cache so a user who repaired known-hosts.json
    // (e.g. removed a stale entry after a legitimate server re-key) sees the
    // update on reconnect without restarting the app.
    store.reload();
    const presented = hostKeyFingerprint(hostKey);
    const storeKey = hostKeyId(this.cfg.hostname, this.cfg.port);
    let stored: string | null;
    try {
      stored = await store.get(storeKey);
    } catch (err) {
      this.hostKeyError = `failed to read trusted host keys: ${(err as Error).message}`;
      this.log.error('ssh known-hosts read failed — refusing connect', {
        id: this.id,
        error: (err as Error).message,
      });
      return false;
    }

    const decision = decideHostKey(stored, presented);
    if (decision === 'match') return true;
    if (decision === 'trust-new') {
      try {
        await store.set(storeKey, presented);
      } catch (err) {
        // Cannot persist the trusted fingerprint — refuse the connection.
        // Proceeding without persistence means the next reconnect would
        // re-enter trust-new and silently accept any key, defeating TOFU.
        this.hostKeyError = `failed to persist trusted host key: ${(err as Error).message}`;
        this.log.error('ssh known-hosts write failed — refusing connect', {
          id: this.id,
          error: (err as Error).message,
        });
        return false;
      }
      this.log.info('ssh host key trusted on first use', {
        id: this.id,
        host: storeKey,
        fingerprint: presented,
      });
      return true;
    }
    // mismatch
    this.hostKeyError =
      `Remote host key for ${storeKey} changed (${presented}) and no longer matches the ` +
      `previously trusted key. This can mean the server was reinstalled — or a ` +
      `man-in-the-middle. Connection refused. If you trust the change, remove the stale ` +
      `entry from maker's known hosts and reconnect.`;
    this.log.error('ssh host key mismatch — refusing connect', {
      id: this.id,
      host: storeKey,
      presented,
      trusted: stored,
    });
    return false;
  }

  private async doConnect(): Promise<void> {
    this.setStatus('connecting');
    this.hostKeyError = null;

    let auth;
    try {
      auth = await resolveAuth(this.cfg);
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = msg;
      this.setStatus('failed');
      throw err;
    }

    const client = new Client();
    this.client = client;

    const connectConfig: ConnectConfig = {
      host: this.cfg.hostname,
      port: this.cfg.port,
      username: this.cfg.user,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      // TOFU host key check — without this ssh2 trusts any presented key (MITM).
      hostVerifier: (hostKey: Buffer, verify: (valid: boolean) => void): void => {
        void this.verifyHostKey(hostKey).then(verify, () => verify(false));
      },
      ...(auth.agent ? { agent: auth.agent } : {}),
      ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
      ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
    };

    this.log.debug('ssh connecting', {
      id: this.id,
      hostname: this.cfg.hostname,
      port: this.cfg.port,
      auth: auth.label,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onReady = () => {
        if (settled) return;
        settled = true;
        this.lastError = undefined;
        this.lastAuthLabel = auth.label;
        this.reconnectAttempts = 0;
        this.setStatus('ready');
        this.log.info('ssh ready', { id: this.id, auth: auth.label });
        resolve();
      };

      const onError = (err: Error) => {
        if (settled) {
          // Post-ready error — feed into reconnect path, not the connect promise.
          this.handlePostReadyError(err);
          return;
        }
        settled = true;
        // A rejected host key surfaces here as an opaque ssh2 handshake error;
        // prefer the actionable MITM/re-key message the verifier stashed.
        // Otherwise swap opaque "All configured authentication methods failed"
        // for a hint pointing at ssh-copy-id / identity file. The host row
        // subtitle + connect-failure toast both surface this verbatim.
        this.lastError = this.hostKeyError
          ? this.hostKeyError
          : isAuthFailure(err.message)
            ? authFailureHint(this.cfg)
            : err.message;
        this.client = null;
        this.setStatus('failed');
        this.log.warn('ssh connect failed', { id: this.id, error: err.message });
        // Reject with the friendly message so IPC layer's toast also gets
        // the actionable copy (it pulls from `.message`).
        const rejectErr = new Error(this.lastError);
        // Preserve original for tests / debugging that key off message text.
        (rejectErr as Error & { cause?: unknown }).cause = err;
        reject(rejectErr);
      };

      const onClose = () => {
        if (!settled) {
          settled = true;
          const msg = this.lastError ?? 'connection closed before ready';
          this.lastError = msg;
          this.client = null;
          this.setStatus('failed');
          reject(new Error(msg));
          return;
        }
        // Post-ready close — schedule reconnect unless user-initiated.
        this.handlePostReadyClose();
      };

      // ssh2 emits 'handshake' before 'ready' — repurpose to advance state
      // so renderer can show "authenticating" instead of staying on
      // "connecting" throughout auth.
      client.on('handshake', () => this.setStatus('authenticating'));
      client.on('ready', onReady);
      client.on('error', onError);
      client.on('close', onClose);

      try {
        client.connect(connectConfig);
      } catch (err) {
        onError(err as Error);
      }
    });
  }

  private handlePostReadyError(err: Error): void {
    this.lastError = err.message;
    this.log.warn('ssh post-ready error', { id: this.id, error: err.message });
    // 'close' will follow — reconnect is handled there to avoid double-scheduling.
  }

  private handlePostReadyClose(): void {
    this.client = null;
    if (this.userDisconnected) {
      this.setStatus('disconnected');
      return;
    }
    // Auth failures are deterministic — retrying with the same agent / key
    // produces the same outcome. Fail fast so the user sees the actionable
    // hint immediately instead of waiting 30+ s for the backoff to give up.
    // Auto-reconnect's intended target is transient network failures
    // (DNS hiccup, keepalive timeout) — those benefit from retry.
    if (this.lastError && isAuthFailure(this.lastError)) {
      this.log.info('ssh skipping reconnect (auth failure is deterministic)', {
        id: this.id,
      });
      this.setStatus('failed');
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('failed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts += 1;
    // Exponential backoff capped at 30s. attempt=1 → 1s, 2 → 2s, 3 → 4s, ...
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      30_000,
    );
    this.setStatus('reconnecting');
    this.log.info('ssh scheduling reconnect', {
      id: this.id,
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.doConnect().catch((err) => {
        // doConnect already set status=failed and recorded lastError.
        // If we still have attempts left, schedule again.
        if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS && !this.userDisconnected) {
          this.scheduleReconnect();
        } else {
          this.log.error('ssh reconnect exhausted', { id: this.id, error: (err as Error).message });
        }
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(next: RemoteStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.statusChangedAt = Date.now();
    this.events.emit('status', this.snapshot());
  }

  /** Wait until status leaves {connecting, authenticating}. */
  private waitForTerminal(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.onStatus((snap) => {
        if (snap.status !== 'connecting' && snap.status !== 'authenticating') {
          off();
          resolve();
        }
      });
    });
  }
}
