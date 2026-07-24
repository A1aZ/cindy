import Constants, { ExecutionEnvironment } from 'expo-constants';
import React, { type ComponentType, type ReactNode } from 'react';
import type { ObserveConfig } from 'expo-observe';

type ExpoObserveModule = typeof import('expo-observe');
type ObserveApi = ExpoObserveModule['Observe'];
type ObserveRootApi = ExpoObserveModule['ObserveRoot'];

const isStoreClient =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

let expoObserveModule: ExpoObserveModule | null | undefined;

function loadExpoObserve(): ExpoObserveModule | null {
  if (isStoreClient) return null;
  if (expoObserveModule === undefined) {
    expoObserveModule = require('expo-observe') as ExpoObserveModule;
  }
  return expoObserveModule;
}

const noopObserve = {
  configure(_config: ObserveConfig) {},
  setBundleDefaults() {},
  markInteractive() {},
} as unknown as ObserveApi;

const NoopObserveRoot = (({ children }: { children: ReactNode }) =>
  React.createElement(React.Fragment, null, children)) as ObserveRootApi;

NoopObserveRoot.wrap = function wrap<P extends Record<string, unknown>>(
  Component: ComponentType<P>,
): ComponentType<P> {
  const Wrapped = (props: P) => React.createElement(Component, props);
  Wrapped.displayName = `ObserveRoot(${
    Component.displayName || Component.name || 'Component'
  })`;
  return Wrapped;
};

export const Observe = loadExpoObserve()?.Observe ?? noopObserve;
export const ObserveRoot = loadExpoObserve()?.ObserveRoot ?? NoopObserveRoot;
export const observeDisabledForExpoGo = isStoreClient;

const noopObserveHookValue = {
  markInteractive() {},
};

export function useObserve(): ReturnType<ExpoObserveModule['useObserve']> {
  const observeModule = loadExpoObserve();
  if (observeModule) return observeModule.useObserve();
  return noopObserveHookValue;
}
