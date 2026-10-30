// 簡繁轉換與片名正規化工具
// 依賴 libs/opencc-lite.min.js（由 tools/build-opencc-lite.mjs 產生）。
// 如果轉換庫沒有載入成功，所有函式都會原樣回傳，不會讓頁面壞掉。
(function (global) {
    'use strict';

    const lite = global.OpenCCLite || null;
    const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;

    // 顯示用的繁體字串 → 原始簡體字串。
    // 畫面上的片名是從簡體轉成繁體顯示的，使用者點下去再搜尋時，
    // 優先還原成來源原本的簡體寫法，避免「簡→繁→簡」遇到一對多字
    // （例如 发→發／髮、干→乾／幹）時失真。
    const REVERSE_MAX_ENTRIES = 5000;
    const REVERSE_MAX_LENGTH = 120;
    const reverse = new Map();

    function hasCJK(s) {
        return typeof s === 'string' && CJK_RE.test(s);
    }

    function attempt(fn, s) {
        try {
            return fn(s);
        } catch (e) {
            console.warn('簡繁轉換失敗:', e);
            return s;
        }
    }

    // 簡體 → 繁體（台灣字形，不替換詞彙）。適合片名、人名、分類名稱。
    function toTW(s) {
        if (!lite || typeof s !== 'string' || !s || !hasCJK(s)) return s;
        const out = attempt(lite.cn2tw, s);
        if (out !== s && s.length <= REVERSE_MAX_LENGTH) {
            if (reverse.size >= REVERSE_MAX_ENTRIES) reverse.clear();
            reverse.set(out, s);
        }
        return out;
    }

    // 簡體 → 繁體（台灣字形 + 台灣常用詞彙）。適合劇情簡介等一般文字。
    function toTWP(s) {
        if (!lite || typeof s !== 'string' || !s || !hasCJK(s)) return s;
        return attempt(lite.cn2twp, s);
    }

    // 繁體（台灣／香港）→ 簡體。用來把使用者輸入轉成來源使用的寫法。
    function toCN(s) {
        if (!lite || typeof s !== 'string' || !s || !hasCJK(s)) return s;
        if (reverse.has(s)) return reverse.get(s);
        return attempt(lite.tw2cn, s);
    }

    // 比對用的片名：統一成簡體、全形轉半形、轉小寫、去掉所有標點與空白。
    // 「鋼鐵人 2」「钢铁人2」「鋼鐵人２」會得到同樣的結果。
    function normalizeTitle(s) {
        if (typeof s !== 'string') return '';
        return toCN(s)
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '');
    }

    function sameTitle(a, b) {
        const na = normalizeTitle(a);
        return na !== '' && na === normalizeTitle(b);
    }

    // 把物件中指定的文字欄位轉成繁體，回傳新物件（不修改原物件）。
    function localizeFields(obj, fields, convert) {
        if (!obj || typeof obj !== 'object') return obj;
        const fn = convert || toTW;
        const copy = { ...obj };
        for (const f of fields) {
            if (typeof copy[f] === 'string') copy[f] = fn(copy[f]);
        }
        return copy;
    }

    global.ZH = {
        ready: !!lite,
        hasCJK,
        toTW,
        toTWP,
        toCN,
        normalizeTitle,
        sameTitle,
        localizeFields,
    };
})(window);
