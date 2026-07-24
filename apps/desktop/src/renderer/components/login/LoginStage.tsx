import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

import { desktopScale } from './loginScale';
import { LOGIN_GROUP, STAGE } from './loginDesignTokens';

/**
 * LoginStage — 桌面登录 1819×2098 设计画布的「面板宿主」层(demo v3.1 缩放)。
 *
 * PR2b 所有权拆分(implementation-plan Step 3b WHAT2):品牌视觉层(白底体系背景
 * 渐变/立绘/字标/Slogan)已整体迁入 `LoginBrandStage`(App 级 overlay,唯一渲染者);
 * 本组件只承载 LoginPage 唯一拥有的白色输入面板与第三方圆钮行(children),
 * 与品牌层共用同一 desktopScale 公式,保证 1819×2098 坐标系逐像素对齐。
 *
 * - stage 居中纯等比缩放(desktopScale,宽度不参与);
 * - children 渲染在登录整体组位置(x=570,y=1229/1227,680×560);
 * - 本层自身 z-auto:LoginPage 根建立 z-[9990] stacking context 整体压过品牌
 *   overlay(LoginBrandStage z-[9980]),内部与窗框描边(z-30)/拖拽条(z-40)
 *   沿 PR2a 相对层序。
 */

export function useViewportSize(): { width: number; height: number } {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

export function LoginStage({
  children,
  ssoOrgGroupY = false,
  groupStyle,
}: {
  children: ReactNode;
  /** sso-org 族状态登录组 y=1227,其余 1229(figma §5.1 / demo loginY)。 */
  ssoOrgGroupY?: boolean;
  /** handoff 面板入场样式(opacity/transform/transition,LoginPage 消费 context 注入)。 */
  groupStyle?: CSSProperties;
}) {
  const { width, height } = useViewportSize();
  const { scale } = desktopScale(width, height);
  const groupY = ssoOrgGroupY ? LOGIN_GROUP.ySsoOrg : LOGIN_GROUP.yDefault;

  return (
    <div
      className="fixed inset-0 overflow-hidden"
      data-testid="login-panel-stage-root"
    >
      {/* 1819×2098 设计画布:居中纯等比缩放(与 LoginBrandStage 同公式对齐) */}
      <div
        data-testid="login-stage"
        className="absolute left-1/2 top-1/2"
        style={{
          width: STAGE.width,
          height: STAGE.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: '50% 50%',
        }}
      >
        {/* 登录整体组(680×560):面板 + 第三方圆钮行由 children 提供 */}
        <div
          data-testid="login-group"
          className="absolute"
          style={{
            left: LOGIN_GROUP.x,
            top: groupY,
            width: LOGIN_GROUP.width,
            height: LOGIN_GROUP.height,
            ...groupStyle,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
