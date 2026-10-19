import { tr } from '@/lib/i18n-core';

/**
 * 下载文件的保存目标：
 * - Chromium（Edge/Chrome）：showSaveFilePicker 边下边写盘（FS Access API），
 *   必须在**用户手势内**调用（点击处理器的同步栈中）；
 * - 其余环境：内存聚合为 Blob 后触发浏览器下载（>500MB 时让用户确认）。
 *
 * 有意不做 StreamSaver（mitm.html + SW 中转）：云平台域名下 SW 注册受限，
 * 复杂度高、收益边际——大文件场景建议直接使用 FS Access 浏览器。
 */

export interface SaveTarget {
  /** 'fs' = 磁盘直写；'memory' = 内存聚合 */
  kind: 'fs' | 'memory';
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export function detectSavingCapability(): 'fs-access' | 'memory' {
  return supportsFileSystemAccess() ? 'fs-access' : 'memory';
}

export class UserCancelledError extends Error {
  constructor() {
    super('用户取消了保存');
  }
}

function memoryTarget(filename: string, confirmOverBytes = 500 * 1024 * 1024): SaveTarget {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  const flush = () => {
    if (done) return;
    done = true;
    const blob = new Blob(chunks.map((c) => c.buffer as ArrayBuffer));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return {
    kind: 'memory',
    async write(data) {
      if (done) return;
      bytes += data.byteLength;
      if (bytes > confirmOverBytes && bytes - data.byteLength <= confirmOverBytes) {
        if (!window.confirm(tr('下载体积已超过 {mb}MB，继续将暂存在内存中，可能导致页面卡顿。是否继续？', { mb: Math.round(confirmOverBytes / 1024 / 1024) }))) {
          throw new Error('用户取消了下载（内存超限）');
        }
      }
      chunks.push(data);
    },
    async close() {
      flush();
    },
    async abort() {
      done = true;
      chunks.length = 0;
    },
  };
}

/**
 * 选择保存目标并打开写入流。showSaveFilePicker 必须在用户手势内调用，
 * 因此本函数应在点击处理器里被 await（调用方负责）。
 * 用户取消文件选择器时抛出 UserCancelledError。
 */
export async function pickSaveTarget(filename: string, estimatedBytes?: number): Promise<SaveTarget> {
  if (supportsFileSystemAccess()) {
    try {
      // Safari 会暴露 showSaveFilePicker 之外的旧实现；直接 try/catch 兜底
      const picker = (
        window as unknown as {
          showSaveFilePicker: (opts: {
            suggestedName: string;
          }) => Promise<{ createWritable: () => Promise<WritableStream> }>;
        }
      ).showSaveFilePicker;
      const handle = await picker({ suggestedName: filename });
      const writable = await handle.createWritable();
      const writer = writable.getWriter();
      return {
        kind: 'fs',
        async write(data) {
          await writer.write(data);
        },
        async close() {
          await writer.close();
        },
        async abort() {
          try {
            await writer.abort();
          } catch { /* 已关闭则忽略 */ }
        },
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new UserCancelledError();
      }
      // 文件选择失败（权限/环境）→ 落到内存聚合
    }
  }
  if (estimatedBytes && estimatedBytes > 500 * 1024 * 1024) {
    if (!window.confirm(tr('该视频体积较大（未提供磁盘直写能力的环境），将暂存在内存中，可能导致页面卡顿。是否继续？'))) {
      throw new UserCancelledError();
    }
  }
  return memoryTarget(filename);
}
