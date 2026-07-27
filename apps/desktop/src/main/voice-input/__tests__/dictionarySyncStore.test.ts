/**
 * 词典同步落盘层与词典写入路径的接线。
 *
 * 重点盯三件事:
 *  1. 存量用户升级后词典不丢(首次迁移借回收路径完成,不需要单独的迁移代码);
 *  2. 旧版本客户端直接改过词典文件时,改动能被认领回来;
 *  3. **运行期的物化回写绝不能被反向读成本地增量** —— 那会让合并进来的远端计数
 *     被重复记账,词典频次随同步次数膨胀。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tempDir = '';

vi.mock('electron', () => ({
  app: { getPath: () => tempDir },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: 'owner-1' }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tempDir, 'owners', 'owner-1', ...parts),
}));
vi.mock('../../utils/ipcValidate.js', () => ({
  throwIpcError: (code: string, message: string) => {
    throw new Error(`[${code}] ${message}`);
  },
}));

const { voiceDictionarySyncStore } = await import('../VoiceDictionarySyncStore.js');
const { voiceInputDataStore } = await import('../VoiceInputDataStore.js');
const { createEmptySyncState, createHlcClock, recordLearningEvent } = await import(
  '@cindy/voice-input-core'
);

const DATA_FILE = 'voice-input-data.v1.json';
const SYNC_FILE = 'voice-dictionary-sync.v1.json';

function ownerPath(fileName: string): string {
  return path.join(tempDir, 'owners', 'owner-1', fileName);
}

function writeDictionaryFile(settings: Record<string, unknown>): void {
  const filePath = ownerPath(DATA_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ version: 1, settings, history: [] }),
    'utf-8',
  );
}

function readDictionaryFile(): { dictionaryEntries: Array<{ text: string; source: string; frequency: number }> } {
  return JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
}

/** 每个用例都要拿到全新的 store 内存状态:两个 store 都按 ownerId 缓存。 */
function resetStoreCaches(): void {
  (voiceDictionarySyncStore as unknown as { data: unknown; dataOwnerId: unknown }).data = null;
  (voiceDictionarySyncStore as unknown as { data: unknown; dataOwnerId: unknown }).dataOwnerId = null;
  (voiceInputDataStore as unknown as { state: unknown; stateOwnerId: unknown }).state = null;
  (voiceInputDataStore as unknown as { state: unknown; stateOwnerId: unknown }).stateOwnerId = null;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dict-sync-'));
  resetStoreCaches();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('词典同步落盘 —— 首次迁移', () => {
  it('存量词典在首次加载时被整份认领进同步状态,内容不丢', () => {
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'legacy-1', text: 'Vibe Coding', source: 'manual', frequency: 3, aliases: [] },
        { id: 'legacy-2', text: 'LiteLLM', source: 'automatic', frequency: 5, aliases: [] },
      ],
      dictionaryCandidates: [
        { text: 'Orca', evidenceCount: 2, aliases: [], createdAt: 1, updatedAt: 1 },
      ],
      suppressedAutomaticDictionaryTexts: ['Cindy'],
    });

    const settings = voiceInputDataStore.getSettings();
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'LiteLLM',
      'Vibe Coding',
    ]);
    expect(settings.dictionaryEntries.find((entry) => entry.text === 'Vibe Coding')?.source).toBe('manual');
    expect(settings.dictionaryCandidates.map((item) => item.text)).toEqual(['Orca']);
    expect(settings.suppressedAutomaticDictionaryTexts).toEqual(['Cindy']);
    // 同步状态已建立,sidecar 落盘。
    expect(fs.existsSync(ownerPath(SYNC_FILE))).toBe(true);
  });

  it('空词典的新用户不会凭空产生词条', () => {
    writeDictionaryFile({ dictionaryEntries: [], dictionaryCandidates: [] });
    expect(voiceInputDataStore.getSettings().dictionaryEntries).toEqual([]);
  });
});

