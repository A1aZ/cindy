import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
  },
}));

import {
  effectiveVoiceInputServiceMode,
  resolveVoiceInputModelSelectionValues,
  voiceInputModelSelectionSignature,
} from '../VoiceInputModelSelection.js';

describe('VoiceInputModelSelection', () => {
  describe('serviceMode', () => {
    it('forces BYOK when account services are unavailable', () => {
      expect(effectiveVoiceInputServiceMode('cindy', false)).toBe('byok');
      expect(effectiveVoiceInputServiceMode('byok', false)).toBe('byok');
      expect(effectiveVoiceInputServiceMode('cindy', true)).toBe('cindy');
    });

    it('defaults to the managed cindy mode when unset', () => {
      const result = resolveVoiceInputModelSelectionValues({});
      expect(result.values.serviceMode).toBe('cindy');
      expect(result.values.serviceModeConfigured).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it('reads an explicit byok override from the file', () => {
      const result = resolveVoiceInputModelSelectionValues({ serviceMode: 'byok' });
      expect(result.values.serviceMode).toBe('byok');
      expect(result.values.serviceModeConfigured).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it('treats an explicit cindy value as configured', () => {
      const result = resolveVoiceInputModelSelectionValues({ serviceMode: 'cindy' });
      expect(result.values.serviceMode).toBe('cindy');
      expect(result.values.serviceModeConfigured).toBe(true);
    });

    it('falls back to cindy with a warning for unknown values', () => {
      const result = resolveVoiceInputModelSelectionValues({ serviceMode: 'mystery' });
      expect(result.values.serviceMode).toBe('cindy');
      expect(result.values.serviceModeConfigured).toBe(false);
      expect(result.warnings).toEqual([
        { field: 'serviceMode', value: 'mystery', fallback: 'cindy' },
      ]);
    });

    it('reads the env override when the file has no value', () => {
      const result = resolveVoiceInputModelSelectionValues(
        {},
        { XDT_VOICE_INPUT_SERVICE_MODE: 'byok' },
      );
      expect(result.values.serviceMode).toBe('byok');
      expect(result.values.serviceModeConfigured).toBe(true);
    });

    it('changes the selection signature so mode switches bust runtime caches', () => {
      const cindy = resolveVoiceInputModelSelectionValues({}).values;
      const byok = resolveVoiceInputModelSelectionValues({ serviceMode: 'byok' }).values;
      expect(voiceInputModelSelectionSignature(cindy))
        .not.toBe(voiceInputModelSelectionSignature(byok));
    });
  });

  it('uses runtime config values before dev env defaults', () => {
    const result = resolveVoiceInputModelSelectionValues(
      {
        asrProvider: 'litellm-gpt-realtime-whisper',
        refinerProvider: 'litellm-qwen3.6-plus',
        refinerModel: 'qwen/qwen3.6-plus',
      },
      {
        XDT_VOICE_INPUT_ASR_PROVIDER: 'litellm-qwen3-asr-flash-realtime',
        XDT_VOICE_INPUT_REFINER_PROVIDER: 'codex-gpt-5.4-mini',
        XDT_VOICE_INPUT_REFINER_MODEL: 'gpt-5.4-mini',
      },
    );

    expect(result.values).toEqual({
      serviceMode: 'cindy',
      serviceModeConfigured: false,
      asrProvider: 'litellm-gpt-realtime-whisper',
      refinerProvider: 'litellm-qwen3.6-plus',
      refinerModel: 'qwen/qwen3.6-plus',
      asrProviderChain: [
        'litellm-gpt-realtime-whisper',
        'litellm-volcengine-sauc-asr',
        'litellm-qwen3-asr-flash-realtime',
      ],
      // BYOK refiner fallback is explicit opt-in: no configured chain means
      // the selected primary runs alone.
      refinerProviderChain: ['litellm-qwen3.6-plus'],
      refinerProviderChainSource: 'default',
    });
    expect(result.warnings).toEqual([]);
  });

  it('lets app-wide utility model fields drive the refiner order', () => {
    const result = resolveVoiceInputModelSelectionValues({
      utilityModelProvider: 'litellm-kimi-k2.6',
      utilityModel: 'moonshotai/kimi-k2.6',
      utilityModelProviderChain: ['litellm-qwen3.7-max'],
      refinerProvider: 'litellm-qwen3.6-plus',
      refinerModel: 'qwen/qwen3.6-plus',
      refinerProviderChain: ['litellm-glm-5.1'],
    });

    expect(result.values.refinerProvider).toBe('litellm-kimi-k2.6');
    expect(result.values.refinerModel).toBe('moonshotai/kimi-k2.6');
    expect(result.values.refinerProviderChain).toEqual([
      'litellm-kimi-k2.6',
      'litellm-qwen3.7-max',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('falls back to env and app defaults when runtime fields are empty', () => {
    const result = resolveVoiceInputModelSelectionValues(
      {
        asrProvider: '',
        refinerProvider: '',
        refinerModel: '',
      },
      {
        XDT_VOICE_INPUT_ASR_PROVIDER: 'litellm-batch',
      },
    );

    expect(result.values).toEqual({
      serviceMode: 'cindy',
      serviceModeConfigured: false,
      asrProvider: 'litellm-batch',
      refinerProvider: 'codex-gpt-5.4-mini',
      refinerModel: undefined,
      asrProviderChain: [
        'litellm-batch',
        'litellm-volcengine-sauc-asr',
        'litellm-qwen3-asr-flash-realtime',
        'litellm-gpt-realtime-whisper',
      ],
      refinerProviderChain: ['codex-gpt-5.4-mini'],
      refinerProviderChainSource: 'default',
    });
    expect(result.warnings).toEqual([]);
  });

  it('uses default process env overrides when no env object is passed', () => {
    vi.stubEnv('XDT_VOICE_INPUT_ASR_PROVIDER', 'litellm-qwen3-asr-flash-realtime');
    try {
      const result = resolveVoiceInputModelSelectionValues({});

      expect(result.values.asrProvider).toBe('litellm-qwen3-asr-flash-realtime');
      expect(result.warnings).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses Volcengine SAUC ASR as the app default when no override is configured', () => {
    const result = resolveVoiceInputModelSelectionValues({});

    expect(result.values.asrProvider).toBe('litellm-volcengine-sauc-asr');
    expect(result.warnings).toEqual([]);
  });

  it('ignores legacy ASR provider env names instead of silently preserving old overrides', () => {
    const result = resolveVoiceInputModelSelectionValues(
      {},
      {
        XDT_VOICE_INPUT_PROVIDER: 'litellm-batch',
        VOICE_INPUT_PROVIDER: 'litellm-gpt-realtime-whisper',
      },
    );

    expect(result.values.asrProvider).toBe('litellm-volcengine-sauc-asr');
    expect(result.warnings).toEqual([]);
  });

  it('accepts LiteLLM refiner model ids as provider aliases', () => {
    expect(resolveVoiceInputModelSelectionValues({ refinerProvider: 'qwen/qwen3.7-max' }).values.refinerProvider)
      .toBe('litellm-qwen3.7-max');
    expect(resolveVoiceInputModelSelectionValues({ refinerProvider: 'z-ai/glm-5.1' }).values.refinerProvider)
      .toBe('litellm-glm-5.1');
    expect(resolveVoiceInputModelSelectionValues({ refinerProvider: 'moonshotai/kimi-k2.6' }).values.refinerProvider)
      .toBe('litellm-kimi-k2.6');
  });

  it('builds the default ASR chain but keeps the refiner primary alone without explicit fallback', () => {
    const result = resolveVoiceInputModelSelectionValues({});

    expect(result.values.asrProviderChain).toEqual([
      'litellm-volcengine-sauc-asr',
      'litellm-qwen3-asr-flash-realtime',
      'litellm-gpt-realtime-whisper',
    ]);
    // BYOK refiner fallback is explicit opt-in (product decision 2026-07-23):
    // without a configured chain there is no built-in default tail.
    expect(result.values.refinerProviderChain).toEqual(['codex-gpt-5.4-mini']);
  });

  it('uses explicit chain config as the fallback tail, keeping the selected primary as head', () => {
    const result = resolveVoiceInputModelSelectionValues({
      asrProvider: 'litellm-qwen3-asr-flash-realtime',
      asrProviderChain: ['litellm-batch', 'litellm-qwen3-asr-flash-realtime'],
      refinerProviderChain: ['litellm-kimi-k2.6'],
    });

    expect(result.values.asrProviderChain).toEqual([
      'litellm-qwen3-asr-flash-realtime',
      'litellm-batch',
    ]);
    expect(result.values.refinerProviderChain).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-kimi-k2.6',
    ]);
    expect(result.values.refinerProviderChainSource).toBe('configured');
    expect(result.warnings).toEqual([]);
  });

  it('marks a valid explicit refiner chain as configured even when it matches the default values', () => {
    const result = resolveVoiceInputModelSelectionValues({
      refinerProviderChain: [
        'codex-gpt-5.4-mini',
        'litellm-gpt-5.4-mini',
        'litellm-kimi-k2.6',
        'litellm-deepseek-v4-flash',
      ],
    });

    expect(result.values.refinerProviderChain).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      'litellm-kimi-k2.6',
      'litellm-deepseek-v4-flash',
    ]);
    expect(result.values.refinerProviderChainSource).toBe('configured');
  });

  it('reads chain overrides from comma separated env vars', () => {
    const result = resolveVoiceInputModelSelectionValues(
      {},
      {
        XDT_VOICE_INPUT_ASR_PROVIDER_CHAIN: 'litellm-gpt-realtime-whisper, litellm-batch',
        XDT_VOICE_INPUT_REFINER_PROVIDER_CHAIN: 'litellm-glm-5.1,litellm-deepseek-v4-flash',
      },
    );

    expect(result.values.asrProviderChain).toEqual([
      'litellm-volcengine-sauc-asr',
      'litellm-gpt-realtime-whisper',
      'litellm-batch',
    ]);
    expect(result.values.refinerProviderChain).toEqual([
      'codex-gpt-5.4-mini',
      'litellm-glm-5.1',
      'litellm-deepseek-v4-flash',
    ]);
    expect(result.values.refinerProviderChainSource).toBe('configured');
  });

  it('drops unknown chain entries with a warning and falls back to the default chain when all entries are invalid', () => {
    const result = resolveVoiceInputModelSelectionValues({
      asrProviderChain: ['unknown-asr-a', 'unknown-asr-b'],
    });

    expect(result.values.asrProviderChain).toEqual([
      'litellm-volcengine-sauc-asr',
      'litellm-qwen3-asr-flash-realtime',
      'litellm-gpt-realtime-whisper',
    ]);
    expect(result.warnings).toEqual([
      { field: 'asrProviderChain', value: 'unknown-asr-a', fallback: '<dropped>' },
      { field: 'asrProviderChain', value: 'unknown-asr-b', fallback: '<dropped>' },
    ]);
  });

  it('returns warnings and safe defaults for unknown provider names', () => {
    const result = resolveVoiceInputModelSelectionValues({
      asrProvider: 'unknown-asr',
      refinerProvider: 'unknown-refiner',
    });

    expect(result.values.asrProvider).toBe('litellm-volcengine-sauc-asr');
    expect(result.values.refinerProvider).toBe('codex-gpt-5.4-mini');
    expect(result.warnings).toEqual([
      {
        field: 'asrProvider',
        value: 'unknown-asr',
        fallback: 'litellm-volcengine-sauc-asr',
      },
      {
        field: 'refinerProvider',
        value: 'unknown-refiner',
        fallback: 'codex-gpt-5.4-mini',
      },
    ]);
  });
});
