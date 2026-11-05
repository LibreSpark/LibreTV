#!/usr/bin/env node
/**
 * 服务端同步豆瓣周榜公开海报地址。
 * 由 GitHub Actions 定时运行；不使用 OpenCLI、浏览器会话或 Cookie。
 * 只接受 HTTPS 豆瓣图片 CDN / 已配置的 60s 图片镜像域名。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, 'src/data/douban-posters.json');
const PRIMARY = (process.env['60S_API_BASE'] || 'https://60s.viki.moe').replace(/\/+$/, '');
const FALLBACK = 'https://60s.crystelf.top';
const PER_CATEGORY = Math.max(1, Math.min(20, Number(process.env.DOUBAN_POSTERS_PER_CATEGORY) || 12));
const CATEGORIES = ['movie', 'tv_chinese', 'tv_global', 'show_chinese', 'show_global'];
const ALLOWED_HOSTS = [/\.doubanio\.com$/i, /^doubanio\.viki\.moe$/i];

function validPosterUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.some(pattern => pattern.test(url.hostname))) return '';
    return url.toString();
  } catch {
    return '';
  }
}

async function readExisting() {
  try {
    const parsed = JSON.parse(await readFile(OUTPUT, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function fetchCategory(category) {
  const bases = PRIMARY === FALLBACK ? [PRIMARY] : [PRIMARY, FALLBACK];
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/v2/douban/weekly/${category}`, {
        headers: { accept: 'application/json', 'user-agent': 'LibreTV-Douban-Poster-Sync/1.0' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (Array.isArray(body?.data)) return body.data;
    } catch (error) {
      console.warn(`[retry] ${category} via ${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.warn(`[skip] 榜单获取失败：${category}`);
  return [];
}

async function main() {
  const overrides = await readExisting();
  let discovered = 0;
  let updated = 0;

  for (const category of CATEGORIES) {
    const rows = await fetchCategory(category);
    for (const row of rows.slice(0, PER_CATEGORY)) {
      const id = String(row?.id || '').trim();
      if (!/^\d+$/.test(id)) continue;
      discovered++;
      // 优先豆瓣原图；只有缺失时才采用 60s 提供的豆瓣图片镜像。
      const poster = validPosterUrl(row?.cover) || validPosterUrl(row?.cover_proxy);
      if (!poster) continue;
      if (overrides[id] !== poster) {
        overrides[id] = poster;
        updated++;
      }
    }
  }

  if (!discovered) {
    throw new Error('五类豆瓣周榜均未返回有效条目；为避免清空旧数据，本次不写入索引。');
  }

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
  console.log(`同步完成：读取 ${discovered} 条榜单记录，新增或更新 ${updated} 张海报；索引共 ${Object.keys(overrides).length} 条。`);
}

main().catch(error => {
  console.error(`同步失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