describe('词典同步落盘 —— 写入路径', () => {
  it('手动添加、改写、删除都落到同步状态并回投影到词典文件', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.getSettings();

    voiceInputDataStore.addManualDictionaryEntry('litellm');
    expect(readDictionaryFile().dictionaryEntries.map((entry) => entry.text)).toEqual(['litellm']);

    const entryId = voiceInputDataStore.getSettings().dictionaryEntries[0].id;
    voiceInputDataStore.renameDictionaryEntry(entryId, 'LiteLLM');
    expect(readDictionaryFile().dictionaryEntries.map((entry) => entry.text)).toEqual(['LiteLLM']);

    voiceInputDataStore.deleteDictionaryEntries([entryId]);
    expect(readDictionaryFile().dictionaryEntries).toEqual([]);
  });

  it('通用 settings 更新不能整份覆盖词典(会绕过同步状态)', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.addManualDictionaryEntry('Cindy');

    voiceInputDataStore.updateSettings({
      language: 'zh-CN',
      dictionaryEntries: [
        { id: 'x', text: '注入词条', source: 'manual', frequency: 1, aliases: [], createdAt: 1, updatedAt: 1 },
      ],
      suppressedAutomaticDictionaryTexts: ['Cindy'],
    });

    const settings = voiceInputDataStore.getSettings();
    expect(settings.language).toBe('zh-CN');
    expect(settings.dictionaryEntries.map((entry) => entry.text)).toEqual(['Cindy']);
    expect(settings.suppressedAutomaticDictionaryTexts).toEqual([]);
  });

  it('自动学习按 action 记录证据,低置信度与无别名的建议被丢弃', () => {
    writeDictionaryFile({ dictionaryEntries: [], refinementEnabled: true, autoDictionaryEnabled: true });
    voiceInputDataStore.getSettings();

    const result = voiceInputDataStore.recordDictionaryLearningActions([
      { action: 'add_entry', term: 'Vibe Coding', aliases: ['web coding'], type: 'phrase', confidence: 'high' },
      { action: 'add_entry', term: '低置信', aliases: ['低置心'], type: 'other', confidence: 'low' },
      { action: 'add_entry', term: '无证据', aliases: [], type: 'other', confidence: 'high' },
    ]);

    expect(result.settings.dictionaryEntries.map((entry) => entry.text)).toEqual(['Vibe Coding']);
    expect(result.newAutomaticEntries.map((entry) => entry.text)).toEqual(['Vibe Coding']);
  });
});

