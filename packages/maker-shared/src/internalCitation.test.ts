import { describe, expect, it } from 'vitest';

import {
  stableInternalWebCitationBoundary,
  stripInternalWebCitations,
  stripLeakedModelStopTokens,
} from './internalCitation.js';

const source1 = '\uE200cite\uE202turn17search1\uE201';
const source2 = '\uE200cite\uE202turn17search1\uE202turn17search2\uE201';

describe('internal Web citation normalization', () => {
  it('strips single and multiple-source markers without changing punctuation', () => {
    expect(stripInternalWebCitations(`结论。${source1}`)).toBe('结论。');
    expect(stripInternalWebCitations(`A ${source1}；B ${source2}。`)).toBe('A ；B 。');
  });

  it('leaves ordinary cite text and unrelated private-use text untouched', () => {
    expect(stripInternalWebCitations('Please cite the source.')).toBe('Please cite the source.');
    expect(stripInternalWebCitations('ordinary \uE200 text')).toBe('ordinary \uE200 text');
  });

  it('is idempotent and strips unfinished final tails', () => {
    expect(stripInternalWebCitations(`done ${source1}`)).toBe('done ');
    expect(stripInternalWebCitations(stripInternalWebCitations(`done ${source1}`))).toBe('done ');
    expect(stripInternalWebCitations('done \uE200cite\uE202turn17sea')).toBe('done ');
    expect(stripInternalWebCitations('done \uE200ci')).toBe('done ');
  });

  it('holds split streaming prefixes and incomplete markers until they are complete', () => {
    expect(stableInternalWebCitationBoundary('done')).toBe(4);
    expect(stableInternalWebCitationBoundary('done \uE200ci')).toBe(5);
    expect(stableInternalWebCitationBoundary('done \uE200cite\uE202turn17sea')).toBe(5);
    expect(stableInternalWebCitationBoundary(`done ${source2}`)).toBe(`done ${source2}`.length);
  });
});

describe('leaked model stop tokens', () => {
  it('strips a whole-message Grok stop token to empty text', () => {
    expect(stripLeakedModelStopTokens('<|eos|>')).toBe('');
    expect(stripInternalWebCitations('<|eos|>')).toBe('');
  });

  it('strips a trailing stop token after real prose', () => {
    expect(stripInternalWebCitations('\u73B0\u6709 reviewer \u7A7A\u95F2\u3002<|eos|>')).toBe('\u73B0\u6709 reviewer \u7A7A\u95F2\u3002');
  });

  it('leaves ordinary angle-bracket text and code fences untouched', () => {
    expect(stripInternalWebCitations('use <|placeholder|> here')).toBe('use <|placeholder|> here');
    expect(stripInternalWebCitations('See <eos> in the docs')).toBe('See <eos> in the docs');
  });

  it('is idempotent', () => {
    expect(stripInternalWebCitations(stripInternalWebCitations('<|eos|>'))).toBe('');
    expect(stripInternalWebCitations(stripInternalWebCitations('done<|eot_id|>'))).toBe('done');
  });
});
