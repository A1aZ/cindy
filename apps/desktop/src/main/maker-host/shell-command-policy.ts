/**
 * Product-owned shell command policy for the embedded iOS Simulator.
 *
 * Agent skills may contain legacy `simctl` / `open -a Simulator` recipes. Those
 * commands bypass Cindy's ownership, admission, viewer, and cleanup contracts,
 * so prompt guidance alone is not a sufficient boundary. This module detects
 * executable shell segments and denies only the bypass paths; Cindy's own main
 * process still uses simctl through the runtime adapter and is unaffected.
 */

export interface ShellCommandPolicyDenial {
  decision: 'deny';
  reason: string;
}

const SAFE_SIMCTL_COMMANDS = new Set([
  'help',
  'list',
  'listapps',
  'getenv',
  'get_app_container',
  'diagnose',
]);

const IOS_SIMULATOR_SHELL_DENIAL =
  'Cindy blocked a shell command that would bypass the embedded iOS Simulator. ' +
  'Use cindy_ios_simulator for device lifecycle, app install/launch, interaction, screenshots, and diagnostics. External Simulator.app automation is unavailable until Cindy can issue an explicit host authorization.';

/** Split command lists without treating separators inside quotes as executable boundaries. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Lightweight argv tokenizer. Quotes group tokens but are not retained. */
function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    if (!started) return;
    tokens.push(token);
    token = '';
    started = false;
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === '\\' && quote !== "'" && index + 1 < segment.length) {
      token += segment[index + 1]!;
      started = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      flush();
    } else {
      token += char;
      started = true;
    }
  }
  flush();
  return tokens;
}

