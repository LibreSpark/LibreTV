'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import { useAppStore } from '@/lib/store';
import type { RegistrySearchResource } from '@/lib/types';

const PlayerShell = dynamic(
  () => import('@/components/player-shell').then((module) => module.PlayerShell),
  { ssr: false, loading: () => <div className="aspect-video w-full animate-pulse bg-black" /> },
);

export function RegistryInlinePlayer({
  resource,
  onClose,
}: {
  resource: RegistrySearchResource | null;
  onClose: () => void;
}) {
  const adFilter = useAppStore((state) => state.adFilter);
  const autoSkipSegments = useAppStore((state) => state.autoSkipSegments);
  const autoplayNext = useAppStore((state) => state.autoplayNext);
  const [pendingStart, setPendingStart] = useState<number | null>(null);

  const confirmPlayback = useCallback((evidence: { mediaType: string; observedSeconds: number; progressedSeconds: number; decodedWidth: number; decodedHeight: number; selectedRenditionHeight: number; selectedRenditionBitrateKbps: number }) => {
    if (!resource?.candidate_id) return;
    void fetch(`/api/resource-collector/candidates/${resource.candidate_id}/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: evidence.mediaType,
        observed_seconds: evidence.observedSeconds,
        progressed_seconds: evidence.progressedSeconds,
        decoded_width: evidence.decodedWidth,
        decoded_height: evidence.decodedHeight,
        selected_rendition_height: evidence.selectedRenditionHeight,
        selected_rendition_bitrate_kbps: evidence.selectedRenditionBitrateKbps,
      }),
    }).catch(() => {
      // Playback remains available if the audit writeback service is temporarily offline.
    });
  }, [resource?.candidate_id]);

  if (!resource) return null;
  const mediaType = resource.media_format;
  if (!resource.candidate_id || !mediaType || !['hls', 'mp4', 'webm'].includes(mediaType)) return null;

  return (
    <div
      className="home-inline-player fixed inset-0 z-[300] flex items-center justify-center overflow-y-auto bg-black/95 p-3 sm:p-6"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-[#101014] text-white shadow-2xl" role="dialog" aria-modal="true" aria-label={`正在播放：${resource.title}`}>
        <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold sm:text-lg">{resource.title}</h2>
            <p className="truncate text-xs text-white/55">{resource.source_name ?? 'LibreTV Registry'} · 已验证资源</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-xl" aria-label="关闭播放器">×</button>
        </header>
        <div className="aspect-video w-full bg-black">
          <PlayerShell
            key={resource.id}
            url={resource.url}
            title={resource.title}
            mediaType={mediaType}
            onPlaybackConfirmed={confirmPlayback}
            adFilter={adFilter}
            autoplayNext={autoplayNext}
            autoSkipSegments={autoSkipSegments}
            pendingStart={pendingStart}
            onPendingStart={setPendingStart}
            episodeKey={`registry:${resource.id}`}
          />
        </div>
      </section>
    </div>
  );
}
