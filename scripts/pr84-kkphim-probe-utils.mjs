import { createHash } from "node:crypto";

export function getItems(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  return [];
}

export function getMovieDetail(payload) {
  return payload?.data?.item ?? payload?.item ?? payload;
}

export function getPlaybackLinks(payload) {
  const movie = getMovieDetail(payload);
  const episodes = Array.isArray(movie?.episodes)
    ? movie.episodes
    : Array.isArray(movie?.movie?.episodes)
      ? movie.movie.episodes
      : [];
  const links = [];
  for (const server of episodes) {
    for (const item of Array.isArray(server?.server_data) ? server.server_data : []) {
      const common = {
        server: String(server.server_name || "unknown"),
        episode: String(item.name || "unknown"),
      };
      for (const [kind, field] of [["hls", "link_m3u8"], ["embed", "link_embed"]]) {
        const value = typeof item?.[field] === "string" ? item[field].trim() : "";
        if (value) links.push({ ...common, kind, url: value });
      }
    }
  }
  return links;
}

export function getEmbedMediaUrls(rawUrl, html = "") {
  const urls = [];
  try {
    const page = new URL(rawUrl);
    const nested = page.searchParams.get("url");
    if (nested) urls.push(nested);
  } catch {}
  const normalized = String(html).replaceAll("\\/", "/").replaceAll("\\u0026", "&");
  const matches = normalized.match(/https?:[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/gi) || [];
  urls.push(...matches.map((value) => value.replace(/[),;]+$/, "")));
  return [...new Set(urls)];
}

/** Return only HTTPS script assets served by the embed page's own origin. */
export function getSameOriginScriptUrls(rawUrl, html) {
  const urls = [];
  let page;
  try { page = new URL(rawUrl); } catch { return urls; }
  const source = String(html).replaceAll("\\/", "/").replaceAll("\\u0026", "&");
  const expression = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi;
  for (const match of source.matchAll(expression)) {
    try {
      const url = new URL(match[2], page);
      if (url.protocol === "https:" && url.origin === page.origin && !url.username && !url.password) urls.push(url.toString());
    } catch {}
  }
  return [...new Set(urls)].slice(0, 4);
}

/** Keep direct HLS first, but retain an embed fallback for the same episode. */
export function selectPlaybackCandidates(links) {
  const hlsLinks = links.filter((link) => link.kind === "hls");
  const embedLinks = links.filter((link) => link.kind === "embed");
  if (hlsLinks.length) {
    return hlsLinks.map((link) => ({
      link,
      fallbackLink: embedLinks.find((candidate) =>
        candidate.server === link.server && candidate.episode === link.episode
      ) || embedLinks.find((candidate) => candidate.server === link.server) || embedLinks[0] || null,
    }));
  }
  return embedLinks.map((link) => ({ link, fallbackLink: null }));
}

export function sampleIndexes(length) {
  if (!length) return [];
  return [...new Set([0, Math.floor((length - 1) / 2), length - 1])];
}

// Return useful URL diagnostics without exposing signed query strings or full paths.
export function summarizeMediaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname || "/";
    const segments = pathname.split("/").filter(Boolean);
    const dateSegment = pathname.match(/(?:^|[/])(20\d{2}(?:[-/]\d{2}){1,2})(?:[/]|$)/)?.[1] || null;
    const extension = pathname.match(/\.([a-z0-9]{2,6})$/i)?.[1]?.toLowerCase() || "none";
    const pathFingerprint = createHash("sha256").update(pathname).digest("hex").slice(0, 12);
    return {
      hostname: url.hostname,
      pathDepth: segments.length,
      dateSegment,
      extension,
      pathFingerprint,
      hasQuery: Boolean(url.search),
    };
  } catch {
    return { hostname: "invalid-url", pathDepth: 0, dateSegment: null, extension: "unknown", pathFingerprint: null, hasQuery: false };
  }
}

export function summarizeResponseHeaders(headers) {
  const get = (name) => {
    const value = headers?.get?.(name);
    return value ? String(value).slice(0, 120) : null;
  };
  return {
    responseServer: get("server"),
    responseVia: get("via"),
    responseCache: get("cf-cache-status") || get("x-cache"),
    responseContentLength: get("content-length"),
  };
}



/** Inspect embed markup without executing untrusted JavaScript or exposing signed URLs. */
export function inspectEmbedPage(rawUrl, html) {
  const source = String(html);
  const normalized = source.replaceAll("\\/", "/").replaceAll("\\u0026", "&");
  const summarizeReferences = (tag, attribute) => {
    const expression = new RegExp("<" + tag + "\\b[^>]*\\b" + attribute + "\\s*=\\s*([\"'])(.*?)\\1", "gi");
    const refs = [];
    for (const match of normalized.matchAll(expression)) {
      try {
        const url = new URL(match[2], rawUrl);
        if (url.protocol === "https:" || url.protocol === "http:") refs.push(summarizeMediaUrl(url.toString()));
      } catch {}
    }
    return refs;
  };
  const title = normalized.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const markers = ["stream-bootstrap", "atob(", "base64", "fetch(", "XMLHttpRequest",
    "postMessage", "iframe", "video", "source", "m3u8", "jwplayer", "artplayer",
    "hls.js", "file:", "url:"];
  const lower = normalized.toLowerCase();
  return {
    embedPage: summarizeMediaUrl(rawUrl),
    title,
    htmlBytes: Buffer.byteLength(source, "utf8"),
    scriptCount: (normalized.match(/<script\b/gi) || []).length,
    scriptReferences: summarizeReferences("script", "src").slice(0, 8),
    iframeCount: (normalized.match(/<iframe\b/gi) || []).length,
    iframeReferences: summarizeReferences("iframe", "src").slice(0, 8),
    videoElementCount: (normalized.match(/<video\b/gi) || []).length,
    sourceElementCount: (normalized.match(/<source\b/gi) || []).length,
    inlineM3u8References: (normalized.match(/\.m3u8/gi) || []).length,
    markers: markers.filter((marker) => lower.includes(marker.toLowerCase())),
    directMediaCandidates: getEmbedMediaUrls(rawUrl, source).map(summarizeMediaUrl).slice(0, 12),
  };
}


/** Rank a small homepage sample using public metadata; stable order breaks ties. */
export function rankHomeItems(items, limit = 4) {
  const score = (item) => {
    const numeric = (...values) => values.map(Number).find((value) => Number.isFinite(value) && value > 0) || 0;
    const quality = String(item?.quality || item?.resolution || item?.video_quality || "").toLowerCase();
    const qualityScore = /2160|4k|uhd/.test(quality) ? 300 : /1080|fhd/.test(quality) ? 200 : /720|hd/.test(quality) ? 100 : 0;
    const rating = numeric(item?.rating, item?.score, item?.douban_score, item?.tmdb_rating);
    const popularity = numeric(item?.view, item?.views, item?.hits, item?.hot, item?.popularity);
    const hasPoster = Boolean(item?.poster || item?.cover || item?.thumb || item?.vod_pic || item?.pic);
    return qualityScore + Math.min(rating, 10) * 10 + Math.log10(popularity + 1) + (hasPoster ? 1 : 0);
  };
  return items.map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map(({ item }) => item);
}
