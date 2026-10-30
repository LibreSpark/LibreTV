// 產生 libs/opencc-lite.min.js：精簡版 OpenCC（簡 ⇄ 繁）轉換器。
//
// 為什麼要自己打包？
//   opencc-js 官方的 cn2t.js 約 1.1MB，其中 STPhrases 詞組字典就佔了 1MB，
//   但絕大多數詞條只是「逐字轉換的結果」，留著沒有意義。
//   這支腳本只保留「結果與逐字轉換不同」的詞條（例如 头发→頭髮、复杂→複雜），
//   體積可以縮到原本的六分之一左右，轉換結果幾乎一致。
//
// 使用方式（不會修改專案的 package.json）：
//   npm i --no-save opencc-js esbuild
//   node tools/build-opencc-lite.mjs
//
// 授權：opencc-js 為 MIT，OpenCC 字典為 Apache-2.0，聲明放在 libs/OPENCC-LICENSE.txt。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libDir = path.join(root, 'node_modules/opencc-js/dist/esm-lib');
const outFile = path.join(root, 'libs/opencc-lite.min.js');

const { Trie } = await import(pathToFileURL(path.join(libDir, 'core.js')).href);

async function dict(name) {
  const mod = await import(pathToFileURL(path.join(libDir, 'dict', `${name}.js`)).href);
  return mod.default;
}

function parse(serialized) {
  const map = new Map();
  for (const entry of serialized.split('|')) {
    const i = entry.indexOf(' ');
    if (i > 0) map.set(entry.slice(0, i), entry.slice(i + 1).split(' ')[0]);
  }
  return map;
}

// 只保留「對轉換結果有影響」的詞組。
// phraseDicts 依優先順序由低到高排列（後面的字典會覆蓋前面的同名詞條），
// 必須先合併再過濾，否則低優先字典的詞條會誤蓋過高優先字典。
//
// 判斷規則：
//   1. 結果與逐字轉換不同的詞條（头发→頭髮）一律保留。
//   2. 結果與逐字轉換相同的詞條，原則上可刪；但有些是「保護詞條」，
//      例如「一出去→一出去」是為了避免被較短的「一出→一齣」誤轉。
//      因此再依長度由短到長檢查：若精簡字典轉出來的結果與原字典不同，就補回該詞條。
function slimPhrases(phraseDicts, charDict) {
  const chars = parse(charDict);
  const convertByChar = (s) => [...s].map((c) => chars.get(c) ?? c).join('');
  const merged = new Map();
  for (const d of phraseDicts) {
    for (const [k, v] of parse(d)) merged.set(k, v);
  }

  const trie = new Trie();
  trie.loadDict(charDict);
  const kept = [];
  const redundantCandidates = [];
  for (const [k, v] of merged) {
    if (convertByChar(k) !== v) {
      trie.addWord(k, v);
      kept.push(`${k} ${v}`);
    } else {
      redundantCandidates.push([k, v]);
    }
  }

  let restored = 0;
  redundantCandidates.sort((a, b) => a[0].length - b[0].length);
  for (const [k, v] of redundantCandidates) {
    if (trie.convert(k) !== v) {
      trie.addWord(k, v);
      kept.push(`${k} ${v}`);
      restored++;
    }
  }
  console.log(`詞組精簡：${merged.size} → ${kept.length}（其中補回保護詞條 ${restored} 條）`);
  return kept.join('|');
}

const names = [
  'CJK_Compatibility_Ideographs', 'STCharacters', 'STPhrases', 'STPhrases_GeneratedFromRegionalPhrases',
  'TWVariants', 'TWVariantsPhrases', 'TWPhrases',
  'TSCharacters', 'TSPhrases', 'TWVariantsRev', 'TWVariantsRevPhrases', 'HKVariantsRev', 'HKVariantsRevPhrases',
];
const D = {};
for (const n of names) D[n] = await dict(n);

// STPhrases 的優先權高於 STPhrases_GeneratedFromRegionalPhrases
const stSlim = slimPhrases([D.STPhrases_GeneratedFromRegionalPhrases, D.STPhrases], D.STCharacters);

const data = {
  normalize: D.CJK_Compatibility_Ideographs,
  stPhrases: stSlim,
  stChars: D.STCharacters,
  twVariants: D.TWVariants,
  twVariantsPhrases: D.TWVariantsPhrases,
  twPhrases: D.TWPhrases,
  tsChars: D.TSCharacters,
  tsPhrases: D.TSPhrases,
  twVariantsRev: D.TWVariantsRev,
  twVariantsRevPhrases: D.TWVariantsRevPhrases,
  hkVariantsRev: D.HKVariantsRev,
  hkVariantsRevPhrases: D.HKVariantsRevPhrases,
};

const entry = `
import { Trie } from './core.js';
const D = ${JSON.stringify(data)};

function trieOf(...dicts) {
  const t = new Trie();
  t.loadDictGroup(dicts);
  return t;
}

// 與 opencc-js 的 ConverterBuilder 相同流程：正規化 → 斷詞 → 逐階段轉換
function makeConverter({ segmentation, stages }) {
  const norm = trieOf(D.normalize);
  const seg = segmentation ? trieOf(...segmentation) : null;
  const tries = stages.map((g) => trieOf(...g));
  return function convert(s) {
    if (!s) return s;
    let parts = seg ? seg.segment(norm.convert(s)) : [norm.convert(s)];
    for (const t of tries) parts = parts.map((p) => t.convert(p));
    return parts.join('');
  };
}

// 簡體 → 繁體（台灣字形，不改詞彙），適合片名、人名
export const cn2tw = makeConverter({
  segmentation: [D.stPhrases],
  stages: [[D.stPhrases, D.stChars], [D.twVariantsPhrases, D.twVariants]],
});

// 簡體 → 繁體（台灣字形 + 台灣常用詞彙），適合劇情簡介等一般文字
export const cn2twp = makeConverter({
  segmentation: [D.stPhrases],
  stages: [[D.stPhrases, D.stChars], [D.twPhrases, D.twVariantsPhrases, D.twVariants]],
});

// 繁體（台灣 / 香港）→ 簡體（只轉字形，不替換詞彙）
export const tw2cn = makeConverter({
  segmentation: [D.tsPhrases],
  stages: [
    [D.twVariantsRevPhrases, D.twVariantsRev, D.hkVariantsRevPhrases, D.hkVariantsRev],
    [D.tsPhrases, D.tsChars],
  ],
});
`;

await build({
  stdin: { contents: entry, resolveDir: libDir, loader: 'js', sourcefile: 'opencc-lite-entry.js' },
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'OpenCCLite',
  target: 'es2018',
  charset: 'utf8',
  banner: {
    js: '/*! opencc-lite — 精簡版 OpenCC 簡繁轉換。opencc-js (MIT) + OpenCC dictionaries (Apache-2.0)，詳見 libs/OPENCC-LICENSE.txt */',
  },
  outfile: outFile,
});

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`已輸出 ${path.relative(root, outFile)}（${kb} KB），保留詞組 ${stSlim.split('|').length} 條`);
