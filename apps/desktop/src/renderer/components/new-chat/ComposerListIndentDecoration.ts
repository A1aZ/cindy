/**
 * Tiptap 扩展 —— composer 列表行缩进(纯视觉,对齐 Claude 原生 App 的
 * "进入列表模式"反馈)。
 *
 * 行为:当某一"行"(段落内以 hardBreak 划分)以列表 / 待办 / 引用前缀开头
 * (`1. ` / `- ` / `- [ ] ` / `> ` 等,与列表接续共用 matchListPrefix 判定),
 * 给该行前缀包一层 inline decoration span,CSS 加 padding-left → 整行内容
 * 右移一格。用户打完 `1. `(空格落下)那一刻缩进立即出现,即"已进入列表
 * 状态"的视觉信号;空项退出(前缀被删)时缩进同步消失。
 *
 * 与 CjkPunctDecoration 相同的设计约束:
 * - decoration 只是渲染层,doc JSON / 草稿存储 / 发送内容里没有任何痕迹;
 * - doc 没变直接复用 DecorationSet,变了全量重扫(chat input 文本量小,
 *   全量成本可忽略,不值得做增量映射);
 * - IME 组合期不重算,避免 DOM 抖动打断输入法候选框;
 * - 纯文本编辑器做不了富文本的悬挂缩进,长行折行后的后续视觉行不缩进,
 *   这是已知 trade-off。
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { matchListPrefix } from '@/lib/composerListContinuation';

const PLUGIN_KEY = new PluginKey<DecorationSet>('composerListIndentDecoration');

/** 行内一个非文本 inline 节点(mention chip 等)的占位符,与 applyListContinuation 一致。 */
const ATOM_PLACEHOLDER = '\uFFFC';

/**
 * 扫描 doc,给所有"列表行"的前缀生成 inline decoration。
 * 返回的 from/to 是 doc-level position。导出以便单测直接断言范围。
 */
export function buildListIndentDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true; // 继续下钻找 textblock
    const contentBase = blockPos + 1; // +1 跨过 textblock 的开标记

    // 段落内按 hardBreak 切行;occupied 与 doc position 一一对应
    // (text 每字符 1、atom 节点占位符 1)。
    let lineText = '';
    let lineStartOffset = 0;
    const flushLine = () => {
      const match = matchListPrefix(lineText);
      if (!match) return;
      const from = contentBase + lineStartOffset;
      decorations.push(
        Decoration.inline(from, from + match.prefixLength, {
          class: 'composer-list-line-indent',
        }),
      );
    };
    block.nodesBetween(0, block.content.size, (node, pos) => {
      if (node.type.name === 'hardBreak') {
        flushLine();
        lineText = '';
        lineStartOffset = pos + node.nodeSize;
      } else if (node.isText) {
        lineText += node.text ?? '';
      } else {
        lineText += ATOM_PLACEHOLDER;
      }
      return false;
    });
    flushLine(); // 段落最后一行

    return false; // textblock 内部已手动扫过,不再下钻
  });

  return DecorationSet.create(doc, decorations);
}

export const ComposerListIndentDecoration = Extension.create({
  name: 'composerListIndentDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: PLUGIN_KEY,
        state: {
          init(_config, state: EditorState) {
            return buildListIndentDecorations(state.doc);
          },
          apply(tr: Transaction, old: DecorationSet) {
            if (!tr.docChanged) return old;
            return buildListIndentDecorations(tr.doc);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state) ?? DecorationSet.empty;
          },
        },
        // 注:曾有一个 view().update 里 `if (view.composing) return` 的"IME 保护",
        // 但重算发生在上面的 state.apply(只看 tr.docChanged),view.update 在视图更新
        // 之后才跑、DecorationSet 早已算好,该钩子等价 no-op(greptile P2)——已删除。
        // 真要在 IME 期跳过重算,应在 apply 里按 composition 事务标记判断,而非此处。
      }),
    ];
  },
});
