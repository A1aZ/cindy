import {
  ActivityIndicator,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from '@/components/AppText';
import { MainWindowActionGroup } from '@/components/MobilePrimitives';
import type { RewindPreviewState } from '@/session/rewindPreview';
import { buildRewindPreviewLayout } from '@/session/rewindPreviewLayout';
import { fontWeight, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { radius, spacing, typeScale } from '@/theme/tokens';

interface RewindPreviewPanelProps {
  state: RewindPreviewState;
  committing?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function RewindPreviewPanel({
  state,
  committing,
  onCancel,
  onConfirm,
}: RewindPreviewPanelProps) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  if (state.kind === 'idle') return null;

  const canConfirm = state.kind === 'default' || state.kind === 'empty';
  const title = titleForState(state);
  const detail = detailForState(state);
  const fileCount = state.kind === 'default' ? state.filesChanged.length : 0;
  const layout = buildRewindPreviewLayout({
    fileCount,
    screenWidth,
  });

  return (
    <View
      style={[
        styles.container,
        {
          marginHorizontal: layout.containerMarginHorizontal,
          padding: layout.containerPadding,
        },
      ]}
      testID="rewind.panel"
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{title}</Text>
          {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        </View>
        {state.kind === 'loading' ? <ActivityIndicator color={colors.textSecondary} /> : null}
      </View>

      {state.kind === 'default' ? (
        <View style={styles.fileList}>
          {state.filesChanged.slice(0, layout.visibleFileCount).map((file) => (
            <Text
              key={file}
              numberOfLines={1}
              selectable
              style={[styles.filePath, { minHeight: layout.fileRowMinHeight }]}
            >
              {file}
            </Text>
          ))}
          {state.filesChanged.length > layout.visibleFileCount ? (
            <Text style={styles.moreFiles}>另有 {state.filesChanged.length - layout.visibleFileCount} 个文件</Text>
          ) : null}
          <Text style={styles.stats}>
            {state.filesChanged.length} 个文件 · +{state.insertions} / -{state.deletions} 行
          </Text>
        </View>
      ) : null}

      {state.kind === 'empty' && state.note ? (
        <Text selectable style={styles.note}>{state.note}</Text>
      ) : null}

      {state.kind === 'error' ? (
        <Text selectable style={styles.errorText}>{state.errorText}</Text>
      ) : null}

      {state.kind !== 'loading' ? (
        <MainWindowActionGroup
          cancelAction={{
            accessibilityLabel: state.kind === 'error' ? '知道了' : '取消回退',
            label: state.kind === 'error' ? '知道了' : '取消',
            onPress: onCancel,
            testID: state.kind === 'error' ? 'rewind.dismissButton' : 'rewind.cancelButton',
          }}
          primaryActions={canConfirm ? [{
            accessibilityLabel: '确认回退',
            disabled: committing,
            label: committing ? '回退中' : '确认回退',
            onPress: onConfirm,
            testID: 'rewind.confirmButton',
            tone: 'primary',
          }] : []}
          testID="rewind.actions"
        />
      ) : null}
    </View>
  );
}

function titleForState(state: RewindPreviewState): string {
  if (state.kind === 'loading') return '正在检查回退影响';
  if (state.kind === 'default') return '确认回退到这条消息?';
  if (state.kind === 'empty') return '只回退对话历史';
  return '无法回退';
}

function detailForState(state: RewindPreviewState): string | null {
  if (state.kind === 'loading') return '手机端正在向电脑端读取文件回退预览。';
  if (state.kind === 'default') return '会回滚下面这些文件，并截断这条消息之后的对话历史。';
  if (state.kind === 'empty') return '没有文件需要回滚，确认后只会截断这条消息之后的对话历史。';
  return '电脑端拒绝了这次回退操作。';
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.md,
  },
  header: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  detail: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, marginTop: 4 },
  fileList: { gap: spacing.xs },
  filePath: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.container,
    color: colors.textPrimary,
    fontSize: typeScale.caption,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  moreFiles: { color: colors.textTertiary, fontSize: typeScale.caption },
  stats: { color: colors.textSecondary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  note: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  errorText: { color: colors.errorText, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
});
