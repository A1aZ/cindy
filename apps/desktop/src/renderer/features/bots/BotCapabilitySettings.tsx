import { useState } from 'react';
import { useBotTranslation } from './botPronounContext';
import type { BotCapabilities, BotProfile } from './botStore';
import * as sessionService from '@/lib/sessionService';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';

type Kind = 'skill' | 'mcp' | 'toolset';
type Entry = { id: string; name: string; available: boolean };
const kinds: Kind[] = ['skill', 'mcp', 'toolset'];

/** References are edited per companion; shared installations and connections stay host-owned. */
export function BotCapabilitySettings({
  bot,
  capabilities,
  skills,
  onChange,
}: {
  bot: BotProfile;
  capabilities: BotCapabilities;
  skills: string[];
  onChange: (kind: Kind, values: string[]) => void;
}) {
  const { t } = useBotTranslation();
  const [entries, setEntries] = useState<Partial<Record<Kind, Entry[]>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const selected = { skill: skills, mcp: capabilities.mcpServers, toolset: capabilities.toolsets };
  const load = async () => {
    if (busy) return;
    const owner = getDataOwnerGeneration();
    setBusy(true);
    setError(false);
    try {
      if (!bot.canonicalSessionId) throw new Error('Missing canonical task');
      const session = await sessionService.get(bot.canonicalSessionId);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      const agentKind = capabilities.harness === 'claude' ? 'claude-code' : capabilities.harness;
      const api = window.electronAPI.maker;
      const results = await Promise.allSettled([
        api.listAgentSkills(agentKind, {
          workingDir: session.workingDir ?? undefined,
          remoteHostId: session.remoteHostId ?? undefined,
        }),
        api.listCustomMcpServers({ agentKind }),
        api.plugins.list(session.workingDir ?? undefined, true, {
          botId: bot.id, agentKind, remoteHostId: session.remoteHostId,
        }),
      ]);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      const [skillResult, mcpResult, toolsetResult] = results;
      const next: Partial<Record<Kind, Entry[]>> = {};
      if (skillResult.status === 'fulfilled' && skillResult.value.success)
        next.skill = (skillResult.value.skills ?? []).map((item) => ({
          id: item.name,
          name: item.name,
          available: item.enabled !== false && item.runtimeStatus !== 'failed',
        }));
      if (mcpResult.status === 'fulfilled')
        next.mcp = mcpResult.value.servers.map((item) => ({
          id: item.id,
          name: item.name,
          available: item.available === true,
        }));
      if (toolsetResult.status === 'fulfilled')
        next.toolset = toolsetResult.value
          .filter((item) => !['memory', 'xdt_helper', 'collab'].includes(item.id))
          .map((item) => ({
            id: item.id,
            name: item.name,
            available: item.available === true,
          }));
      setEntries(next);
      setError(kinds.some((kind) => !next[kind]));
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) setError(true);
    } finally {
      if (isDataOwnerGenerationCurrent(owner)) setBusy(false);
    }
  };
  return (
    <details
      className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="cursor-pointer px-4 py-3 text-12 font-medium text-[var(--text-secondary)]">
        {t('bots.capabilities.title')}
      </summary>
      <div className="space-y-4 border-t border-[var(--border-default)] p-4">
        <input
          aria-label={t('bots.capabilities.search')}
          placeholder={t('bots.capabilities.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)]"
        />
        {busy ? (
          <p className="text-12 text-[var(--text-secondary)]">{t('bots.capabilities.loading')}</p>
        ) : null}
        {error ? (
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-full px-4 py-2 text-12 text-[var(--text-danger)]"
          >
            {t('bots.retry')}
          </button>
        ) : null}
        {kinds.map((kind) => {
          const rows = [...(entries[kind] ?? [])];
          for (const id of selected[kind])
            if (!rows.some((item) => item.id === id)) rows.push({ id, name: id, available: false });
          const matching = rows.filter((item) =>
            `${item.id} ${item.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          );
          return (
            <fieldset key={kind} className="min-w-0">
              <legend className="mb-2 text-12 font-medium text-[var(--text-primary)]">
                {t(`bots.capabilities.${kind}`)}
              </legend>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {matching.map((item) => (
                  <label
                    key={item.id}
                    className="flex min-h-9 items-center gap-3 rounded-lg px-2 text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--text-primary)]"
                      checked={selected[kind].includes(item.id)}
                      disabled={!item.available && !selected[kind].includes(item.id)}
                      onChange={(event) =>
                        onChange(
                          kind,
                          event.target.checked
                            ? [...selected[kind], item.id]
                            : selected[kind].filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate" title={item.name}>
                      {item.name}
                    </span>
                    {!item.available ? (
                      <span className="text-11 text-[var(--text-tertiary)]">
                        {t('bots.capabilities.unavailable')}
                      </span>
                    ) : null}
                  </label>
                ))}
                {!busy && !error && matching.length === 0 ? (
                  <p className="text-12 text-[var(--text-tertiary)]">
                    {t('bots.capabilities.empty')}
                  </p>
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>
    </details>
  );
}