function executableName(token: string | undefined): string {
  return (token ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)!
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

function stripShellControlTokens(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 0 && /^(?:\{|\(|!|then|do|else|elif|if|while|until)$/.test(out[0]!)) {
    out.shift();
  }
  if (out[0]) out[0] = out[0].replace(/^[({]+/, '');
  while (out[0] === '') out.shift();
  const last = out.length - 1;
  if (last >= 0) {
    out[last] = out[last]!.replace(/[)}]+$/, '');
    if (out[last] === '') out.pop();
  }
  return out;
}

interface UnwrappedCommand {
  tokens: string[];
  nestedShell: string | null;
  inspectionOnly: boolean;
  unresolvedWrapper: boolean;
}

const MAX_WRAPPER_UNWRAP_DEPTH = 16;
const SHELL_EXECUTABLES = new Set(['bash', 'dash', 'sh', 'zsh']);
const SHELL_POSITIONAL_REFERENCE = /\$(?:[0-9]+|[@*#-]|\{(?:[0-9]+|[@*#-])\})/;

/** Peel only wrappers whose argv shape is fully understood; unknown options fail closed. */
function unwrapCommand(input: string[]): UnwrappedCommand {
  let tokens = stripShellControlTokens(input);
  for (let depth = 0; depth < MAX_WRAPPER_UNWRAP_DEPTH; depth += 1) {
    while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
    if (tokens.length === 0) {
      return { tokens, nestedShell: null, inspectionOnly: false, unresolvedWrapper: false };
    }
    const head = executableName(tokens[0]);
    if (head === 'env') {
      let index = 1;
      let unresolved = false;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (
          token === '-' ||
          token === '-i' ||
          token === '--ignore-environment' ||
          token === '-0' ||
          token === '--null'
        ) {
          index += 1;
          continue;
        }
        if (token === '-u' || token === '--unset' || token === '-C' || token === '--chdir') {
          if (index + 1 >= tokens.length) unresolved = true;
          index += 2;
          continue;
        }
        if (
          /^--(?:unset|chdir)=/.test(token) ||
          /^-(?:u|C).+/.test(token) ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
        ) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) unresolved = true;
        break;
      }
      tokens = tokens.slice(index);
      if (unresolved) {
        return { tokens, nestedShell: null, inspectionOnly: false, unresolvedWrapper: true };
      }
      continue;
    }
    if (head === 'command') {
      let index = 1;
      let inspectionOnly = false;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (/^-[pVv]+$/.test(token)) {
          inspectionOnly ||= /[Vv]/.test(token);
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      if (inspectionOnly) {
        return { tokens: [], nestedShell: null, inspectionOnly: true, unresolvedWrapper: false };
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'exec') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-a') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^-a.+/.test(token) || /^-[cl]+$/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'builtin' || head === 'nohup' || head === 'time') {
      let index = 1;
      if (tokens[index] === '--') index += 1;
      else if (head === 'time' && tokens[index] === '-p') index += 1;
      else if (tokens[index]?.startsWith('-')) {
        return {
          tokens: tokens.slice(index),
          nestedShell: null,
          inspectionOnly: false,
          unresolvedWrapper: true,
        };
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'nice') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-n' || token === '--adjustment') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^(?:--adjustment=.+|-\d+)$/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'arch') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-arch' || token === '--arch' || token === '-d' || token === '-e') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^-(?:arm64e?|x86_64|i386|32|64|c)$/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'caffeinate') {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '--') {
          index += 1;
          break;
        }
        if (token === '-t' || token === '-w') {
          if (index + 1 >= tokens.length) {
            return {
              tokens: [],
              nestedShell: null,
              inspectionOnly: false,
              unresolvedWrapper: true,
            };
          }
          index += 2;
          continue;
        }
        if (/^-[dimsur]+$/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          return {
            tokens: tokens.slice(index),
            nestedShell: null,
            inspectionOnly: false,
            unresolvedWrapper: true,
          };
        }
        break;
      }
      tokens = tokens.slice(index);
      continue;
    }
    if (head === 'eval') {
      return {
        tokens: [],
        nestedShell: tokens.slice(1).join(' '),
        inspectionOnly: false,
        unresolvedWrapper: false,
      };
    }
    if (SHELL_EXECUTABLES.has(head)) {
      let index = 1;
      while (index < tokens.length) {
        const token = tokens[index]!;
        if (token === '-o' || token === '-O') {
          index += 2;
          continue;
        }
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) {
          const nestedShell = tokens[index + 1] ?? '';
          const positionalArgs = tokens.slice(index + 2);
          return {
            tokens: positionalArgs,
            nestedShell,
            inspectionOnly: false,
            unresolvedWrapper:
              index + 1 >= tokens.length ||
              (SHELL_POSITIONAL_REFERENCE.test(nestedShell) &&
                containsSimulatorExecutor(positionalArgs)),
          };
        }
        if (token === '--') break;
        if (!token.startsWith('-')) break;
        index += 1;
      }
    }
    return { tokens, nestedShell: null, inspectionOnly: false, unresolvedWrapper: false };
  }
  return { tokens, nestedShell: null, inspectionOnly: false, unresolvedWrapper: true };
}

function isExternalSimulatorLaunch(tokens: string[]): boolean {
  const head = executableName(tokens[0]);
  if (head === 'open') {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const next = tokens[index + 1];
      if (/^-[^-]*a[^-]*$/i.test(token) && /^Simulator(?:\.app)?$/i.test(next ?? '')) return true;
      if (/^-aSimulator(?:\.app)?$/i.test(token)) return true;
      if (/^-[^-]*b[^-]*$/i.test(token) && /^com\.apple\.iphonesimulator$/i.test(next ?? '')) {
        return true;
      }
      if (/^-bcom\.apple\.iphonesimulator$/i.test(token)) return true;
      if (/\/Simulator\.app(?:\/Contents\/MacOS\/Simulator)?$/i.test(token)) return true;
    }
  }
  return (
    head === 'simulator' && /Simulator\.app\/Contents\/MacOS\/Simulator$/i.test(tokens[0] ?? '')
  );
}

function simctlSubcommand(tokens: string[]): string | null {
  let index = 0;
  if (executableName(tokens[index]) === 'xcrun') {
    index += 1;
    while (index < tokens.length && tokens[index]!.startsWith('-')) {
      const option = tokens[index]!;
      if (
        option === '--sdk' ||
        option === '-sdk' ||
        option === '--toolchain' ||
        option === '-toolchain'
      ) {
        index += 2;
      } else {
        index += 1;
      }
    }
  }
  if (executableName(tokens[index]) !== 'simctl') return null;
  index += 1;
  if (tokens[index] === '--set') index += 2;
  return tokens[index]?.toLowerCase() ?? null;
}

