/**
 * mentionRefFormat —— 已上移到 `@cindy/maker-shared/mention-ref`。
 *
 * 这个 `@<path>` / `@"<path with space>"` 序列化格式是 renderer(composer 序列化、
 * 气泡回显)与 main(自动起名判定用户有没有真正打字)共用的 wire 约定,放在共享包
 * 才是单一真源;`apps/desktop/src/shared/` 按依赖方向不能反向 import renderer。
 * 本文件保留为 re-export,现有调用方无需改动。
 */
export {
  MENTION_TOKEN_SPLIT,
  formatMentionRef,
  mentionRefNeedsQuoting,
  parseMentionToken,
} from '@cindy/maker-shared/mention-ref';
