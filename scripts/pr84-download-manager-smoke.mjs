#!/usr/bin/env node
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const base = process.env.PR84_PREVIEW_URL || 'https://libretv-pr84-preview.bggdbh.workers.dev';
const origin = new URL(base);
const fixture = '/tmp/pr84-download-fixture.mp4';
const output = '/tmp/pr84-download-acceptance.mp4';
// Generate a real, decodable MP4 instead of labeling arbitrary bytes as video/mp4.
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=0.2:r=5',
  '-frames:v', '1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', '-f', 'mp4', fixture,
]);
const expected = await readFile(fixture);
if (expected.length < 16 || expected.subarray(4, 8).toString('ascii') !== 'ftyp') {
  throw new Error('Generated download fixture is not an ISO BMFF/MP4 file');
}
const fixtureFormat = execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=format_name', '-of', 'default=noprint_wrappers=1:nokey=1', fixture,
], { encoding: 'utf8' }).trim();
if (!fixtureFormat.split(',').includes('mp4')) throw new Error('Generated fixture is not recognized as MP4: ' + fixtureFormat);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];

async function waitForTask(page, title, state) {
  try {
    const snapshot = await page.waitForFunction(({ title, state }) => {
      const titleNodes = Array.from(document.querySelectorAll('p'))
        .filter((node) => node.textContent?.trim() === title);
      const cards = titleNodes.map((titleNode) => {
        let card = titleNode;
        while (card && !card.classList?.contains('card')) card = card.parentElement;
        return card;
      }).filter(Boolean);
      // A single add-download event must persist exactly one task.
      if (cards.length !== 1) return false;
      const card = cards[0];
      const text = card.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
      const ready = state === 'completed'
        ? text.includes('MP4') && text.includes('已完成')
        : text.includes('失败') && text.includes('HTTP 503') && Boolean(card.querySelector('[role="alert"]'));
      return ready ? {
        text,
        progress: card.querySelector('.h-1\\.5 > div')?.getAttribute('style') ?? null,
        alert: card.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
      } : false;
    }, { title, state }, { timeout: 30000 });
    return await snapshot.jsonValue();
  } catch (error) {
    const diagnostic = await page.evaluate(async (title) => {
      const titleNode = Array.from(document.querySelectorAll('p')).find((node) => node.textContent?.trim() === title);
      const ancestors = [];
      let node = titleNode;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        ancestors.push({ tag: node.tagName, className: typeof node.className === 'string' ? node.className : '', text: (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200) });
      }
      const tasks = await new Promise((resolve) => {
        const request = indexedDB.open('libretv');
        request.onerror = () => resolve({ error: request.error?.message ?? 'IndexedDB open failed' });
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('downloads')) { db.close(); return resolve({ error: 'downloads object store missing', stores: Array.from(db.objectStoreNames) }); }
          const tx = db.transaction('downloads', 'readonly');
          const get = tx.objectStore('downloads').getAll();
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => resolve({ error: get.error?.message ?? 'IndexedDB read failed' });
          tx.oncomplete = () => db.close();
        };
      });
      return { bodyText: document.body.innerText.slice(-5000), ancestors, tasks };
    }, title);
    throw new Error('Download task did not reach ' + state + ': ' + JSON.stringify(diagnostic) + '; ' + (error instanceof Error ? error.message : String(error)));
  }
}

try {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => errors.push(error.message));

  const successUrl = new URL('/__pr84__/download-fixture.mp4', origin).toString();
  const failureUrl = new URL('/__pr84__/download-failure.mp4', origin).toString();
  await page.route(successUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'video/mp4',
    headers: { 'content-length': String(expected.length), 'cache-control': 'no-store' },
    body: expected,
  }));
  await page.route(failureUrl, (route) => route.fulfill({
    status: 503,
    contentType: 'text/plain',
    body: 'deterministic PR84 download failure fixture',
  }));

  const response = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!response || response.status() !== 200) throw new Error('Preview homepage did not return HTTP 200');
  // The manager is a global root-layout feature; wait until its listener is
  // mounted before dispatching the same event used by the app's header action.
  await page.evaluate(() => new Promise((resolve, reject) => {
    if (window.__LIBRETV_DOWNLOAD_MANAGER_READY__) return resolve();
    const timeout = setTimeout(() => reject(new Error('Global download manager did not mount')), 30000);
    window.addEventListener('libretv:download-manager-ready', () => {
      clearTimeout(timeout);
      window.__LIBRETV_DOWNLOAD_MANAGER_READY__ = true;
      resolve();
    }, { once: true });
  }));
  await page.evaluate(() => window.dispatchEvent(new Event('libretv:show-download-manager')));
  await page.getByText('下载管理', { exact: true }).last().waitFor({ state: 'visible', timeout: 30000 });

  const title = 'PR84 下载文件输出验收';
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.evaluate(({ url, title }) => {
    window.dispatchEvent(new CustomEvent('libretv:add-download', { detail: { url, title, format: 'MP4' } }));
  }, { url: successUrl, title });
  const download = await downloadPromise;
  if (download.suggestedFilename() !== title + '.mp4') throw new Error('Unexpected filename: ' + download.suggestedFilename());
  await download.saveAs(output);
  const actual = await readFile(output);
  if (!actual.equals(expected)) throw new Error('Saved bytes did not match fixture');
  if (actual.subarray(4, 8).toString('ascii') !== 'ftyp') throw new Error('Saved file is missing the MP4 ftyp box');
  const savedFormat = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=format_name', '-of', 'default=noprint_wrappers=1:nokey=1', output,
  ], { encoding: 'utf8' }).trim();
  if (!savedFormat.split(',').includes('mp4')) throw new Error('Saved output is not recognized as MP4: ' + savedFormat);
  const successState = await waitForTask(page, title, 'completed');
  if (successState.progress && !successState.progress.includes('100%')) throw new Error('Progress bar did not reach 100%');
  console.log('PASS PR84 download file output', JSON.stringify({
    filename: download.suggestedFilename(),
    bytes: actual.length,
    container: savedFormat,
    sha256: createHash('sha256').update(actual).digest('hex'),
    task: successState,
  }));

  const failedTitle = 'PR84 下载失败反馈验收';
  await page.evaluate(({ url, title }) => {
    window.dispatchEvent(new CustomEvent('libretv:add-download', { detail: { url, title, format: 'MP4' } }));
  }, { url: failureUrl, title: failedTitle });
  const failureState = await waitForTask(page, failedTitle, 'failed');
  if (!failureState.alert?.includes('HTTP 503')) throw new Error('HTTP 503 failure was not shown to the user');
  if (errors.length) throw new Error('Preview page errors: ' + errors.join(' | '));
  console.log('PASS PR84 download failure feedback', JSON.stringify(failureState));
} finally {
  await unlink(output).catch(() => undefined);
  await unlink(fixture).catch(() => undefined);
  await browser.close();
}
