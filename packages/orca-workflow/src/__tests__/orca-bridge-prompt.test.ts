import { describe, expect, it } from 'vitest';

import { renderOrcaLeadSystemPrompt, renderOrcaWorkerSystemPrompt } from '../orca-bridge-prompt.js';

describe('renderOrcaLeadSystemPrompt', () => {
  const subagentHint =
    'If the user explicitly asks for a "subagent" / "子代理", use your native subagent mechanism (Codex: spawn_agent; Claude Code: the Agent/Task tool) — do not translate that request into an Orca worker (create_worker / start_team).';

  it('adds the subagent routing hint for leads', () => {
    const prompt = renderOrcaLeadSystemPrompt(null);

    expect(prompt).toContain(subagentHint);
  });

  it('keeps the subagent routing hint when an initial worker exists', () => {
    const prompt = renderOrcaLeadSystemPrompt({ workerId: 'worker-1', sessionId: 'session-1' });

    expect(prompt).toContain(subagentHint);
  });
});

describe('renderOrcaWorkerSystemPrompt', () => {
  const subagentHint =
    'If the user asks for a "subagent" / "子代理", use your native subagent mechanism (Codex: spawn_agent; Claude Code: the Agent/Task tool) to handle it yourself — do NOT escalate to the lead for it, and do NOT call start_team / create_worker (you cannot create Orca workers).';

  const workerMeta = {
    workerId: 'worker-1',
    sessionId: 'session-1',
    workflowId: 'workflow-1',
    leadSessionId: 'lead-1',
  };

  it('adds the subagent routing hint for workers', () => {
    const prompt = renderOrcaWorkerSystemPrompt(workerMeta);

    expect(prompt).toContain(subagentHint);
  });

  it('keeps the subagent routing hint with worker identity metadata', () => {
    const prompt = renderOrcaWorkerSystemPrompt(workerMeta);

    expect(prompt).toContain('worker_id=worker-1');
    expect(prompt).toContain(subagentHint);
  });
});
