import { and, eq } from 'drizzle-orm';
import { botProfiles, botProfileVersions, botSessionLinks, sessions } from '../localDb/schema.js';
import { getDbClient } from '../localDb/client/current.js';
import { updateBotProfile } from '../localDb/ipc/bots.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { listCustomMcpServers } from '../maker-host/custom-mcp-store.js';

type Kind = 'skill' | 'mcp' | 'toolset';
type Input = { callerSessionId: string; kind: Kind };
type Entry = { id: string; name: string; description: string; available: boolean; joined: boolean };
const fields: Record<Kind, { list: string; mode: string }> = {
  skill: { list: 'skills', mode: 'skillMode' },
  mcp: { list: 'mcpServers', mode: 'mcpMode' },
  toolset: { list: 'toolsets', mode: 'toolsetMode' },
};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Only the live owner may select capabilities; no caller-supplied Bot or connection config. */
async function context(callerSessionId: string) {
  const owner = activeOwnerScopeKey();
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
      throw new Error('账号正在切换，请重试');
  };
  assertOwner();
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      botId: botProfiles.id,
      version: botProfiles.currentVersion,
      profileStatus: botProfiles.status,
      canonicalSessionId: botProfiles.canonicalSessionId,
      role: botSessionLinks.role,
      archivedAt: botSessionLinks.archivedAt,
      sessionStatus: sessions.status,
      source: sessions.source,
      agentKind: sessions.agentKind,
      workingDir: sessions.workingDir,
      remoteHostId: sessions.remoteHostId,
      config: botProfileVersions.capabilitiesJson,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .innerJoin(
      botProfileVersions,
      and(
        eq(botProfileVersions.botId, botProfiles.id),
        eq(botProfileVersions.version, botProfiles.currentVersion),
      ),
    )
    .where(eq(botSessionLinks.sessionId, callerSessionId))
    .limit(1);
  assertOwner();
  if (
    !row ||
    row.source !== 'bot' ||
    row.role !== 'canonical' ||
    row.canonicalSessionId !== callerSessionId ||
    row.archivedAt !== null ||
    row.sessionStatus !== 'active' ||
    row.profileStatus !== 'active'
  ) {
    throw new Error('只有当前伙伴主任务可以管理自己的能力');
  }
  const parsed: unknown = JSON.parse(row.config);
  const config =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { ...row, config, assertOwner };
}

async function catalog(input: Input, ctx: Awaited<ReturnType<typeof context>>): Promise<Entry[]> {
  const joined = new Set(strings(ctx.config[fields[input.kind].list]));
  const { getMaker, getPluginRegistry, isBotToolsetAvailable } = await import('../maker-host/index.js');
  const agentKind =
    getMaker().getSession(input.callerSessionId)?.agentKind ??
    (ctx.agentKind === 'cc' ? 'claude-code' : ctx.agentKind === 'pi' ? 'pi' : 'codex');
  const workingDir = ctx.workingDir ?? '';
  let items: Omit<Entry, 'joined'>[];
  if (input.kind === 'skill') {
    const result = await getMaker().listAgentSkills(agentKind, {
      workingDir,
      remoteHostId: ctx.remoteHostId ?? undefined,
    });
    items = result.skills.map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description ?? '',
      available: skill.enabled !== false && skill.runtimeStatus !== 'failed',
    }));
  } else if (input.kind === 'mcp') {
    // Project only display metadata. URLs, headers and tokens never enter tool results.
    items = (await listCustomMcpServers()).map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      description: mcp.transport,
      available: agentKind !== 'codex' || mcp.transport !== 'sse',
    }));
  } else {
    const registry = getPluginRegistry();
    items = await Promise.all(
      registry
        .getPlugins()
        .filter((plugin) => plugin.id !== 'collab')
        .map(async (plugin) => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description,
          available:
            (await registry.getEnableState(plugin.id, workingDir)).effectiveEnabled &&
            isBotToolsetAvailable({
              botId: ctx.botId,
              workingDir,
              agentKind,
              remoteHostId: ctx.remoteHostId,
              toolsetId: plugin.id,
            }),
        })),
    );
  }
  ctx.assertOwner();
  const result = items.map((item) => ({ ...item, joined: joined.has(item.id) }));
  // Uninstalled references remain removable, instead of silently disappearing.
  for (const id of joined)
    if (!result.some((item) => item.id === id))
      result.push({ id, name: id, description: '', available: false, joined: true });
  return result;
}

export async function findBotCapabilities(input: Input & { query?: string }) {
  try {
    const ctx = await context(input.callerSessionId);
    const query = input.query?.trim().toLocaleLowerCase() ?? '';
    const capabilities = (await catalog(input, ctx)).filter(
      (item) =>
        !query || `${item.id} ${item.name} ${item.description}`.toLocaleLowerCase().includes(query),
    );
    return { ok: true as const, capabilities: capabilities.slice(0, 50) };
  } catch {
    return {
      ok: false as const,
      errorCode: 'CAPABILITY_DISCOVERY_FAILED',
      message: '无法读取当前伙伴的能力目录，请稍后重试',
    };
  }
}

export async function selectBotCapability(input: Input & { id: string; joined: boolean }) {
  try {
    const ctx = await context(input.callerSessionId);
    const field = fields[input.kind];
    const previous = strings(ctx.config[field.list]);
    if (input.joined) {
      const item = (await catalog(input, ctx)).find((entry) => entry.id === input.id);
      if (!item?.available)
        return {
          ok: false as const,
          errorCode: 'CAPABILITY_UNAVAILABLE',
          message: '该能力未安装、已停用或当前运行引擎不可用',
        };
    }
    ctx.assertOwner();
    const selected = input.joined
      ? [...new Set([...previous, input.id])]
      : previous.filter((id) => id !== input.id);
    await updateBotProfile(
      { id: ctx.botId, capabilities: { [field.list]: selected, [field.mode]: 'allowlist' } },
      ctx.version,
    );
    ctx.assertOwner();
    return { ok: true as const, joined: input.joined, effective: 'next-turn' as const };
  } catch {
    return {
      ok: false as const,
      errorCode: 'CAPABILITY_SELECTION_FAILED',
      message: '伙伴状态或配置已变化，请重新查询后重试',
    };
  }
}
