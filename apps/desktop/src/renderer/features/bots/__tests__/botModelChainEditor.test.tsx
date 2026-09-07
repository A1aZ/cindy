// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { modelSelectorProps } = vi.hoisted(() => ({
  modelSelectorProps: vi.fn(),
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    onEffortChange: (effort: string) => void;
    onFastModeChange: (enabled: boolean) => void;
    onUnifiedSelect: (selection: {
      providerId: string;
      modelId: string;
      effort?: string;
      engine: 'cc' | 'codex' | 'pi';
      fast: boolean;
      favoriteUid: string | null;
    }) => void;
  }) => {
    modelSelectorProps(props);
    return (
      <>
        <button onClick={() => props.onEffortChange("high")}>set-high-effort</button>
        <button onClick={() => props.onFastModeChange(true)}>enable-fast-mode</button>
        <button
          type="button"
          onClick={() =>
            props.onUnifiedSelect({
              providerId: 'openai',
              modelId: 'gpt-5.6-sol',
              effort: 'medium',
              engine: 'codex',
              fast: true,
              favoriteUid: null,
            })
          }
        >
          choose-official-codex-model
        </button>
        <button
          type="button"
          onClick={() =>
            props.onUnifiedSelect({
              providerId: 'anthropic',
              modelId: 'claude-opus-5',
              engine: 'cc',
              fast: false,
              favoriteUid: null,
            })
          }
        >
          choose-official-claude-model
        </button>
      </>
    );
  },
}));

vi.mock('../botStore', () => ({
  getEffectiveBotModelSettings: () => ({
    model: 'default-model',
    providerId: null,
    effort: '',
    fastMode: false,
  }),
}));

vi.mock('../botPronounContext', () => ({
  useBotTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

import { BotModelChainEditor } from '../BotModelChainEditor';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BotModelChainEditor', () => {
  it('uses the standard configurable picker for the current harness', () => {
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'z-ai/glm-5.3-flash',
            providerId: 'xd',
            effort: 'high',
            fastMode: false,
          },
        ]}
        onChange={vi.fn()}
        hiddenVendors={['codex']}
      />,
    );

    expect(modelSelectorProps).toHaveBeenCalledTimes(1);
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedLayout).toBeUndefined();
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedLayoutControls).toBeUndefined();
    expect(modelSelectorProps.mock.calls[0]?.[0]).toMatchObject({
      configurationEnabled: true,
      vendorKey: 'pi',
      unifiedPanel: true,
      unifiedAgents: ['pi', 'claude-code'],
      triggerVariant: 'toolbar',
    });
  });

  it('writes depth and fast mode to the selected route without changing its model', () => {
    const route = { harness: 'codex' as const, model: 'gpt-5.6-sol',
      providerId: 'openai', effort: 'medium', fastMode: false };
    const fallback = { ...route, model: 'fallback-model' };
    const onChange = vi.fn();
    render(<BotModelChainEditor value={[route, fallback]} onChange={onChange} />);
    fireEvent.click(screen.getByText('set-high-effort'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...route, effort: 'high' }, fallback]);
    fireEvent.click(screen.getByText('enable-fast-mode'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...route, fastMode: true }, fallback]);
    expect(modelSelectorProps.mock.calls[0]?.[0].unifiedSelectionPolicy).toBeUndefined();
  });

  it('atomically stores the official harness, provider, model, effort, and fast mode', () => {
    const onChange = vi.fn();
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'model-with-effort',
            providerId: 'xd',
            effort: 'high',
            fastMode: false,
          },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('choose-official-codex-model'));

    expect(onChange).toHaveBeenCalledWith([
      {
        harness: 'codex',
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'medium',
        fastMode: true,
      },
    ]);
  });

  it('maps the Claude Code recommendation and clears an unavailable effort', () => {
    const onChange = vi.fn();
    render(
      <BotModelChainEditor
        value={[
          {
            harness: 'pi',
            model: 'model-with-effort',
            providerId: 'xd',
            effort: 'high',
            fastMode: true,
          },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByText('choose-official-claude-model'));

    expect(onChange).toHaveBeenCalledWith([
      {
        harness: 'claude',
        model: 'claude-opus-5',
        providerId: 'anthropic',
        effort: '',
        fastMode: false,
      },
    ]);
  });
});
