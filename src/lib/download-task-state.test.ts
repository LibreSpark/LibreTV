import { describe, expect, it } from 'vitest';
import { detectDownloadSourceFormat, recoverInterruptedDownloadStatus } from './download-task-state';

describe('detectDownloadSourceFormat', () => {
  it('recognizes HLS playlists with query strings', () => {
    expect(detectDownloadSourceFormat('https://cdn.example/movie.m3u8?token=x')).toBe('HLS');
  });
  it('recognizes HLS nested inside an encoded proxy URL', () => {
    expect(detectDownloadSourceFormat('/api/proxy?url=https%3A%2F%2Fcdn.example%2Fmovie.m3u8%3Ftoken%3Dx')).toBe('HLS');
  });
  it('recognizes direct MP4 files with query strings', () => {
    expect(detectDownloadSourceFormat('https://cdn.example/movie.mp4?sign=x')).toBe('MP4');
  });
  it('does not mislabel unknown media endpoints', () => {
    expect(detectDownloadSourceFormat('https://cdn.example/play?id=1')).toBe('OTHER');
  });
});

describe('recoverInterruptedDownloadStatus', () => {
  it.each(['validating', 'downloading', 'merging'] as const)('recovers interrupted %s tasks as paused', (status) => {
    expect(recoverInterruptedDownloadStatus(status)).toBe('paused');
  });
  it.each(['queued', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'error'] as const)('preserves stable %s tasks', (status) => {
    expect(recoverInterruptedDownloadStatus(status)).toBe(status);
  });
});
