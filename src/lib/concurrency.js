/**
 * 并发限流工具（防风控 / 控制内存与请求数）。
 * mapLimit：对数组逐项执行异步 fn，最多 limit 个并发。
 * Semaphore：信号量，用于限制任意异步区段的并发（如瀑布流解密）。
 */

/** 与 Array.map 同语义，但最多 limit 个并发；任一 fn 抛错则整体 reject */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Math.floor(max) || 1);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
