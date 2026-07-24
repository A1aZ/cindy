import { ipcMain } from 'electron';

import {
  addOrUpdateWorker,
  createOrGetTeamForLead,
  getTeamByLeadSession,
  getTeamByWorkerSession,
  listWorkersByLead,
  updateWorkerStatus,
  type OrcaWorkerStatus,
  type OrcaTeamStatus,
} from '../orcaTeamStore.js';
import {
  requireObject,
  requireString,
  optionalString,
  optionalNullableString,
  requireEnum,
  optionalEnum,
} from '../../utils/ipcValidate.js';

const TEAM_STATUSES = ['active', 'completed', 'cancelled', 'failed'] as const;
const WORKER_STATUSES = ['idle', 'running', 'done', 'error'] as const;

export function registerOrcaWorkflowIpc(): void {
  ipcMain.handle('local-db:orca-workflows:create', async (_e, input: unknown) => {
    const body = requireObject(input);
    const leadSessionId = requireString(body.leadSessionId, 'leadSessionId');
    return createOrGetTeamForLead({
      id: optionalString(body.id),
      leadSessionId,
      status: optionalEnum<OrcaTeamStatus>(body.status, TEAM_STATUSES, 'team status'),
    });
  });

  ipcMain.handle(
    'local-db:orca-workflows:get-by-lead',
    async (_e, leadSessionId: unknown) => {
      return getTeamByLeadSession(requireString(leadSessionId, 'leadSessionId'));
    },
  );

  ipcMain.handle(
    'local-db:orca-workflows:get-by-worker-session',
    async (_e, workerSessionId: unknown) => {
      return getTeamByWorkerSession(requireString(workerSessionId, 'workerSessionId'));
    },
  );

  ipcMain.handle(
    'local-db:orca-workflows:list-workers-by-lead',
    async (_e, leadSessionId: unknown) => {
      return listWorkersByLead(requireString(leadSessionId, 'leadSessionId'));
    },
  );

  ipcMain.handle('local-db:orca-workflows:add-worker', async (_e, input: unknown) => {
    const body = requireObject(input);
    return addOrUpdateWorker({
      id: requireString(body.id, 'id'),
      teamId: optionalString(body.teamId),
      leadSessionId: optionalString(body.leadSessionId),
      sessionId: requireString(body.sessionId, 'sessionId'),
      status: optionalEnum<OrcaWorkerStatus>(body.status, WORKER_STATUSES, 'worker status'),
      label: optionalNullableString(body.label),
      worktreeBranch: optionalNullableString(body.worktreeBranch),
    });
  });

  ipcMain.handle(
    'local-db:orca-workflows:update-worker-status',
    async (_e, workerId: unknown, status: unknown) => {
      return updateWorkerStatus(
        requireString(workerId, 'workerId'),
        requireEnum<OrcaWorkerStatus>(status, WORKER_STATUSES, 'worker status'),
      );
    },
  );
}
