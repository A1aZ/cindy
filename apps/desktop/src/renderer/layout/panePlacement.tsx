import { createContext, useContext } from 'react';

/**
 * 布局树给 pane 的容器适配信号。
 *
 * 根级横排沿用既有像素宽度通道；进入插件 grid 的纵向列后，面板必须填满父格，
 * 不能继续拿 manifest 的固定宽度，否则会在列内留下空白或溢出。
 */
const PaneFillContext = createContext(false);

export const PaneFillProvider = PaneFillContext.Provider;

export function usePaneFill(): boolean {
  return useContext(PaneFillContext);
}
