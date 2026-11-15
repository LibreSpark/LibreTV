import test from "node:test";
import assert from "node:assert/strict";
import { getItems, getMovieDetail, getPlaybackLinks, getEmbedMediaUrls, getSameOriginScriptUrls, sampleIndexes, rankHomeItems, selectPlaybackCandidates } from "./pr84-kkphim-probe-utils.mjs";

test("reads legacy and v1 home list shapes", () => {
  assert.equal(getItems({ items: [{ slug: "old" }] })[0].slug, "old");
  assert.equal(getItems({ data: { items: [{ slug: "v1" }] } })[0].slug, "v1");
  assert.deepEqual(getItems({ data: { items: "invalid" } }), []);
});

test("reads legacy and v1 detail wrappers", () => {
  const movie = { slug: "movie", episodes: [] };
  assert.equal(getMovieDetail({ data: { item: movie } }), movie);
  const legacy = { movie: { slug: "legacy", episodes: [] } };
  assert.equal(getMovieDetail(legacy), legacy);
});

test("collects both HLS and embed links across every server and episode", () => {
  const payload = { data: { item: { episodes: [
    { server_name: "A", server_data: [{ name: "E1", link_m3u8: "https://cdn.test/a.m3u8", link_embed: "https://player.test/?url=https%3A%2F%2Fcdn.test%2Fb.m3u8" }] },
    { server_name: "B", server_data: [{ name: "E2", link_embed: "https://player.test/embed/2" }] },
  ] } } };
  const links = getPlaybackLinks(payload);
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((item) => item.kind), ["hls", "embed", "embed"]);
  assert.equal(links[2].server, "B");
});

test("handles empty servers and missing playback fields", () => {
  assert.deepEqual(getPlaybackLinks({ data: { item: { episodes: [{ server_name: "empty", server_data: [] }] } } }), []);
});

test("extracts nested and page-embedded m3u8 candidates", () => {
  const input = "https://player.phimapi.com/player/?url=https%3A%2F%2Fcdn.test%2Fmain.m3u8";
  const urls = getEmbedMediaUrls(input, 'const source="https://cdn.test/variant.m3u8?token=x";');
  assert.deepEqual(urls, ["https://cdn.test/main.m3u8", "https://cdn.test/variant.m3u8?token=x"]);
});

test("limits static embed script inspection to same-origin HTTPS assets", () => {
  const html = '<script src="/assets/player.js?token=private"></script>' +
    '<script src="https://player.example/config.js"></script>' +
    '<script src="https://third-party.example/player.js"></script>' +
    '<script src="http://player.example/insecure.js"></script>';
  const urls = getSameOriginScriptUrls("https://player.example/player/?id=1", html);
  assert.deepEqual(urls, [
    "https://player.example/assets/player.js?token=private",
    "https://player.example/config.js",
  ]);
});

test("samples first, middle and last episode without duplicates", () => {
  assert.deepEqual(sampleIndexes(1), [0]);
  assert.deepEqual(sampleIndexes(4), [0, 1, 3]);
  assert.deepEqual(sampleIndexes(0), []);
});

test("summarizes media URLs without leaking signed query strings or full paths", async () => {
  const { summarizeMediaUrl } = await import("./pr84-kkphim-probe-utils.mjs");
  const summary = summarizeMediaUrl("https://cdn.example.com/2026/11/13/movie/episode.m3u8?token=secret&expires=123");
  assert.deepEqual(summary, {
    hostname: "cdn.example.com",
    pathDepth: 5,
    dateSegment: "2026/11/13",
    extension: "m3u8",
    pathFingerprint: summary.pathFingerprint,
    hasQuery: true,
  });
  assert.match(summary.pathFingerprint, /^[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
  assert.equal(JSON.stringify(summary).includes("episode.m3u8"), false);
});

test("summarizes host and path shape for embed and direct URLs without query values", async () => {
  const { summarizeMediaUrl } = await import("./pr84-kkphim-probe-utils.mjs");
  const summary = summarizeMediaUrl("https://player.phimapi.com/embed?id=123&token=hidden");
  assert.equal(summary.hostname, "player.phimapi.com");
  assert.equal(summary.extension, "none");
  assert.equal(summary.hasQuery, true);
  assert.equal(JSON.stringify(summary).includes("hidden"), false);
});

test("summarizes upstream response headers without request identifiers", async () => {
  const { summarizeResponseHeaders } = await import("./pr84-kkphim-probe-utils.mjs");
  const headers = new Headers({
    "server": "nginx",
    "via": "edge-cache",
    "cf-cache-status": "DYNAMIC",
    "content-length": "123",
    "x-request-id": "private-request-id",
  });
  const summary = summarizeResponseHeaders(headers);
  assert.deepEqual(summary, {
    responseServer: "nginx",
    responseVia: "edge-cache",
    responseCache: "DYNAMIC",
    responseContentLength: "123",
  });
  assert.equal(JSON.stringify(summary).includes("private-request-id"), false);
});


test("inspects embed page script and iframe references without leaking URL tokens", async () => {
  const { inspectEmbedPage } = await import("./pr84-kkphim-probe-utils.mjs");
  const html = '<title>KK Player</title><script src="/assets/player.js?token=private"></script>' +
    '<iframe src="https://frame.example/embed/one?sig=secret"></iframe>' +
    '<script>fetch("/api/stream"); const source="https://cdn.example/video.m3u8?key=hidden";</script>';
  const report = inspectEmbedPage("https://player.example/player/?url=https%3A%2F%2Fcdn.example%2Fold.m3u8", html);
  assert.equal(report.title, "KK Player");
  assert.equal(report.scriptCount, 2);
  assert.equal(report.iframeCount, 1);
  assert.equal(report.scriptReferences[0].hostname, "player.example");
  assert.equal(report.iframeReferences[0].hostname, "frame.example");
  assert.ok(report.markers.includes("fetch("));
  assert.ok(report.markers.includes("m3u8"));
  assert.equal(JSON.stringify(report).includes("private"), false);
  assert.equal(JSON.stringify(report).includes("secret"), false);
  assert.equal(JSON.stringify(report).includes("hidden"), false);
});


test("ranks a small homepage sample by quality, rating and popularity with stable ties", () => {
  const items = [
    { slug: "ordinary", rating: 6.8, views: 100 },
    { slug: "4k", quality: "4K", rating: 7.2 },
    { slug: "popular", rating: 9.1, views: 100000 },
    { slug: "middle", quality: "1080p", rating: 8.2 },
  ];
  assert.deepEqual(rankHomeItems(items, 3).map((item) => item.slug), ["4k", "middle", "popular"]);
  assert.deepEqual(rankHomeItems([{ slug: "a" }, { slug: "b" }], 2).map((item) => item.slug), ["a", "b"]);
});

test("retains an embed fallback when the preferred direct HLS URL is stale", () => {
  const hls = { server: "A", episode: "E1", kind: "hls", url: "https://cdn.test/dead.m3u8" };
  const matchingEmbed = { server: "A", episode: "E1", kind: "embed", url: "https://player.test/embed/e1" };
  const otherEmbed = { server: "B", episode: "E2", kind: "embed", url: "https://player.test/embed/e2" };
  const selected = selectPlaybackCandidates([hls, matchingEmbed, otherEmbed]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].link, hls);
  assert.equal(selected[0].fallbackLink, matchingEmbed);
});

test("uses embed candidates when a title has no direct HLS link", () => {
  const embed = { server: "A", episode: "E1", kind: "embed", url: "https://player.test/embed/e1" };
  assert.deepEqual(selectPlaybackCandidates([embed]), [{ link: embed, fallbackLink: null }]);
});
