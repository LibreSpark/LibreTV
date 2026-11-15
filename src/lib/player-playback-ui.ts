export type PlaybackUiEvent = 'play' | 'pause';

/**
 * Keep ArtPlayer's public playback event bus aligned with the native media
 * element. Native controls (including iOS Safari's media UI) can change the
 * video state without going through ArtPlayer's play()/pause() methods.
 */
export function bindPlaybackUiEvents(
  video: HTMLVideoElement,
  emit: (event: PlaybackUiEvent) => void,
): () => void {
  const onPlay = () => emit('play');
  const onPause = () => emit('pause');
  const onEnded = () => emit('pause');

  video.addEventListener('play', onPlay);
  video.addEventListener('pause', onPause);
  video.addEventListener('ended', onEnded);

  return () => {
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('ended', onEnded);
  };
}
