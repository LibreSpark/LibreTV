import type { VideoDetail } from './types';

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w780';
const REQUEST_TIMEOUT_MS = 5000;

type TmdbTvSearchResult = {
  id?: number;
  name?: string;
  original_name?: string;
  first_air_date?: string;
  backdrop_path?: string | null;
};

type TmdbSeasonEpisode = {
  id?: number;
  episode_number?: number;
  season_number?: number;
  still_path?: string | null;
  name?: string;
  overview?: string;
  runtime?: number | null;
};

type TmdbSeasonResponse = {
  episodes?: TmdbSeasonEpisode[];
};

export type TmdbArtworkMatch = {
  image: string;
  tmdbSeriesId: number;
  tmdbEpisodeId?: number;
  seasonNumber: number;
  episodeNumber: number;
  imageSource: 'tmdb';
};

function normalizeTitle(value: string): string {
  return value.toLocaleLowerCase().normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function parsePositiveInteger(value: string): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function chineseNumber(value: string): number | undefined {
  if (/^\d+$/.test(value)) return parsePositiveInteger(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (digits[value.slice(1)] ?? 0);
  if (value.endsWith('十')) return (digits[value.slice(0, -1)] ?? 1) * 10;
  const parts = value.split('十');
  if (parts.length === 2 && parts[0] in digits && parts[1] in digits) return digits[parts[0]] * 10 + digits[parts[1]];
  if (value in digits) return digits[value];
  return undefined;
}

export function parseEpisodeCoordinates(
  episodeTitle: string,
  seriesTitle: string,
): { seasonNumber: number; episodeNumber: number } | null {
  const seasonMatch = seriesTitle.match(/第\s*(\d+|[一二两三四五六七八九十]+)\s*季/u);
  const seasonNumber = seasonMatch ? chineseNumber(seasonMatch[1]) : 1;
  const patterns = [
    /第\s*(\d+|[一二两三四五六七八九十]+)\s*[集话期]/u,
    /\bS(\d{1,2})\s*E(\d{1,3})\b/i,
    /\b(?:episode|ep)\s*0*(\d{1,3})\b/i,
    /^\s*0*(\d{1,3})\s*$/,
  ];
  let episodeNumber: number | undefined;
  const chinese = episodeTitle.match(patterns[0]);
  if (chinese) episodeNumber = chineseNumber(chinese[1]);
  if (!episodeNumber) {
    const sxe = episodeTitle.match(patterns[1]);
    if (sxe) {
      const explicitSeason = parsePositiveInteger(sxe[1]);
      if (explicitSeason && seasonNumber && explicitSeason !== seasonNumber) return null;
      episodeNumber = parsePositiveInteger(sxe[2]);
    }
  }
  if (!episodeNumber) {
    const english = episodeTitle.match(patterns[2]);
    if (english) episodeNumber = parsePositiveInteger(english[1]);
  }
  if (!episodeNumber) {
    const numeric = episodeTitle.match(patterns[3]);
    if (numeric) episodeNumber = parsePositiveInteger(numeric[1]);
  }
  if (!seasonNumber || !episodeNumber) return null;
  return { seasonNumber, episodeNumber };
}

function extractSeriesTitle(title: string): string {
  return title
    .replace(/第\s*(?:\d+|[一二两三四五六七八九十]+)\s*季.*$/u, '')
    .replace(/\s+S\d{1,2}$/i, '')
    .trim();
}

async function tmdbGet<T>(path: string, token: string, query?: Record<string, string>): Promise<T | null> {
  const url = new URL(TMDB_API + path);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  if (!response.ok) return null;
  return await response.json() as T;
}

export async function enrichEpisodesWithTmdbArtwork(
  detail: VideoDetail,
  options: { token?: string; title?: string; originalTitle?: string; year?: string },
): Promise<VideoDetail> {
  const token = options.token?.trim();
  if (!token || !detail.episodeItems?.length) return detail;

  const displayTitle = options.title?.trim() || detail.videoInfo.title?.trim() || '';
  const queryTitle = extractSeriesTitle(displayTitle);
  const aliases = [...new Set([queryTitle, options.originalTitle?.trim()].filter((value): value is string => Boolean(value)))];
  if (aliases.length === 0) return detail;

  try {
    const year = options.year?.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
    const normalizedAliases = new Set(aliases.map((alias) => normalizeTitle(extractSeriesTitle(alias))));
    const search = async (alias: string, includeYear: boolean) => {
      const searchQuery: Record<string, string> = {
        query: extractSeriesTitle(alias),
        include_adult: 'false',
        language: 'zh-CN',
      };
      if (includeYear && year) searchQuery.first_air_date_year = year;
      const response = await tmdbGet<{ results?: TmdbTvSearchResult[] }>('/search/tv', token, searchQuery);
      return response?.results ?? [];
    };
    // First try the exact year. If the CMS year is a release/update year rather
    // than the original broadcast year, retry without it; still require an exact
    // normalized Chinese/original title match to avoid attaching another series' stills.
    const strictResults = (await Promise.all(aliases.map((alias) => search(alias, true)))).flat();
    const titleMatches = (items: TmdbTvSearchResult[]) => items.filter((item) =>
      Number.isSafeInteger(item.id) && (item.id ?? 0) > 0 &&
      [item.name, item.original_name].some((candidate) =>
        typeof candidate === 'string' && normalizedAliases.has(normalizeTitle(candidate))),
    );
    let candidates = titleMatches(strictResults);
    if (year) {
      candidates = candidates.filter((item) =>
        typeof item.first_air_date === 'string' && item.first_air_date.startsWith(year + '-'),
      );
    }
    if (candidates.length === 0 && year) {
      candidates = titleMatches((await Promise.all(aliases.map((alias) => search(alias, false)))).flat());
    }
    const match = candidates.sort((a, b) => {
      const aYear = year && a.first_air_date?.startsWith(year + '-') ? 1 : 0;
      const bYear = year && b.first_air_date?.startsWith(year + '-') ? 1 : 0;
      return bYear - aYear;
    })[0];
    if (!match?.id) return detail;

    const parsedCoordinates = detail.episodeItems.map((item) => parseEpisodeCoordinates(item.title, displayTitle));
    const seasonNumbers = [...new Set(parsedCoordinates
      .map((coordinates) => coordinates?.seasonNumber)
      .filter((value): value is number => Boolean(value)))];
    // Some CMS feeds expose episode URLs but leave their labels blank or use
    // non-standard text. Try season 1, then permit positional matching only
    // when the CMS item count exactly equals TMDB's season episode count.
    const lookupSeasonNumbers = seasonNumbers.length > 0 ? seasonNumbers : [1];

    const seasonData = await Promise.all(lookupSeasonNumbers.map(async (seasonNumber) => {
      const response = await tmdbGet<TmdbSeasonResponse>(
        '/tv/' + match.id + '/season/' + seasonNumber,
        token,
        { language: 'zh-CN' },
      );
      return { seasonNumber, episodes: response?.episodes ?? [] };
    }));
    const episodeMetadata = new Map<string, TmdbSeasonEpisode>();
    for (const season of seasonData) {
      for (const episode of season.episodes) {
        const episodeNumber = parsePositiveInteger(String(episode.episode_number ?? ''));
        if (episodeNumber === undefined) continue;
        episodeMetadata.set(season.seasonNumber + ':' + episodeNumber, episode);
      }
    }

    let changed = false;
    const seriesBackdrop = match.backdrop_path
      ? TMDB_IMAGE.replace('/w780', '/w1280') + '/' + match.backdrop_path.replace(/^\/+/, '')
      : undefined;
    const videoInfo = !detail.videoInfo.backdrop && seriesBackdrop
      ? { ...detail.videoInfo, backdrop: seriesBackdrop }
      : detail.videoInfo;
    if (videoInfo !== detail.videoInfo) changed = true;
    const canMatchByExactCount = seasonData.length === 1 &&
      seasonData[0].episodes.length === detail.episodeItems.length;
    const positionalSeason = canMatchByExactCount ? seasonData[0].seasonNumber : undefined;
    const episodeItems = detail.episodeItems.map((item, index) => {
      const coordinates = parsedCoordinates[index] ?? (
        positionalSeason ? { seasonNumber: positionalSeason, episodeNumber: index + 1 } : null
      );
      if (!coordinates) return item;
      const tmdbEpisode = episodeMetadata.get(coordinates.seasonNumber + ':' + coordinates.episodeNumber);
      if (!tmdbEpisode) return item;
      const still = tmdbEpisode.still_path
        ? TMDB_IMAGE + '/' + tmdbEpisode.still_path.replace(/^\/+/, '')
        : undefined;
      // Never reuse a series-level backdrop as an episode still: missing stills stay missing.
      const artworkImage = still;
      const episodeName = typeof tmdbEpisode.name === 'string' ? tmdbEpisode.name.trim() : '';
      const overview = typeof tmdbEpisode.overview === 'string' ? tmdbEpisode.overview.trim() : '';
      const runtime = Number.isSafeInteger(tmdbEpisode.runtime) && (tmdbEpisode.runtime ?? 0) > 0
        ? String(tmdbEpisode.runtime) + '分钟'
        : undefined;
      const next = {
        ...item,
        ...(!item.image && artworkImage ? {
          image: artworkImage,
          imageSourceUrl: artworkImage,
          imageSourceEpisodeUrl: item.url,
          tmdbSeriesId: match.id,
          ...(Number.isSafeInteger(tmdbEpisode.id) ? { tmdbEpisodeId: tmdbEpisode.id } : {}),
          seasonNumber: coordinates.seasonNumber,
          episodeNumber: coordinates.episodeNumber,
          imageSource: 'tmdb' as const,
          imageKind: still ? 'episode-still' as const : 'series-backdrop' as const,
        } : {}),
        ...(!item.episodeName && episodeName ? { episodeName } : {}),
        ...(!item.description && overview ? { description: overview } : {}),
        ...(!item.duration && runtime ? { duration: runtime } : {}),
      };
      if (next.image !== item.image || next.episodeName !== item.episodeName ||
          next.description !== item.description || next.duration !== item.duration) changed = true;
      return next;
    });
    return changed ? { ...detail, videoInfo, episodeItems } : detail;
  } catch {
    // Metadata is optional: TMDB outages, missing credentials, or unmatched titles
    // must never interrupt episode selection or playback.
    return detail;
  }
}
