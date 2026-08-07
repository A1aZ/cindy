import { describe, expect, it } from 'vitest';
import { getDesktopShellCommandPolicy } from '../shell-command-policy.js';

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

describeMac('embedded iOS Simulator shell policy', () => {
  it.each([
    'open -a Simulator',
    'open -n -a "Simulator.app"',
    'open -na Simulator',
    'open -b com.apple.iphonesimulator',
    'open /Applications/Xcode.app/Contents/Developer/Applications/Simulator.app',
    '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator',
  ])('denies an external Simulator launch: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it('denies a multiline legacy simulator workflow before it can execute', () => {
    const command = [
      'SIM_UUID=1A9D41E0-E031-4AD0-A8B5-847480802E8E',
      'xcrun simctl boot "$SIM_UUID"',
      'open -a Simulator',
      'xcrun simctl install "$SIM_UUID" /tmp/FiloApp.app',
    ].join('\n');
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('cindy_ios_simulator'),
    });
  });

  it.each([
    'xcrun simctl boot DEVICE',
    'xcrun simctl bootstatus DEVICE -b',
    'xcrun simctl install DEVICE /tmp/App.app',
    'xcrun simctl launch DEVICE com.example.app',
    'xcrun simctl shutdown DEVICE',
    '/usr/bin/xcrun simctl io DEVICE screenshot /tmp/frame.png',
  ])('denies direct Simulator mutation: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it.each([
    'exec /usr/bin/xcrun simctl shutdown DEVICE',
    'command -p xcrun simctl boot DEVICE',
    'builtin exec xcrun simctl install DEVICE /tmp/App.app',
    'nohup -- xcrun simctl launch DEVICE com.example.app',
    'env FOO=1 /usr/bin/xcrun simctl shutdown DEVICE',
    'FOO=1 exec env BAR=2 xcrun simctl boot DEVICE',
    "bash -lc 'xcrun simctl shutdown DEVICE'",
    "eval 'xcrun simctl erase DEVICE'",
    'echo "$(xcrun simctl shutdown DEVICE)"',
    'echo >(xcrun simctl shutdown DEVICE)',
    "env -S 'xcrun simctl shutdown DEVICE'",
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; eval "$CMD"',
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; sh -c "$CMD"',
    'CMD=xcrun\\ simctl\\ shutdown\\ DEVICE; $CMD',
    'printf "xcrun simctl shutdown DEVICE\\n" | sh',
    'time xcrun simctl shutdown DEVICE',
    'time -p xcrun simctl boot DEVICE',
    'f(){ xcrun simctl shutdown DEVICE;}; f',
    '/usr/bin/xcrun \\\n simctl shutdown DEVICE',
    '/usr/bin/nice /usr/bin/xcrun simctl erase DEVICE',
    '/usr/bin/arch -arm64 /usr/bin/xcrun simctl boot DEVICE',
    '/usr/bin/caffeinate -i /usr/bin/xcrun simctl shutdown DEVICE',
    `/bin/sh -c '"$0" "$@"' /usr/bin/xcrun simctl shutdown DEVICE`,
    `/bin/sh -c '/usr/bin/open -a "$1"' ignored Simulator`,
    '$(/usr/bin/xcrun --find simctl) shutdown DEVICE',
    '/usr/bin/xc[r]un simctl shutdown DEVICE',
    'TOOL=simctl; /usr/bin/xcrun "$TOOL" shutdown DEVICE',
  ])('denies Simulator mutation hidden behind shell execution: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toMatchObject({ decision: 'deny' });
  });

  it.each([
    'xcrun simctl list devices',
    'xcrun simctl listapps DEVICE',
    'exec xcrun simctl list devices',
    'command -p xcrun simctl listapps DEVICE',
    "bash -lc 'xcrun simctl list devices'",
    'f(){ xcrun simctl list devices;}; f',
    'command -v xcrun',
    'xcodebuild -scheme FiloApp -sdk iphonesimulator build',
    'open -a Xcode',
    'echo "open -a Simulator"',
    'osascript -e \'tell application "Simulator" to quit\'',
  ])('allows a non-bypass command: %s', (command) => {
    expect(getDesktopShellCommandPolicy(command)).toBeUndefined();
  });
});
