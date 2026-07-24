import type { IpcHandler, IpcHandlerRegistry } from '../../ipcHandlerRegistry';

/** 内存版 IPC registry，用于直接 invoke handler body。 */
export class IpcHarness implements IpcHandlerRegistry {
  private readonly handlers = new Map<string, IpcHandler>();

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`duplicate IPC handler: ${channel}`);
    }
    this.handlers.set(channel, handler);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing IPC handler: ${channel}`);
    return await handler({}, ...args);
  }
}
