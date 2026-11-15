import type { VideoInfo } from './types';

/**
 * Build real CMS search terms for related-title discovery.
 * Actor and director names are the strongest metadata available in Apple CMS
 * search; use the current title only when the source provides no people metadata.
 */
export function buildRelatedSearchTerms(info?: Pick<VideoInfo, 'actor' | 'director'>, fallbackTitle = ''): string[] {
  const splitPeople = (value?: string) => (value ?? '')
    .split(/[、,，;；|/]+/)
    .map((name) => name.trim())
    .filter((name) => name.length >= 2);

  const actors = splitPeople(info?.actor);
  const directors = splitPeople(info?.director);
  const people = [actors[0], directors[0], actors[1]].filter((name): name is string => Boolean(name));
  const seen = new Set<string>();
  const terms = people.filter((name) => {
    const key = name.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (terms.length > 0) return terms.slice(0, 2);
  const title = fallbackTitle.trim();
  return title ? [title.slice(0, 50)] : [];
}
