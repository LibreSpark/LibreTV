#!/usr/bin/env node
/**
 * 本地同步豆瓣周榜海报。
 * 必须在已登录豆瓣的 Chrome + OpenCLI Browser Bridge 所在电脑运行。
 * 只把公开海报 URL 写入 src/data/douban-posters.json，不读取或上传 Cookie。
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, 'src/data/douban-posters.json');
const PRIMARY = (process.env['60S_API_BASE'] || 'https://60s.viki.moe').replace(/\/+$/, '');
const FALLBACK = 'https://60s.crystelf.top';
const PER_CATEGORY = Math.max(1, Math.min(20, Number(process.env.DOUBAN_POSTERS_PER_CATEGORY) || 8));
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.DOUBAN_POSTERS_CONCURRENCY) || 2));
const CATEGORIES = ['movie', 'tv_chinese', 'tv_global', 'show_chinese', 'show_global'];

function runOpenCli(subjectId) {
  return new Promise((resolve, reject) => {
    const child = spawn('opencli', ['douban', 'photos', String(subjectId), '--limit', '1', '-f', 'json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `opencli exited with code ${code}`));
      try {
        const text = stdout.trim();
        let parsed;
        try { parsed = JSON.parse(text); }
        catch {
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start < 0 || end <= start) throw new Error('OpenCLI output is not JSON');
          parsed = JSON.parse(text.slice(start, end + 1));
        }
        const payload = parsed?.result ?? parsed?.data ?? parsed;
        const photos = Array.isArray(payload) ? payload : payload?.photos;
        const candidate = Array.isArray(photos) ? photos[0] : null;
        const imageUrl = candidate?.imageUrl || candidate?.image_url || candidate?.url || '';
        const url = new URL(imageUrl);
        if (url.protocol !== 'https:' || !/(^|\.)doubanio\.com$/i.test(url.hostname)) {
          throw new Error('No valid Douban CDN imageUrl in OpenCLI JSON');
        }
        resolve(url.toString());
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function fetchCategory(category) {
  const bases = PRIMARY === FALLBACK ? [PRIMARY] : [PRIMARY, FALLBACK];
  for (const base of bases) {
    try {
      const response = await fetch(`${base}/v2/douban/weekly/${category}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (Array.isArray(body?.data)) return body.data;
    } catch {}
  }
  console.warn(`[skip] 榜单获取失败：${category}`);
  return [];
}

async function main() {
  const subjects = new Map();
  for (const category of CATEGORIES) {
    const rows = await fetchCategory(category);
    for (const row of rows.slice(0, PER_CATEGORY)) {
      const id = String(row?.id || '').trim();
      if (/^\d+$/.test(id) && !subjects.has(id)) {
        subjects.set(id, String(row?.title || id));
      }
    }
  }
  if (!subjects.size) throw new Error('没有获取到豆瓣榜单条目，请检查 60s API 网络连接。');

  const entries = [...subjects.entries()];
  const overrides = {};
  let cursor = 0;
  let succeeded = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (cursor < entries.length) {
      const index = cursor++;
      const [id, title] = entries[index];
      try {
        overrides[id] = await runOpenCli(id);
        succeeded++;
        console.log(`[ok] ${title} (${id})`);
      } catch (error) {
        console.warn(`[skip] ${title} (${id}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  await Promise.all(workers);
  if (!succeeded) throw new Error('OpenCLI 没有返回可用海报；确认 Chrome 已登录豆瓣并运行 opencli doctor。');

  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
  console.log(`\n完成：成功 ${succeeded}/${entries.length} 张海报。`);
  console.log('接下来执行：git add src/data/douban-posters.json && git commit -m "chore: sync Douban poster URLs" && git push');
}

main().catch(error => {
  console.error(`同步失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
