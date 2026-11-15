import { describe, expect, it, vi } from 'vitest';
import { bindPlaybackUiEvents } from './player-playback-ui';

describe('bindPlaybackUiEvents', () => {
  it('bridges native play, pause, and ended events to ArtPlayer UI events', () => {
    const video = new EventTarget() as HTMLVideoElement;
    const emit = vi.fn();
    const cleanup = bindPlaybackUiEvents(video, emit);

    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('pause'));
    video.dispatchEvent(new Event('ended'));

    expect(emit.mock.calls).toEqual([['play'], ['pause'], ['pause']]);
    cleanup();
  });

  it('removes native listeners when the player is destroyed', () => {
    const video = new EventTarget() as HTMLVideoElement;
    const emit = vi.fn();
    const cleanup = bindPlaybackUiEvents(video, emit);

    cleanup();
    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('pause'));
    video.dispatchEvent(new Event('ended'));

    expect(emit).not.toHaveBeenCalled();
  });
});
