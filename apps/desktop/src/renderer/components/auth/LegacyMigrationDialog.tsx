import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import chibiFailureUrl from '@/assets/login/chibi/chibi-failure@2x.png?url';
import { Spinner } from '@/components/ui/spinner';

type LegacyMigrationPhase = 'confirm' | 'running' | 'done' | 'failed' | null;

/**
 * LegacyMigrationDialog — 首登轻量数据迁移(mToc)的全局确认 / 进度弹窗。
 *
 * main 在首次登录成功、db 打开前检测到老版本 userData 时,经
 * `legacy-migration:state` 推送阶段;本组件挂在 App 顶层(与 Toast 同层),
 * 按阶段渲染(状态机与交互与皮肤化前完全一致,PR3 仅换视觉):
 *  - confirm:标题 + 说明 + 唯一的「确定」按钮(不可关闭 / 不可取消);
 *  - running:说明切「正在迁移…」,按钮进 loading(compositor-only Spinner,
 *    禁用;ESC / 外点本就无监听,天然拦截);
 *  - failed:回调卡形式 + 失败表情包(design.md §7.4 条 2 唯一 App 内例外;
 *    demo legacyOverlay:680×680 卡 scale(0.72) 落进 490×490 盒),点「继续」
 *    关闭(main 侧同步清态);
 *  - done:直接关闭,登录流程继续。
 *
 * 视觉参数权威:confirm/running = demo `.legacy-modal`(520px r12 面板);
 * failed = callback-pages-classification.md 卡片共用参数(680×680 r36,立绘
 * 280×280@200,60,标题 32/352,副文案 20/396,CTA 540×80@70,529)。颜色全部走
 * `--login-callback-*` component token(colors.ts,规则 16),几何为设计稿
 * 冻结值走内联常量。仅 cn 构建触发(main 侧既有逻辑,本组件不感知区域)。
 *
 * 挂载时经 get-state 补拉一次,兜住「main 先推送、组件后挂载」的时序。
 */
export function LegacyMigrationDialog() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<LegacyMigrationPhase>(null);

  useEffect(() => {
    let mounted = true;
    window.electronAPI.legacyMigration
      .getState()
      .then((state) => {
        if (mounted && state?.phase) setPhase(state.phase);
      })
      .catch(() => {});
    const unsubscribe = window.electronAPI.legacyMigration.onState((payload) => {
      if (payload && typeof payload.phase === 'string') setPhase(payload.phase);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const open = phase === 'confirm' || phase === 'running' || phase === 'failed';
  const failed = phase === 'failed';
  const running = phase === 'running';
  // 唯一可聚焦元素;Tab/Shift+Tab 一律圈回按钮(最小 focus trap,对齐旧版
  // Radix AlertDialog 的焦点圈——迁移期间禁止键盘走出弹窗触达底层 UI)。
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  if (!open) return null;

  const trapFocus = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      buttonRef.current?.focus();
    }
  };

  const onConfirm = () => {
    if (phase === 'confirm') {
      // 乐观切 loading;main 收到确认后会紧接着推 running(幂等)。
      setPhase('running');
      void window.electronAPI.legacyMigration.confirm();
    } else if (failed) {
      setPhase(null);
      // 同一通道让 main 清掉 failed 态,避免重挂载后 get-state 再弹。
      void window.electronAPI.legacyMigration.confirm();
    }
  };

  return (
    // 状态完全由 main 推送 + 按钮点击驱动;confirm/running/failed 期间不允许
    // ESC / 外点关闭(overlay 无任何关闭监听,与皮肤化前行为一致)。
    <div
      role="dialog"
      aria-modal="true"
      // z-[10000] = 本仓模态层约定(confirm-dialog 同层);低于 Toast(10100)。
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ background: 'var(--overlay-modal)' }}
      onKeyDown={trapFocus}
    >
      {failed ? (
        <div style={{ position: 'relative', width: 490, height: 490 }}>
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 680,
              height: 680,
              transform: 'scale(0.72)',
              transformOrigin: 'top left',
              borderRadius: 36,
              border: '1px solid var(--login-callback-card-border)',
              background: 'var(--login-callback-card-bg)',
              overflow: 'clip',
            }}
          >
            <img
              src={chibiFailureUrl}
              alt=""
              style={{
                position: 'absolute',
                left: 200,
                top: 60,
                width: 280,
                height: 280,
                objectFit: 'contain',
              }}
            />
            <h2
              style={{
                position: 'absolute',
                left: 42,
                top: 352,
                width: 598,
                margin: 0,
                fontSize: 32,
                lineHeight: '38px',
                fontWeight: 700,
                color: 'var(--login-callback-title)',
                textAlign: 'center',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {t('legacyMigration.failedTitle')}
            </h2>
            {/* demo:failed 副文案多行展开(white-space normal / height auto / lh 1.5) */}
            <p
              style={{
                position: 'absolute',
                left: 41,
                top: 396,
                width: 599,
                margin: 0,
                fontSize: 20,
                lineHeight: 1.5,
                color: 'var(--login-callback-body)',
                textAlign: 'center',
              }}
            >
              {t('legacyMigration.failedDescription')}
            </p>
            <button
              ref={buttonRef}
              type="button"
              autoFocus
              onClick={onConfirm}
              style={{
                position: 'absolute',
                left: 70,
                top: 529,
                width: 540,
                height: 80,
                borderRadius: 40,
                background: 'var(--login-callback-cta-bg)',
                border: '1px solid var(--login-callback-cta-border)',
                color: 'var(--login-callback-cta-text)',
                fontSize: 24,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {t('legacyMigration.continue')}
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            width: 520,
            maxWidth: 'calc(100% - 48px)',
            borderRadius: 12,
            background: 'var(--login-callback-card-bg)',
            border: '1px solid var(--login-callback-card-border)',
            boxShadow: 'var(--confirm-shadow)',
            padding: 28,
          }}
        >
          <h2
            style={{
              margin: '0 0 12px',
              fontSize: 22,
              lineHeight: 1.25,
              fontWeight: 600,
              color: 'var(--login-callback-title)',
            }}
          >
            {t('legacyMigration.title')}
          </h2>
          <p
            style={{
              margin: '0 0 22px',
              fontSize: 14,
              lineHeight: 1.6,
              color: 'var(--login-callback-body)',
            }}
          >
            {running ? t('legacyMigration.migrating') : t('legacyMigration.description')}
          </p>
          <button
            ref={buttonRef}
            type="button"
            autoFocus
            disabled={running}
            onClick={onConfirm}
            className="flex w-full items-center justify-center gap-2"
            style={{
              height: 48,
              borderRadius: 24,
              background: 'var(--login-callback-cta-bg)',
              border: '1px solid var(--login-callback-cta-border)',
              color: 'var(--login-callback-cta-text)',
              fontSize: 16,
              fontWeight: 600,
              cursor: running ? 'default' : 'pointer',
            }}
          >
            {running ? (
              <>
                <Spinner size={16} />
                {t('legacyMigration.migrating')}
              </>
            ) : (
              t('legacyMigration.confirm')
            )}
          </button>
        </div>
      )}
    </div>
  );
}
