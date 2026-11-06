/**
 * Whether ArtPlayer's mini progress bar is enabled.
 * MINI_PROGRESS_BAR accepts true/false and defaults to true.
 */
export function getEnvMiniProgressBar(): boolean {
  const raw = process.env.MINI_PROGRESS_BAR?.trim().toLowerCase();
  if (!raw) return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  console.warn('[LibreTV] MINI_PROGRESS_BAR 取值无效，已使用默认值 true（可选 true / false）：', raw);
  return true;
}
