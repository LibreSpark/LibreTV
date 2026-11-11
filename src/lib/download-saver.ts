/**
 * 下载文件的保存目标：
 * - Chromium（Edge/Chrome）：showSaveFilePicker 边下边写盘（FS Access API），
 *   必须在**用户手势内**调用（点击处理器的同步栈中）；
 * - 其余环境：内存聚合为 Blob 后触发浏览器下载（>500MB 时让用户确认）。
 *
 * 有意不做 StreamSaver（mitm.html + SW 中转）：云平台域名下 SW 注册受限，
 * 复杂度高、收益边际——大文件场景建议直接使用 FS Access 浏览器。
 *
 * 「交给浏览器」不等于「已存到设备」（issue #977）：`a.click()` 是 fire-and-forget，
 * 浏览器不提供任何落盘回执，移动端还常见静默丢弃（无手势、切后台、体积超标签内存）。
 * 所以内存模式产出的 Blob 与 objectURL 由调用方持有、任务删除时才 revoke，
 * 面板据此把这类任务标成「已生成，待保存」并给出「保存到设备」重入口，
 * 用户发现没保存成功时再点一次即可，不必重下整集。
 */

export interface SaveTarget {
  /** 'fs' = 磁盘直写；'memory' = 内存聚合 */
  kind: 'fs' | 'memory';
  /** 建议文件名：内存模式重复触发保存时沿用 */
  filename: string;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
  /**
   * close() 之后可取到的 Blob objectURL，供「保存到设备 / 重新保存」复用。
   * fs 直写恒为 null——那条路径的落盘由浏览器文件句柄负责，无需我们重放。
   */
  savedUrl(): string | null;
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

/**
 * 把 objectURL 交给浏览器下载。注意这只是「发起」保存：没有任何回执可等，
 * 调用方不能据此断言文件已落盘。
 */
export function triggerBrowserDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  // 同步 remove 在部分引擎里会被当成取消下载，交给下一轮事件循环再摘
  setTimeout(() => { a.remove(); }, 0);
}

/** 丢弃内存模式保留的 Blob：任务记录删除时调用，之后「保存到设备」不再可用。 */
export function releaseSavedBlob(target: SaveTarget): void {
  const url = target.savedUrl();
  if (url) URL.revokeObjectURL(url);
}

/** 内存聚合目标：导出仅为便于对「阈值确认 / 取消不产出」这类分支做测试。 */
export function createMemoryTarget(filename: string, confirmOverBytes = 500 * 1024 * 1024): SaveTarget {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  let aborted = false;
  let url: string | null = null;
  const flush = () => {
    // 已生成过就直接复用同一个 Blob：close() 可能被重复调用（续传路径与主路径），
    // 重新复制一遍字节既浪费内存，也会让 objectURL 越攒越多。
    // aborted 单独判：取消后 done 也为真，但那时绝不能把空产物发给浏览器。
    if (aborted || url) return;
    done = true;
    const blob = new Blob(chunks.map((c) => c.buffer as ArrayBuffer));
    // Blob 已持有全部字节，分片数组就地释放（Chromium 的大 Blob 由 blob storage 兜底，
    // 不一定继续占 JS 堆），这样保留可重存的产物不会等于把整集再背一份。
    chunks.length = 0;
    url = URL.createObjectURL(blob);
    triggerBrowserDownload(url, filename);
  };
  return {
    kind: 'memory',
    filename,
    async write(data) {
      if (done) return;
      bytes += data.byteLength;
      if (bytes > confirmOverBytes && bytes - data.byteLength <= confirmOverBytes) {
        if (!window.confirm(`下载体积已超过 ${Math.round(confirmOverBytes / 1024 / 1024)}MB，继续将暂存在内存中，可能导致页面卡顿。是否继续？`)) {
          throw new Error('用户取消了下载（内存超限）');
        }
      }
      chunks.push(data);
    },
    async close() {
      flush();
    },
    async abort() {
      aborted = true;
      done = true;
      chunks.length = 0;
    },
    savedUrl: () => url,
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
        filename,
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
        // 磁盘直写没有「待重放」的 Blob：字节已经在用户选定的文件里
        savedUrl: () => null,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new UserCancelledError();
      }
      // 文件选择失败（权限/环境）→ 落到内存聚合
    }
  }
  if (estimatedBytes && estimatedBytes > 500 * 1024 * 1024) {
    if (!window.confirm('该视频体积较大（未提供磁盘直写能力的环境），将暂存在内存中，可能导致页面卡顿。是否继续？')) {
      throw new UserCancelledError();
    }
  }
  return createMemoryTarget(filename);
}
