import type { DownloadTaskEntry } from '@/lib/db';

export type DownloadSourceFormat = NonNullable<DownloadTaskEntry['sourceFormat']>;

/** Detect the media type even when an HLS/MP4 URL is nested or percent-encoded in a proxy URL. */
export function detectDownloadSourceFormat(url: string): DownloadSourceFormat {
  let candidate = url.toLowerCase();
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  if (/\.m3u8(?:$|[?#&])/.test(candidate) || candidate.includes('.m3u8/')) return 'HLS';
  if (/\.mp4(?:$|[?#&])/.test(candidate) || candidate.includes('.mp4/')) return 'MP4';
  return 'OTHER';
}

/** Tasks interrupted by a tab close/reload no longer have an active writer or AbortController. */
export function recoverInterruptedDownloadStatus(
  status: DownloadTaskEntry['status']
): DownloadTaskEntry['status'] {
  return status === 'validating' || status === 'downloading' || status === 'merging'
    ? 'paused'
    : status;
}
