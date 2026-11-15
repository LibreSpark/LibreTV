/**
 * 直播 HLS 连续网络错误计数。
 * 只有成功加载媒体分片才代表播放链路恢复；成功刷新 level manifest 本身不清零。
 */
export class LiveNetworkRecovery {
  private failures = 0;

  constructor(private readonly maxRetries = 5) {}

  onNetworkError(): { action: 'retry'; attempt: number } | { action: 'stop'; attempt: number } {
    this.failures += 1;
    return this.failures > this.maxRetries
      ? { action: 'stop', attempt: this.failures }
      : { action: 'retry', attempt: this.failures };
  }

  markFragmentLoaded(): void {
    this.failures = 0;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
