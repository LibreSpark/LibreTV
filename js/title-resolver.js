// 片名對照：把使用者輸入的片名（英文、台灣繁體、簡體）對應到「來源實際使用的片名」。
//
// 為什麼需要？
//   影片來源（maccms 採集站）收錄的幾乎都是大陸譯名（簡體），
//   但台灣與大陸對同一部片常常用不同的名字，單純轉換繁簡字是不夠的：
//     鐵達尼號 ⇄ 泰坦尼克号　　駭客任務 ⇄ 黑客帝国　　蜘蛛人 ⇄ 蜘蛛侠
//   英文片名（Titanic）更是來源完全比對不到。
//   所以這裡向公開的影視資料庫查詢「同一部作品在各地區的片名」，
//   再拿簡體片名去搜尋來源。
//
// 資料來源（依序嘗試）：
//   1. TMDB — 需要免費的 API 金鑰（環境變數 TMDB_API_KEY），電影／影集／動畫涵蓋最完整。
//   2. Wikidata — 免金鑰，作為預設方案。
//
// 查詢失敗、逾時、查無結果時一律靜默回傳空結果，搜尋會照原本的流程進行。
(function (global) {
    'use strict';

    const ZH = global.ZH;

    const EMPTY = Object.freeze({ cn: Object.freeze([]), latin: Object.freeze([]) });

    const REQUEST_TIMEOUT = 4000;      // 單一請求的逾時（毫秒）
    const TOTAL_BUDGET = 6000;         // 一次查詢的總時間上限（毫秒）
    const MIN_QUERY_LENGTH = 2;
    const MAX_QUERY_LENGTH = 60;
    const MAX_CN_TITLES = 4;           // 最多回傳幾個簡體片名
    const MAX_LATIN_TITLES = 2;        // 最多回傳幾個英文原名
    const MAX_CANDIDATES = 3;          // 最多採用幾個候選作品

    const CACHE_KEY = 'titleResolverCacheV1';
    const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
    const CACHE_MAX_ENTRIES = 300;
    const INFLIGHT_MAX_ENTRIES = 100;

    // Wikidata 的條目描述是英文，用來只留下影視作品、排除人物、專輯、遊戲等
    const WORK_RE = /\b(film|movie|television|tv series|web series|miniseries|series|anime|animated|ova|ona|documentary|sitcom|drama)\b/i;
    const NOT_WORK_RE = /\b(album|song|single|soundtrack|video game|novel|book|comic|manga|character|band|episode|season of|ride|attraction)\b/i;

    const CN_LABEL_LANGS = ['zh-cn', 'zh-hans', 'zh', 'zh-sg', 'zh-my'];
    const TW_LABEL_LANGS = ['zh-tw', 'zh-hant', 'zh-hk', 'zh-mo'];

    const inflight = new Map();

    /* ---------------- 小工具 ---------------- */

    function tmdbCredential() {
        const k = global.__ENV__ && global.__ENV__.TMDB_API_KEY;
        // 部署平台沒有替換掉佔位符時，字串會是 "{{TMDB_API_KEY}}"，視為沒有設定
        if (!k || typeof k !== 'string' || k.startsWith('{{') || k === 'undefined') return '';
        return k.trim();
    }

    function withTimeout(promise, ms) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), ms);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }

    async function fetchJson(url, init, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    // 先直接請求（TMDB、Wikidata 都支援 CORS），失敗再走專案內建的代理
    async function getJson(url, init) {
        try {
            return await fetchJson(url, init, REQUEST_TIMEOUT);
        } catch (directError) {
            // 帶自訂標頭的請求（TMDB v4 token）無法經由代理轉發
            if (init || typeof PROXY_URL === 'undefined') throw directError;
            const target = PROXY_URL + encodeURIComponent(url);
            const proxied = global.ProxyAuth && global.ProxyAuth.addAuthToProxyUrl
                ? await global.ProxyAuth.addAuthToProxyUrl(target)
                : target;
            return await fetchJson(proxied, undefined, REQUEST_TIMEOUT);
        }
    }

    function pushIfText(list, value) {
        if (typeof value === 'string' && value.trim()) list.push(value.trim());
    }

    function firstLabel(labels, langs) {
        for (const lang of langs) {
            const v = labels && labels[lang] && labels[lang].value;
            if (typeof v === 'string' && v.trim()) return v.trim();
        }
        return '';
    }

    // 去掉標題結尾的消歧義括號，例如「泰坦尼克号（1997年电影）」→「泰坦尼克号」
    function cleanTitle(t) {
        return String(t || '').replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
    }

    /* ---------------- 資料來源：TMDB ---------------- */

    async function lookupTmdb(q, credential) {
        const base = 'https://api.themoviedb.org/3/search/multi';
        const isV4Token = credential.startsWith('eyJ');   // v4 唯讀權杖是 JWT
        const init = isV4Token ? { headers: { Authorization: 'Bearer ' + credential } } : undefined;
        const make = (lang) => {
            let url = `${base}?query=${encodeURIComponent(q)}&language=${lang}&include_adult=false&page=1`;
            if (!isV4Token) url += `&api_key=${encodeURIComponent(credential)}`;
            return url;
        };

        const [cnRes, twRes] = await Promise.all([
            getJson(make('zh-CN'), init).catch(() => null),
            getJson(make('zh-TW'), init).catch(() => null),
        ]);

        const works = (res) => ((res && res.results) || [])
            .filter((r) => r && (r.media_type === 'movie' || r.media_type === 'tv'));
        const cnList = works(cnRes).slice(0, MAX_CANDIDATES);
        const twById = new Map(works(twRes).map((r) => [r.media_type + ':' + r.id, r]));

        const out = { cn: [], latin: [] };
        for (const r of cnList) {
            pushIfText(out.cn, r.title || r.name);
            const tw = twById.get(r.media_type + ':' + r.id);
            if (tw) pushIfText(out.cn, tw.title || tw.name);
            pushIfText(out.latin, r.original_title || r.original_name);
        }
        // 台灣片名查不到對應的簡體結果時（TMDB 偶爾只收錄其中一種），仍保留台灣片名
        if (!cnList.length) {
            for (const r of works(twRes).slice(0, MAX_CANDIDATES)) {
                pushIfText(out.cn, r.title || r.name);
                pushIfText(out.latin, r.original_title || r.original_name);
            }
        }
        return out;
    }

    /* ---------------- 資料來源：Wikidata ---------------- */

    async function lookupWikidata(q) {
        const api = 'https://www.wikidata.org/w/api.php';
        const searchLangs = ZH.hasCJK(q) ? ['zh-tw', 'zh-cn'] : ['en'];

        const searches = await Promise.all(searchLangs.map((lang) => getJson(
            `${api}?action=wbsearchentities&search=${encodeURIComponent(q)}&language=${lang}` +
            `&uselang=en&type=item&limit=10&format=json&origin=*`
        ).catch(() => null)));

        const seen = new Set();
        const hits = [];
        for (const s of searches) {
            for (const h of (s && s.search) || []) {
                const desc = h.description || '';
                if (!h.id || seen.has(h.id)) continue;
                if (!WORK_RE.test(desc) || NOT_WORK_RE.test(desc)) continue;
                seen.add(h.id);
                hits.push(h);
            }
        }
        const top = hits.slice(0, MAX_CANDIDATES);
        if (!top.length) return { cn: [], latin: [] };

        const languages = [...CN_LABEL_LANGS, ...TW_LABEL_LANGS, 'en'].join('|');
        const detail = await getJson(
            `${api}?action=wbgetentities&ids=${top.map((h) => h.id).join('|')}` +
            `&props=labels&languages=${languages}&format=json&origin=*`
        );

        const out = { cn: [], latin: [] };
        for (const h of top) {
            const labels = detail && detail.entities && detail.entities[h.id] && detail.entities[h.id].labels;
            if (!labels) continue;
            pushIfText(out.cn, firstLabel(labels, CN_LABEL_LANGS));
            pushIfText(out.cn, firstLabel(labels, TW_LABEL_LANGS));
            pushIfText(out.latin, firstLabel(labels, ['en']));
        }
        return out;
    }

    /* ---------------- 查詢流程 ---------------- */

    async function lookup(q) {
        const credential = tmdbCredential();
        let result = null;
        if (credential) {
            try {
                result = await lookupTmdb(q, credential);
            } catch (e) {
                console.debug('TMDB 片名查詢失敗，改用 Wikidata:', e && e.message);
            }
        }
        if (!result || !result.cn.length) {
            try {
                result = await lookupWikidata(q);
            } catch (e) {
                console.debug('Wikidata 片名查詢失敗:', e && e.message);
                result = result || { cn: [], latin: [] };
            }
        }
        // 輸入中文時，來源裡幾乎不會有英文片名，省掉無謂的搜尋
        if (ZH.hasCJK(q)) result.latin = [];
        return result;
    }

    // 整理結果：簡體化、去重、去掉「已被較短片名涵蓋」的長片名
    function finalize(raw) {
        const cn = [];
        const seen = new Set();
        for (const t of (raw.cn || []).map(cleanTitle)) {
            if (!t || !ZH.hasCJK(t)) continue;
            const simplified = ZH.toCN(t);
            const k = ZH.normalizeTitle(simplified);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            cn.push(simplified);
        }
        // 來源以「包含」比對，搜尋較短的片名就會涵蓋較長的（復仇者聯盟 ⊂ 復仇者聯盟2），不必重複查詢
        const pruned = cn.filter((t, i) => {
            const nt = ZH.normalizeTitle(t);
            return !cn.some((o, j) => {
                if (j === i) return false;
                const no = ZH.normalizeTitle(o);
                return no.length >= 2 && nt.length > no.length && nt.includes(no);
            });
        });

        const latin = [];
        const latinSeen = new Set();
        for (const t of raw.latin || []) {
            const k = String(t).toLowerCase();
            if (!t || ZH.hasCJK(t) || latinSeen.has(k)) continue;
            latinSeen.add(k);
            latin.push(t);
        }
        return { cn: pruned.slice(0, MAX_CN_TITLES), latin: latin.slice(0, MAX_LATIN_TITLES) };
    }

    /* ---------------- 快取（localStorage，30 天） ---------------- */

    let persisted = null;

    function loadPersisted() {
        if (persisted) return persisted;
        try {
            const raw = global.localStorage.getItem(CACHE_KEY);
            persisted = raw ? JSON.parse(raw) : {};
            if (!persisted || typeof persisted !== 'object') persisted = {};
        } catch (e) {
            persisted = {};
        }
        return persisted;
    }

    function recall(key) {
        const entry = loadPersisted()[key];
        if (!entry || !entry.v || Date.now() - entry.t > CACHE_TTL) return null;
        return entry.v;
    }

    function remember(key, value) {
        const store = loadPersisted();
        store[key] = { t: Date.now(), v: value };
        const keys = Object.keys(store);
        if (keys.length > CACHE_MAX_ENTRIES) {
            keys.sort((a, b) => store[a].t - store[b].t)
                .slice(0, keys.length - CACHE_MAX_ENTRIES)
                .forEach((k) => delete store[k]);
        }
        try {
            global.localStorage.setItem(CACHE_KEY, JSON.stringify(store));
        } catch (e) {
            // 儲存空間不足或被停用時，只是少了快取，不影響功能
        }
    }

    /* ---------------- 對外介面 ---------------- */

    function shouldResolve(q) {
        if (q.length < MIN_QUERY_LENGTH || q.length > MAX_QUERY_LENGTH) return false;
        if (/^https?:\/\//i.test(q)) return false;
        return /\p{L}/u.test(q);   // 至少要有一個字母或漢字，純數字、純符號不查
    }

    // 回傳 Promise<{ cn: string[], latin: string[] }>，永遠不會 reject。
    //   cn    — 簡體片名（來源使用的寫法）
    //   latin — 英文原名（少數來源有收錄英文名）
    function resolve(query) {
        const q = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
        if (!ZH || !shouldResolve(q)) return Promise.resolve(EMPTY);

        const key = ZH.normalizeTitle(q);
        if (!key) return Promise.resolve(EMPTY);
        if (inflight.has(key)) return inflight.get(key);

        const cached = recall(key);
        let task;
        if (cached) {
            task = Promise.resolve(cached);
        } else {
            task = withTimeout(lookup(q), TOTAL_BUDGET)
                .then(finalize)
                .catch(() => EMPTY)
                .then((res) => {
                    if (res.cn.length || res.latin.length) {
                        remember(key, res);
                    } else {
                        inflight.delete(key);   // 沒查到就不留著，下次搜尋時再試一次
                    }
                    return res;
                });
        }
        if (inflight.size >= INFLIGHT_MAX_ENTRIES) inflight.clear();
        inflight.set(key, task);
        return task;
    }

    global.TitleResolver = {
        resolve,
        // 提供測試使用
        _internals: { finalize, lookupTmdb, lookupWikidata, shouldResolve, cleanTitle },
    };
})(window);
