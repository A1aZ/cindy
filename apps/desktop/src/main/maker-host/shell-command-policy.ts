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
  'Use cindy_ios_simulator for device lifecycle, app install/launch, interaction, screenshots, and diagnostics. ' +
  'If the user explicitly requests the external Simulator.app window, use cindy_computer.launch_app with use_external_simulator=true instead of shell open.';

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

function normalizedExecutableSegment(segment: string): string {
  return segment
    .replace(/^\s*(?:(?:if|then|do|else)\s+)+/i, '')
    .replace(/^\s*(?:(?:command|builtin|nohup)\s+)+/i, '')
    .trim();
}

function isExternalSimulatorLaunch(segment: string): boolean {
  const executable = normalizedExecutableSegment(segment);
  const unquoted = executable.replace(/["']/g, '');

  const openMatch = unquoted.match(/^(?:\/usr\/bin\/)?open\b([\s\S]*)$/i);
  if (openMatch) {
    const args = openMatch[1] ?? '';
    if (/(?:^|\s)-a\s+Simulator(?:\.app)?(?:\s|$)/i.test(args)) return true;
    if (/(?:^|\s)-b\s+com\.apple\.iphonesimulator(?:\s|$)/i.test(args)) return true;
    if (/(?:^|\s)\/[^\s]*Simulator\.app(?:\/Contents\/MacOS\/Simulator)?(?:\s|$)/i.test(args)) {
      return true;
    }
  }

  return /^(?:\/Applications\/Xcode[^/]*\.app\/Contents\/Developer\/Applications\/)?Simulator\.app\/Contents\/MacOS\/Simulator(?:\s|$)/i.test(
    unquoted,
  );
}

function isSimulatorMutation(segment: string): boolean {
  const executable = normalizedExecutableSegment(segment).replace(/["']/g, '');
  const match = executable.match(
    /^(?:(?:\/usr\/bin\/)?xcrun\s+)?(?:[^\s/]+\/)*simctl\s+(?:--set\s+\S+\s+)?([a-z_][a-z0-9_-]*)\b/i,
  );
  if (!match) return false;
  return !SAFE_SIMCTL_COMMANDS.has(match[1].toLowerCase());
}

/** Undefined means the normal shell permission flow remains unchanged. */
export function getDesktopShellCommandPolicy(command: string): ShellCommandPolicyDenial | undefined {
  if (process.platform !== 'darwin') return undefined;
  for (const segment of shellSegments(command)) {
    if (isExternalSimulatorLaunch(segment) || isSimulatorMutation(segment)) {
      return { decision: 'deny', reason: IOS_SIMULATOR_SHELL_DENIAL };
    }
  }
  return undefined;
}

export const iosSimulatorShellDenialReason = IOS_SIMULATOR_SHELL_DENIAL;
