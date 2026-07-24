// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
  PopoverContent: ({
    children,
    className,
    onWheel,
  }: {
    children: React.ReactNode;
    className?: string;
    onWheel?: React.WheelEventHandler<HTMLDivElement>;
  }) => (
    <div data-testid="model-popover" className={className} onWheel={onWheel}>
      {children}
    </div>
  ),
}));

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelectorContent: ({ overlayContentClassName }: { overlayContentClassName?: string }) => (
    <div data-testid="model-selector-content" data-overlay-class={overlayContentClassName} />
  ),
  ModelIconMark: () => null,
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  getCachedCapabilities: () => null,
  useAgentCapabilities: () => ({
    capabilities: {
      availableModels: [
        {
          id: 'claude-opus-4-8',
          displayName: 'Opus 4.8',
          efforts: ['high'],
          defaultEffort: 'high',
        },
      ],
    },
  }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [] }),
}));

import { ModelEffortChip } from '@/features/scheduler/components/ScheduleChips';

describe('scheduler model popover overlay behavior', () => {
  it('keeps wheel events inside the model popover and raises nested model options above it', () => {
    const onOuterWheel = vi.fn();

    render(
      <div onWheel={onOuterWheel}>
        <ModelEffortChip
          agentKind="claude-code"
          modelValue="claude-opus-4-8"
          onChangeModel={vi.fn()}
          effortValue="high"
          onChangeEffort={vi.fn()}
          providerId=""
          onChangeProviderId={vi.fn()}
        />
      </div>,
    );

    fireEvent.wheel(screen.getByTestId('model-selector-content'), { deltaY: 120 });

    expect(onOuterWheel).not.toHaveBeenCalled();
    expect(screen.getByTestId('model-selector-content').getAttribute('data-overlay-class')).toBe(
      'z-[10020]',
    );
  });
});
