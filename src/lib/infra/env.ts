let cached: { ZHIPU_API_KEY: string; METADATA_API_KEY: string; LLM_MODEL: string } | null = null;

export function getEnv() {
  if (cached) return cached;
  const apiKey = process.env.ZHIPU_API_KEY;
  const metaKey = process.env.METADATA_API_KEY;
  
  if (!apiKey) throw new Error('[env] 缺少 ZHIPU_API_KEY');
  if (!metaKey) throw new Error('[env] 缺少 METADATA_API_KEY');

  cached = {
    ZHIPU_API_KEY: apiKey,
    METADATA_API_KEY: metaKey,
    LLM_MODEL: process.env.LLM_MODEL || 'glm-4-air',
  };
  return cached;
}
