import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';

/** Sidebar 聚合索引用的轻量 run wire 形态，由 main 侧 SQLite 查询直接返回。 */
export interface ScheduleSidebarIndexRun {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  scheduleStatus: Schedule['status'];
  scheduleSource?: Schedule['source'];
  nextFireAt?: number;
  workingDir?: string;
  projectConfigId?: string;
  sessionId?: string;
  status: ScheduleRun['status'];
  readAt?: number;
}

export async function loadScheduleSidebarIndexRuns(): Promise<ScheduleSidebarIndexRun[]> {
  return (await window.electronAPI.maker.schedule.listSidebarIndexRuns()) as ScheduleSidebarIndexRun[];
}
