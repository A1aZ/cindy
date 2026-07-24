/**
 * Workflow 进度树的跨进程类型契约(main reader ↔ IPC ↔ renderer 卡片共用)。
 *
 * 数据来源是 Claude Code 的 workflow 运行记录 `wf_*.json`(见
 * `apps/desktop/src/main/workflow-progress/reader.ts`)。该文件是 SDK 内部产物、无公开
 * 契约,故 reader 全程防御式解析;这里的类型只承诺 reader 成功解析后的稳定形状。
 */

/** 单个子 agent 的进度(workflowProgress[type=workflow_agent])。 */
export interface WorkflowAgentProgress {
  /** 脚本里 agent() 的 label(如 "search:ai-tech");缺失时回退 agentId。 */
  label: string;
  agentId: string;
  /** 该 agent 实际跑的模型 raw id(如 claude-opus-4-8[1m])。 */
  model?: string;
  /** 运行时原始状态:queued / running / done / failed / stopped 等(原样透传)。 */
  state: string;
  /** 所属 phase 标题。 */
  phaseTitle?: string;
  /** 重试次数(≥1)。 */
  attempt?: number;
}

/** workflow 的一个阶段。 */
export interface WorkflowPhaseProgress {
  index: number;
  title: string;
}

/** 一次 workflow 运行的聚合进度树。 */
export interface WorkflowProgress {
  runId: string;
  workflowName?: string;
  /** 运行时原始状态:running / completed / failed 等(原样透传)。 */
  status: string;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  durationMs?: number;
  phases: WorkflowPhaseProgress[];
  agents: WorkflowAgentProgress[];
}
