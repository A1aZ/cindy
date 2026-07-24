import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  CircleStop,
  LoaderCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { WorkflowAgentProgress, WorkflowProgress } from '../../../shared/workflow-progress';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { formatModelShortLabel } from '@/lib/modelShortLabel';

interface WorkflowAgentTreeProps {
  sessionId?: string;
  /** workflow 任务的 task_id(= 记录文件顶层 taskId,用于关联)。 */
  taskId?: string;
  /** workflow 是否仍在运行(决定是否轮询记录文件)。 */
  isRunning: boolean;
}

/** 运行中轮询记录文件的间隔(记录文件可能随 agent 状态变化被增量重写)。 */
const POLL_INTERVAL_MS = 2500;

/**
 * 读取并订阅某个 workflow 的逐 agent 进度。
 *
 * - 挂载时拉一次;`isRunning` 为真时按 POLL_INTERVAL_MS 轮询(记录文件实时写则近实时,
 *   只在结束写则完成后一次到位)。`isRunning` 翻假 → effect 重跑 → 停轮询 + 拉最终一次。
 * - IPC 读不到 / 解析失败返回 null;这里原样透传,让卡片回退到 workflow 级展示。
 */
function useWorkflowProgress(
  sessionId: string | undefined,
  taskId: string | undefined,
  isRunning: boolean,
): WorkflowProgress | null {
  const [progress, setProgress] = useState<WorkflowProgress | null>(null);

  useEffect(() => {
    if (!sessionId || !taskId) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fetchOnce = async () => {
      try {
        const next = await window.electronAPI.maker.getWorkflowProgress(sessionId, taskId);
        // null = 本次没读到(记录还没写 / 瞬时读失败)。已有进度时不覆盖为 null,避免
        // 轮询过程中树闪没;首帧本就是 null,保持 null 无副作用。换 task 由 key 重挂载复位,
        // 不依赖这里清空。
        if (!cancelled && next !== null) setProgress(next);
      } catch {
        // best-effort:读取抛错同样保持上一次结果,不抛出
      }
    };

    void fetchOnce();
    if (isRunning) {
      const tick = () => {
        timer = setTimeout(async () => {
          await fetchOnce();
          if (!cancelled) tick();
        }, POLL_INTERVAL_MS);
      };
      tick();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, taskId, isRunning]);

  return progress;
}

function agentStateIcon(state: string) {
  switch (state) {
    case 'done':
    case 'completed':
      return CheckCircle2;
    case 'failed':
    case 'error':
      return AlertCircle;
    case 'stopped':
    case 'killed':
      return CircleStop;
    case 'queued':
    case 'pending':
      return CircleDashed;
    default:
      return LoaderCircle; // running / 未知 → 转圈
  }
}

function isSpinning(state: string): boolean {
  return state === 'running' || (state !== 'done' && state !== 'completed' && state !== 'failed'
    && state !== 'error' && state !== 'stopped' && state !== 'killed' && state !== 'queued'
    && state !== 'pending');
}

/**
 * WorkflowAgentTree —— workflow 卡片展开区里的逐 agent 进度树。
 *
 * 数据来自 main 的 workflow-progress reader(读 Claude Code 内部记录文件)。这是对
 * workflow 级卡片的**增强**:拿到数据就按 phase 分组、逐 agent 列出(状态图标 + label +
 * 模型 chip);拿不到(SDK 未写记录 / 格式变化 / 非 workflow)则渲染 null,卡片其余部分照常。
 */
export function WorkflowAgentTree({ sessionId, taskId, isRunning }: WorkflowAgentTreeProps) {
  const { t } = useTranslation();
  const progress = useWorkflowProgress(sessionId, taskId, isRunning);

  // 按 phase 顺序分组 agents;phaseTitle 不在 phases 列表里的(或缺失)归到末尾一组。
  const grouped = useMemo(() => {
    if (!progress) return [];
    const byPhase = new Map<string, WorkflowAgentProgress[]>();
    const orderedTitles = progress.phases.map((p) => p.title);
    for (const title of orderedTitles) byPhase.set(title, []);
    const orphans: WorkflowAgentProgress[] = [];
    for (const agent of progress.agents) {
      const key = agent.phaseTitle;
      if (key && byPhase.has(key)) byPhase.get(key)!.push(agent);
      else orphans.push(agent);
    }
    const out: Array<{ title: string | null; agents: WorkflowAgentProgress[] }> = [];
    for (const title of orderedTitles) {
      const agents = byPhase.get(title) ?? [];
      if (agents.length > 0) out.push({ title, agents });
    }
    if (orphans.length > 0) out.push({ title: null, agents: orphans });
    return out;
  }, [progress]);

  if (!progress || progress.agents.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      <div className="text-12 leading-4 text-[var(--text-tertiary)]">
        {t('chat.workflowTree.agentsCount', { count: progress.agentCount ?? progress.agents.length })}
      </div>
      {grouped.map((group, gi) => (
        <div key={group.title ?? `orphan-${gi}`} className="space-y-1">
          {group.title && (
            <div className="text-11 font-medium uppercase tracking-wide text-[var(--text-tertiary)]">
              {group.title}
            </div>
          )}
          {group.agents.map((agent) => {
            const Icon = agentStateIcon(agent.state);
            const spinning = isSpinning(agent.state);
            const modelLabel = formatModelShortLabel(agent.model);
            const stateLabel = t(`chat.workflowTree.state.${agent.state}`, {
              defaultValue: agent.state,
            });
            return (
              <div key={agent.agentId} className="flex min-w-0 items-center gap-2">
                <Spinner
                  icon={Icon}
                  size={13}
                  spinning={spinning}
                  aria-label={stateLabel}
                  className={cn(
                    'text-[var(--text-secondary)]',
                    (agent.state === 'failed' || agent.state === 'error') && 'text-[var(--error-fg)]',
                  )}
                />
                <span className="truncate text-13 leading-5 text-[var(--text-primary)]">
                  {agent.label}
                </span>
                {modelLabel && (
                  <span className="shrink-0 rounded-[4px] bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 leading-4 text-[var(--text-tertiary)]">
                    {modelLabel}
                  </span>
                )}
                {typeof agent.attempt === 'number' && agent.attempt > 1 && (
                  <span className="shrink-0 text-11 leading-4 text-[var(--text-tertiary)]">
                    {t('chat.workflowTree.attempt', { count: agent.attempt })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
