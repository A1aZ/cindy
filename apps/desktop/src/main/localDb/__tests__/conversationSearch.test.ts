import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const conversationSearchSource = readFileSync(
  resolve(__dirname, '..', 'conversationSearch.ts'),
  'utf8',
);

describe('conversationSearch source invariants', () => {
  it('includes visible AskUser cards in content search roles', () => {
    expect(conversationSearchSource).toContain(
      "const SEARCH_ROLES = ['user', 'assistant', 'ask_user', 'plan_review'] as const;",
    );
  });
});
