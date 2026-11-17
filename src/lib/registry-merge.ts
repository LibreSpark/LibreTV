type Payload = Record<string, unknown>;

type RegistryItem = Record<string, unknown>;

function items(payload: unknown, key: 'resources' | 'queued'): RegistryItem[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const value = (payload as Payload)[key];
  return Array.isArray(value)
    ? value.filter((item): item is RegistryItem => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function deduplicate(values: RegistryItem[]): RegistryItem[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = typeof value.id === 'string' ? `id:${value.id}` : '';
    const url = typeof value.url === 'string' ? `url:${value.url}` : '';
    if ((id && seen.has(id)) || (url && seen.has(url))) return false;
    if (id) seen.add(id);
    if (url) seen.add(url);
    return true;
  });
}

export function mergeRegistryPayloads(payloads: unknown[]): Payload {
  const validPayloads = payloads.filter(
    (payload): payload is Payload => Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload),
  );
  const primary = validPayloads[0] ?? {};
  const resources = deduplicate(validPayloads.flatMap((payload) => items(payload, 'resources')));
  const queued = deduplicate(validPayloads.flatMap((payload) => items(payload, 'queued')));
  return { ...primary, count: resources.length, resources, queued };
}
