import { useCallback, useEffect, useRef, type ComponentRef } from 'react';
import { AppState, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildMediaPlayerWebViewCommand,
  buildMediaPlayerWebViewHtml,
  parseMediaPlayerWebViewMessage,
  type MobileMediaPlayerKind,
  type MobileMediaPlayerStatus,
} from '@/session/mediaPlayerWebViewHtml';
import { registerMobileMessageWebView } from '@/session/mobileMessageWebViewMetrics';
import { useTheme } from '@/theme';

export function RemoteMediaPlayerWebView({
  kind,
  mimeType,
  onStatusChange,
  style,
  testID,
  title,
  url,
}: {
  kind: MobileMediaPlayerKind;
  mimeType?: string;
  onStatusChange?: (status: MobileMediaPlayerStatus) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title?: string;
  url: string;
}) {
  const { colors } = useTheme();
  const webViewRef = useRef<ComponentRef<typeof WebView>>(null);
  const mountedRef = useRef(true);
  useEffect(() => registerMobileMessageWebView('media'), []);
  const pausePlayback = useCallback(() => {
    webViewRef.current?.postMessage(buildMediaPlayerWebViewCommand('pause'));
  }, []);
  const stopPlaybackAndLoading = useCallback(() => {
    pausePlayback();
    webViewRef.current?.stopLoading();
  }, [pausePlayback]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') stopPlaybackAndLoading();
    });
    return () => {
      subscription.remove();
      stopPlaybackAndLoading();
    };
  }, [stopPlaybackAndLoading]);

  useEffect(() => {
    return stopPlaybackAndLoading;
  }, [kind, stopPlaybackAndLoading, url]);

  useEffect(() => () => {
    mountedRef.current = false;
    stopPlaybackAndLoading();
  }, [stopPlaybackAndLoading]);

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    if (!mountedRef.current) return;
    const status = parseMediaPlayerWebViewMessage(event.nativeEvent.data);
    if (status) onStatusChange?.(status);
  }, [onStatusChange]);

  return (
    <View style={style} testID={testID}>
      <WebView
        ref={webViewRef}
        allowsInlineMediaPlayback
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        onMessage={handleMessage}
        originWhitelist={['*']}
        scrollEnabled={false}
        source={{
          html: buildMediaPlayerWebViewHtml({
            kind,
            mimeType,
            title,
            url,
            surface: colors.surface,
            chip: colors.surfaceChip,
          }),
          baseUrl: 'https://xdt-maker-mobile.local',
        }}
        style={{ backgroundColor: 'transparent', flex: 1 }}
      />
    </View>
  );
}