function isSimulatorMutation(tokens: string[]): boolean {
  const subcommand = simctlSubcommand(tokens);
  return subcommand !== null && !SAFE_SIMCTL_COMMANDS.has(subcommand);
}

function containsSimulatorExecutor(tokens: string[]): boolean {
  return tokens.some(
    (token) =>
      /(?:^|\/)simctl$/i.test(token) ||
      /Simulator(?:\.app)?/i.test(token) ||
      /\bxcrun\b[\s\S]*\bsimctl\b/i.test(token),
  );
}

/** Extract command/process substitutions because they execute even inside an otherwise safe command. */
function shellSubcommands(command: string): string[] {
  const subcommands: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'") {
      if (quote === "'") quote = null;
      else if (quote === null) quote = "'";
      continue;
    }
    if (char === '"') {
      if (quote === '"') quote = null;
      else if (quote === null) quote = '"';
      continue;
    }
    if (quote === "'") continue;
    if (char === '`') {
      let end = index + 1;
      for (; end < command.length; end += 1) {
        if (command[end] === '\\') end += 1;
        else if (command[end] === '`') break;
      }
      if (end < command.length) {
        subcommands.push(command.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    if ((char === '$' || char === '<' || char === '>') && command[index + 1] === '(') {
      let depth = 1;
      let innerQuote: "'" | '"' | null = null;
      let end = index + 2;
      for (; end < command.length && depth > 0; end += 1) {
        const inner = command[end]!;
        if (inner === '\\' && innerQuote !== "'") {
          end += 1;
          continue;
        }
        if (inner === "'" || inner === '"') {
          if (innerQuote === inner) innerQuote = null;
          else if (innerQuote === null) innerQuote = inner;
          continue;
        }
        if (innerQuote) continue;
        if (inner === '(') depth += 1;
        else if (inner === ')') depth -= 1;
      }
      if (depth === 0) {
        subcommands.push(command.slice(index + 2, end - 1));
        index = end - 1;
      }
    }
  }
  return subcommands;
}

function isLiteralSimulatorBypass(command: string): boolean {
  for (const segment of shellSegments(command)) {
    const unwrapped = unwrapCommand(tokenizeShellSegment(segment));
    if (unwrapped.inspectionOnly || unwrapped.unresolvedWrapper) continue;
    if (isExternalSimulatorLaunch(unwrapped.tokens) || isSimulatorMutation(unwrapped.tokens)) {
      return true;
    }
  }
  return false;
}

function isSimulatorExecutorValue(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/');
  return /(?:^|\/)(?:xcrun|simctl)$/i.test(normalized) || /Simulator(?:\.app)?/i.test(normalized);
}

function hasUnresolvedExecutableExpansion(segment: string, tokens: string[]): boolean {
  const executableTokens = stripShellControlTokens(tokens);
  while (executableTokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(executableTokens[0])) {
    executableTokens.shift();
  }
  const executable = executableTokens[0] ?? '';
  if (!/[$`*?\[]/.test(executable)) return false;
  return /\b(?:xcrun|simctl|Simulator(?:\.app)?)\b/i.test(segment);
}

function referencesVariable(command: string, variable: string): boolean {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\$(?:${escaped}\\b|\\{${escaped}\\})`).test(command);
}

/** Track simple shell assignments so a later eval/sh -c/$VAR cannot hide a bypass. */
function containsTaintedVariableExecution(command: string): boolean {
  const tainted = new Set<string>();
  const tokenizedSegments = shellSegments(command).map((segment) => ({
    segment,
    tokens: tokenizeShellSegment(segment),
  }));
  for (const { tokens } of tokenizedSegments) {
    for (const token of tokens) {
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(token);
      if (!assignment) break;
      const value = assignment[2] ?? '';
      if (isLiteralSimulatorBypass(value) || isSimulatorExecutorValue(value)) {
        tainted.add(assignment[1]!);
      }
    }
  }
  if (tainted.size === 0) return false;

  for (const { segment, tokens } of tokenizedSegments) {
    const unwrapped = unwrapCommand(tokens);
    for (const variable of tainted) {
      if (unwrapped.nestedShell !== null && referencesVariable(unwrapped.nestedShell, variable)) {
        return true;
      }
      if (referencesVariable(unwrapped.tokens[0] ?? '', variable)) return true;
      if (
        executableName(unwrapped.tokens[0]) === 'xcrun' &&
        unwrapped.tokens.some((token) => referencesVariable(token, variable))
      ) {
        return true;
      }
      // Unknown wrappers are unsafe when they consume a tainted command value.
      if (unwrapped.unresolvedWrapper && referencesVariable(segment, variable)) return true;
    }
  }
  return false;
}

/** A literal command piped or passed to a shell becomes executable shell input. */
function containsShellConsumedLiteralBypass(command: string): boolean {
  const segments = shellSegments(command).map(tokenizeShellSegment);
  const invokesShell = segments.some((tokens) =>
    SHELL_EXECUTABLES.has(executableName(unwrapCommand(tokens).tokens[0])),
  );
  if (!invokesShell) return false;
  return segments.some((tokens) =>
    tokens.some((token) => token.includes(' ') && isLiteralSimulatorBypass(token)),
  );
}

/** Function bodies are executable later, so reject unsafe bodies at definition time. */
function containsSimulatorFunctionBody(command: string, depth: number): boolean {
  const functionPattern =
    /(?:^|[;\n]\s*)(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*\(\s*\))?\s*\{([\s\S]*?)\}/g;
  for (const match of command.matchAll(functionPattern)) {
    if (containsSimulatorBypass(match[1] ?? '', depth + 1)) return true;
  }
  return false;
}

function containsSimulatorBypass(command: string, depth = 0): boolean {
  if (depth > 8) return /\b(?:simctl|Simulator(?:\.app)?)\b/i.test(command);
  if (
    containsTaintedVariableExecution(command) ||
    containsShellConsumedLiteralBypass(command) ||
    containsSimulatorFunctionBody(command, depth)
  ) {
    return true;
  }
  for (const nested of shellSubcommands(command)) {
    if (containsSimulatorBypass(nested, depth + 1)) return true;
  }
  for (const segment of shellSegments(command)) {
    const tokens = tokenizeShellSegment(segment);
    if (hasUnresolvedExecutableExpansion(segment, tokens)) return true;
    const unwrapped = unwrapCommand(tokens);
    if (unwrapped.inspectionOnly) continue;
    if (unwrapped.nestedShell !== null) {
      if (unwrapped.unresolvedWrapper)
        return containsSimulatorExecutor(tokenizeShellSegment(segment));
      if (containsSimulatorBypass(unwrapped.nestedShell, depth + 1)) return true;
      continue;
    }
    if (unwrapped.unresolvedWrapper && containsSimulatorExecutor(unwrapped.tokens)) return true;
    if (isExternalSimulatorLaunch(unwrapped.tokens) || isSimulatorMutation(unwrapped.tokens)) {
      return true;
    }
  }
  return false;
}

/** Undefined means the normal shell permission flow remains unchanged. */
export function getDesktopShellCommandPolicy(
  command: string,
): ShellCommandPolicyDenial | undefined {
  if (process.platform !== 'darwin') return undefined;
  // POSIX shells remove an unquoted backslash-newline before tokenization.
  // Mirror that expansion so the policy cannot be bypassed with continuations.
  const expandedCommand = command.replace(/\\\r?\n/g, '');
  if (containsSimulatorBypass(expandedCommand)) {
    return { decision: 'deny', reason: IOS_SIMULATOR_SHELL_DENIAL };
  }
  return undefined;
}

export const iosSimulatorShellDenialReason = IOS_SIMULATOR_SHELL_DENIAL;
