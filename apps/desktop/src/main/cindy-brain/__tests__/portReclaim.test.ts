/**
 * portReclaim 单测:占用检测走真实 netstat / lsof(Windows / macOS 系统自带;
 * Linux 环境缺 lsof 时查询降级 null,相关断言按平台放宽),强杀路径只测护栏
 * ——真杀进程的分支靠护栏外不可达的 PID 无法安全自动化,由人工验证覆盖。
 */
import * as http from 'node:http';
import { describe, expect, it } from 'vitest';

import { findPortOwnerPids, killPortOwner, reclaimLoopbackPort } from '../portReclaim.js';

/** Windows / macOS 自带查询工具,结果必须精确;其它平台(Linux CI)可能缺 lsof。 */
const strictPlatform = process.platform === 'win32' || process.platform === 'darwin';

async function listenLoopback(srv: http.Server): Promise<number> {
  return new Promise<number>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('portReclaim', () => {
  it('findPortOwnerPids:自家 127.0.0.1 监听的端口查出本进程 PID', async () => {
    const srv = http.createServer();
    const port = await listenLoopback(srv);
    try {
      const pids = await findPortOwnerPids(port);
      if (strictPlatform) {
        expect(pids).toContain(process.pid);
      } else {
        expect(pids.length === 0 || pids.includes(process.pid)).toBe(true);
      }
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('findPortOwnerPids:空闲端口返回空数组', async () => {
    const srv = http.createServer();
    const port = await listenLoopback(srv);
    await new Promise((r) => srv.close(r));
    await expect(findPortOwnerPids(port)).resolves.toEqual([]);
  });

  it('findPortOwnerPids:只认挡路地址——绑非环回 IP 的监听不列为候选(不误杀)', async () => {
    // 找一个非环回的本机 IPv4 地址;没有(离线环境)就跳过断言主体。
    const os = await import('node:os');
    const lanAddr = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (!lanAddr) return;
    const srv = http.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(0, lanAddr, () => {
        const addr = srv.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    }).catch(() => 0);
    if (port === 0) return; // 绑 LAN IP 失败(权限/网络形态),跳过
    try {
      // 该端口上只有一条绑 LAN IP 的监听:不会挡 127.0.0.1 bind,必须查不出候选。
      await expect(findPortOwnerPids(port)).resolves.toEqual([]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('killPortOwner:拒杀本进程 / 系统 PID / 非法 PID', async () => {
    await expect(killPortOwner(process.pid)).resolves.toBe(false);
    await expect(killPortOwner(0)).resolves.toBe(false);
    await expect(killPortOwner(4)).resolves.toBe(false);
    await expect(killPortOwner(-1)).resolves.toBe(false);
    await expect(killPortOwner(2.5)).resolves.toBe(false);
  });

  it('reclaimLoopbackPort:占用者是本进程时拒绝回收(护栏),端口空闲时放行重试', async () => {
    const srv = http.createServer();
    const port = await listenLoopback(srv);
    try {
      if (strictPlatform) {
        // 占用者 = 自己 → killPortOwner 护栏拒杀 → 回收失败。
        await expect(reclaimLoopbackPort(port)).resolves.toBe(false);
      }
    } finally {
      await new Promise((r) => srv.close(r));
    }
    // 端口已空闲:查无占用者 → 返回 true 让调用方直接重试 listen。
    await expect(reclaimLoopbackPort(port)).resolves.toBe(true);
  });
});
