import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickSaveTarget, sanitizeDownloadFilename, suggestDownloadFilename, UserCancelledError } from './download-saver';

describe('download filename safety', () => {
  it('removes path separators and reserved filename characters', () => {
    const result = sanitizeDownloadFilename('../../evil:name?.mp4');
    expect(result).toBe('_.._evil_name_.mp4');
    expect(result).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('prefixes Windows reserved device names', () => {
    expect(sanitizeDownloadFilename('CON.mp4')).toBe('_CON.mp4');
    expect(sanitizeDownloadFilename('LPT1')).toBe('_LPT1');
  });

  it('removes control and bidirectional override characters', () => {
    expect(sanitizeDownloadFilename('safe\u202Ename\u0000.mp4')).toBe('safename.mp4');
  });

  it('keeps a valid extension when truncating long titles', () => {
    const result = sanitizeDownloadFilename('x'.repeat(240) + '.mp4');
    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith('.mp4')).toBe(true);
  });

  it('infers a direct media extension from the URL path, not its query string', () => {
    expect(suggestDownloadFilename('Episode 1', 'https://cdn.example.com/media/ep1.mkv?token=secret'))
      .toBe('Episode 1.mkv');
    expect(suggestDownloadFilename('Episode 1.mp4', 'https://cdn.example.com/media/ep1.mkv'))
      .toBe('Episode 1.mp4');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('pickSaveTarget file-output lifecycle', () => {
  it('writes and closes a File System Access writer', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const createWritable = vi.fn().mockResolvedValue({ getWriter: () => writer });
    const showSaveFilePicker = vi.fn().mockResolvedValue({ createWritable });
    vi.stubGlobal('window', { showSaveFilePicker });

    const target = await pickSaveTarget('episode.mp4');
    expect(target.kind).toBe('fs');
    await target.write(bytes);
    await target.close();

    expect(showSaveFilePicker).toHaveBeenCalledWith({ suggestedName: 'episode.mp4' });
    expect(createWritable).toHaveBeenCalledOnce();
    expect(writer.write).toHaveBeenCalledWith(bytes);
    expect(writer.close).toHaveBeenCalledOnce();
  });

  it('aborts the writable stream when a task fails', async () => {
    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn().mockResolvedValue({
        createWritable: vi.fn().mockResolvedValue({ getWriter: () => writer }),
      }),
    });

    const target = await pickSaveTarget('episode.mp4');
    await target.write(new Uint8Array([9, 8, 7]));
    await target.abort();

    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });

  it('maps the native picker AbortError to a deliberate user cancellation', async () => {
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')),
    });
    await expect(pickSaveTarget('episode.mp4')).rejects.toBeInstanceOf(UserCancelledError);
  });

  it('flushes the memory fallback as a browser download on close', async () => {
    vi.useFakeTimers();
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    const appendChild = vi.fn();
    const createElement = vi.fn(() => anchor);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download-test');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement, body: { appendChild } });

    const target = await pickSaveTarget('episode.ts');
    expect(target.kind).toBe('memory');
    await target.write(new Uint8Array([1, 2, 3]));
    await target.write(new Uint8Array([4, 5]));
    await target.close();

    expect(createElement).toHaveBeenCalledWith('a');
    expect(anchor.download).toBe('episode.ts');
    expect(anchor.href).toBe('blob:download-test');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();

    vi.runOnlyPendingTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download-test');
  });

  it('discards buffered bytes on abort instead of creating a partial file', async () => {
    vi.useFakeTimers();
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    const createElement = vi.fn(() => anchor);
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:must-not-exist');
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement, body: { appendChild: vi.fn() } });

    const target = await pickSaveTarget('episode.ts');
    await target.write(new Uint8Array([1, 2, 3]));
    await target.abort();
    await target.close();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(anchor.click).not.toHaveBeenCalled();
  });
});