describe('词典同步落盘 —— 合并与回收', () => {
  it('合并远端状态后物化落盘,且不会把远端计数重复记成本地增量', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.getSettings();

    // 构造一份「远端设备学过 3 次」的状态。
    let remote = createEmptySyncState();
    let clock = createHlcClock('remote-node', 1_000);
    for (let index = 0; index < 3; index += 1) {
      const result = recordLearningEvent(remote, clock, {
        text: 'Vibe Coding',
        aliases: ['web coding'],
        stage: 'entry',
        nowMs: 1_000 + index,
      });
      remote = result.state;
      clock = result.clock;
    }

    expect(voiceInputDataStore.mergeRemoteDictionaryState(remote)).toBe(true);
    expect(readDictionaryFile().dictionaryEntries[0].frequency).toBe(3);

    // 同一份状态再合并任意多次都不该改变频次(幂等)。
    for (let round = 0; round < 5; round += 1) {
      voiceInputDataStore.mergeRemoteDictionaryState(remote);
    }
    expect(readDictionaryFile().dictionaryEntries[0].frequency).toBe(3);

    // 关键:重新加载(触发回收路径)之后,合并进来的 3 次不能被当成本地新增再记一遍。
    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().dictionaryEntries[0].frequency).toBe(3);
    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().dictionaryEntries[0].frequency).toBe(3);
  });

  it('旧版本客户端在词典文件里的增删能被认领回同步状态', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.addManualDictionaryEntry('Cindy');
    voiceInputDataStore.addManualDictionaryEntry('Orca');

    // 模拟降级:旧版本直接重写词典文件(删掉 Orca、加了 device-link)。
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] },
        { id: 'b', text: 'device-link', source: 'manual', frequency: 1, aliases: [] },
      ],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    resetStoreCaches();

    const settings = voiceInputDataStore.getSettings();
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'Cindy',
      'device-link',
    ]);
  });

  it('更新版本的 sidecar 原样保留,词典也不被清空', () => {
    // 降级场景:用户装过更新的客户端,sidecar 里是 v2 状态。旧客户端读不懂,
    // 但绝不能把它当空状态物化出空词典再覆盖写回 —— 那会同时销毁用户的词典和
    // 所有设备的合并历史。
    writeDictionaryFile({
      dictionaryEntries: [
        { id: 'a', text: 'Vibe Coding', source: 'manual', frequency: 3, aliases: [] },
        { id: 'b', text: 'LiteLLM', source: 'automatic', frequency: 2, aliases: [] },
      ],
      dictionaryCandidates: [],
      suppressedAutomaticDictionaryTexts: [],
    });
    const syncPath = ownerPath(SYNC_FILE);
    const futureSidecar = JSON.stringify({
      version: 1,
      nodeId: 'future-node',
      clock: { wallMs: 9_000, counter: 3 },
      state: { version: 2, records: { future: { magic: true } }, suppressed: {} },
      lastMaterializedKeys: ['vibe coding', 'litellm'],
    });
    fs.mkdirSync(path.dirname(syncPath), { recursive: true });
    fs.writeFileSync(syncPath, futureSidecar, 'utf-8');
    resetStoreCaches();

    // 词典照常可用(来自词典文件,不是空的)。
    const settings = voiceInputDataStore.getSettings();
    expect(settings.dictionaryEntries.map((entry) => entry.text).sort()).toEqual([
      'LiteLLM',
      'Vibe Coding',
    ]);
    // sidecar 逐字节未动。
    expect(fs.readFileSync(syncPath, 'utf-8')).toBe(futureSidecar);

    // 即便发生词典写入,也不能把更新版本的 sidecar 覆盖掉。
    voiceInputDataStore.addManualDictionaryEntry('Orca');
    expect(fs.readFileSync(syncPath, 'utf-8')).toBe(futureSidecar);
  });

  it('同步状态文件损坏时回退到词典文件,不让词典功能整体失效', () => {
    writeDictionaryFile({
      dictionaryEntries: [{ id: 'a', text: 'Cindy', source: 'manual', frequency: 1, aliases: [] }],
    });
    const syncPath = ownerPath(SYNC_FILE);
    fs.mkdirSync(path.dirname(syncPath), { recursive: true });
    fs.writeFileSync(syncPath, '{ this is not json', 'utf-8');
    resetStoreCaches();

    expect(voiceInputDataStore.getSettings().dictionaryEntries.map((entry) => entry.text)).toEqual([
      'Cindy',
    ]);
  });
});

describe('词典同步开关 —— 只持久化用户 override', () => {
  it('未自定义时配置里不留该字段,用户随版本跟随默认值', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    // 任何一次无关设置保存都不该把当前默认值固化进用户配置。
    voiceInputDataStore.updateSettings({ language: 'zh-CN' });

    const raw = JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
    expect(raw.dictionarySyncEnabledOverride).toBeUndefined();
    // 有效值仍然是默认值。
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(true);
  });

  it('用户显式关闭后记录 override,并在重载后保持', () => {
    writeDictionaryFile({ dictionaryEntries: [] });
    voiceInputDataStore.updateSettings({ dictionarySyncEnabled: false });

    const raw = JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
    expect(raw.dictionarySyncEnabledOverride).toBe(false);

    resetStoreCaches();
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(false);
  });

  it('存量配置里的有效值:与默认不同才认作用户选择', () => {
    // 本 PR 早期版本把有效值直接写进了配置。false 只可能来自用户主动关闭。
    writeDictionaryFile({ dictionaryEntries: [], dictionarySyncEnabled: false });
    expect(voiceInputDataStore.getSettings().dictionarySyncEnabled).toBe(false);

    // 而 true 与当时默认相同,无法区分「用户选的」和「默认」,按规则不猜意图。
    resetStoreCaches();
    writeDictionaryFile({ dictionaryEntries: [], dictionarySyncEnabled: true });
    voiceInputDataStore.updateSettings({ language: 'en' });
    const raw = JSON.parse(fs.readFileSync(ownerPath(DATA_FILE), 'utf-8')).settings;
    expect(raw.dictionarySyncEnabledOverride).toBeUndefined();
  });
});
