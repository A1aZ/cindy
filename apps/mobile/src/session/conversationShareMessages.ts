import type {
  MobileMessageRenderItem,
  MobileWorkChildItem,
} from '@/session/messageRenderModel';
import { projectConversationShareMessage } from '@/session/conversationShareProjection';
import type { ConversationShareMessage } from '@/session/conversationShareWebViewHtml';
import { isShareableMessage } from '@/session/shareSelectionStore';

type ConversationShareRenderItem =
  MobileMessageRenderItem | MobileWorkChildItem;

/** 收集会影响分享候选集的折叠卡 key，供会话页订阅展开态变化。 */
export function collectConversationShareBlockIds(
  items: readonly MobileMessageRenderItem[],
): string[] {
  const blockIds: string[] = [];
  const visit = (item: ConversationShareRenderItem): void => {
    if (item.type === 'work_group') {
      blockIds.push(item.key);
      item.children.forEach(visit);
      return;
    }
    if (item.type === 'subagent_group') {
      blockIds.push(item.key);
      item.childItems.forEach(visit);
    }
  };
  items.forEach(visit);
  return blockIds;
}

/** 展平当前已展开的工作组 / 子 Agent，投影用户实际看得到的消息用于图片导出。 */
export function collectConversationShareMessages(
  items: readonly MobileMessageRenderItem[],
  isBlockExpanded: (blockId: string) => boolean,
): ConversationShareMessage[] {
  const messages: ConversationShareMessage[] = [];
  const visit = (item: ConversationShareRenderItem): void => {
    if (item.type === 'message') {
      if (!isShareableMessage(item.message)) return;
      const clientId =
        item.message.source.clientId ||
        item.message.source.id ||
        item.message.key;
      const projected = projectConversationShareMessage(clientId, item.message);
      if (projected) messages.push(projected);
      return;
    }
    if (item.type === 'work_group') {
      if (isBlockExpanded(item.key)) item.children.forEach(visit);
      return;
    }
    if (item.type === 'subagent_group' && isBlockExpanded(item.key)) {
      item.childItems.forEach(visit);
    }
  };
  items.forEach(visit);
  return messages;
}
