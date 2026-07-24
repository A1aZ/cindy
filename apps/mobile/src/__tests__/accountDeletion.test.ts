import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

describe('mobile account deletion', () => {
  it('lets auth-server eligibility exclusively control settings visibility', () => {
    const settings = source('app/settings.tsx');
    const visibilityBlock = settings.slice(
      settings.indexOf('void auth\n      .getAccountDeletionAvailability()'),
      settings.indexOf('const copyRow'),
    );

    expect(settings).toContain('testID="settings.deleteAccountButton"');
    expect(settings).toContain('{accountDeletionAvailable ? (');
    expect(settings).toContain('style={styles.accountDeletionLinkText}');
    expect(settings).not.toContain("testID: 'settings.deleteAccountButton',\n                      tone: 'danger'");
    expect(visibilityBlock).toContain('availability.available');
    expect(visibilityBlock).not.toContain('membershipKind');
  });

  it('scopes receipts to the current login and clears local credentials without logout', () => {
    const context = source('src/auth/AuthContext.tsx');
    const acceptStart = context.indexOf('const acceptOutcome = useCallback');
    const requestStart = context.indexOf(
      'const requestAccountDeletionChallenge = useCallback',
    );
    const confirmStart = context.indexOf(
      'const confirmAccountDeletion = useCallback',
    );
    const requestBody = context.slice(requestStart, confirmStart);
    const confirmBody = context.slice(
      confirmStart,
      context.indexOf('const getAccountDeletionStatus', confirmStart),
    );
    const acceptBody = context.slice(
      acceptStart,
      context.indexOf('const dispatchLoginAction', acceptStart),
    );

    expect(context).toContain(
      "'cindy.mobile.auth.accountDeletionReceipt'",
    );
    expect(acceptBody).toContain(
      "if (outcome.status === 'ok' || outcome.status === 'select_account')",
    );
    expect(
      acceptBody.indexOf('await persistAccountDeletionReceipt(null);'),
    ).toBeLessThan(
      acceptBody.indexOf("if (outcome.status === 'select_account')"),
    );
    expect(acceptBody).toContain('pendingAccountDeletionRestoredRef.current =');
    expect(acceptBody).toContain(
      "outcome.accountDeletionRestored === true ||\n        pendingAccountDeletionRestoredRef.current",
    );
    expect(acceptBody.indexOf('setToken(outcome.accessToken)')).toBeLessThan(
      acceptBody.indexOf('setAccountDeletionRestored(deletionWasRestored)'),
    );
    expect(requestBody.indexOf('persistAccountDeletionReceipt')).toBeLessThan(
      requestBody.indexOf('return challenge'),
    );
    expect(confirmBody).toContain('await clearLocalSession();');
    expect(confirmBody).not.toContain(
      'persistAccountDeletionReceipt(input.receiptToken)',
    );
    expect(confirmBody).not.toContain('.logout(');
    expect(confirmBody).toContain("'REQUEST_TIMEOUT'");
    expect(confirmBody).toContain(
      '.getAccountDeletionStatus(input.receiptToken)',
    );

    const logoutStart = context.indexOf('const logout = useCallback');
    const logoutBody = context.slice(
      logoutStart,
      context.indexOf('const getAccessToken', logoutStart),
    );
    expect(logoutBody.indexOf('persistAccountDeletionReceipt(null)')).toBeLessThan(
      logoutBody.indexOf('clearLocalSession()'),
    );
  });

  it('requires a six-digit code and explicit acknowledgement', () => {
    const deletion = source('app/account-deletion.tsx');
    const confirmStart = deletion.indexOf('const confirm = useCallback');
    const confirmBody = deletion.slice(
      confirmStart,
      deletion.indexOf('const available', confirmStart),
    );

    expect(deletion).toContain('testID="accountDeletion.codeInput"');
    expect(deletion).toContain('testID="accountDeletion.acknowledgement"');
    expect(deletion).toContain(
      'disabled: busy || code.length !== 6 || !acknowledged',
    );
    expect(deletion).toContain("testID: 'accountDeletion.confirmButton'");
    expect(deletion).toContain("loginText('accountDeletionAcknowledgeCopy')");
    expect(deletion).not.toMatch(/[\u4e00-\u9fff]/);
    expect(confirmBody).not.toContain("router.replace('/login')");
  });

  it('localizes the deletion entry, screen, and restored notice across all four locales', () => {
    const settings = source('app/settings.tsx');
    const layout = source('app/_layout.tsx');
    const loginMessages = source('src/auth/loginMessages.ts');

    expect(settings).toContain("loginText('accountDeletionSettingsAction')");
    expect(layout).toContain("loginText('accountDeletionRestoredTitle')");
    expect(layout).toContain("loginText('accountDeletionRestoredCopy')");
    expect(
      loginMessages.match(/accountDeletionAcknowledgeCopy:/g),
    ).toHaveLength(4);
    expect(loginMessages).toContain('其他客户端会在登录状态失效后退出');
    expect(loginMessages).toContain(
      'other clients will sign out when their sign-in session becomes invalid',
    );
    expect(loginMessages).not.toContain('通常不超过 1 分钟');
    expect(loginMessages).not.toContain('normally within one minute');
  });

  it('handles terminal REST auth failures without logout loops', () => {
    const context = source('src/auth/AuthContext.tsx');

    expect(context).toContain('terminalLogoutInFlightRef');
    expect(context).toContain("error.code === 'ACCOUNT_UNAVAILABLE'");
    expect(context).toContain("code === 'INVALID_TOKEN'");
    expect(context).toContain("code === 'UNAUTHORIZED'");
    expect(context).toContain('const runProtectedAuthRequest = useCallback');
    expect(context).toContain(
      "await terminateSessionImplRef.current('ACCOUNT_UNAVAILABLE')",
    );
  });

  it('shows persisted status and forwards Apple authorization codes when available', () => {
    const login = source('app/(auth)/login.tsx');
    const loginMessages = source('src/auth/loginMessages.ts');
    const nativeSocial = source('src/auth/nativeSocial.ts');
    const panel = login.slice(
      login.indexOf('function AccountDeletionStatusPanel'),
      login.indexOf('function socialLabel'),
    );

    expect(login).toContain('testID="login.accountDeletionStatus"');
    expect(panel).toContain("loginText('accountDeletionPendingTitle')");
    expect(panel).toContain("loginText('accountDeletionPendingCopy')");
    expect(panel).toContain('getAuthLocale()');
    expect(panel).not.toMatch(/[\u4e00-\u9fff]/);
    expect(loginMessages.match(/accountDeletionPendingTitle:/g)).toHaveLength(
      4,
    );
    expect(loginMessages).toContain('现在重新登录即可取消注销');
    expect(loginMessages).toContain('Sign in now to cancel deletion.');
    expect(login).toContain("cause.code === 'INVALID_RESPONSE'");
    expect(login).toContain('if (status.status === \'completed\') stopPolling()');
    expect(nativeSocial).toContain('if (!credential.identityToken)');
    expect(nativeSocial).not.toContain('!credential.authorizationCode');
    expect(nativeSocial).toContain(
      '...(credential.authorizationCode',
    );
  });
});
