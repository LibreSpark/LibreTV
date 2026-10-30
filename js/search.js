// 搜尋模組
//
// 來源（maccms 採集站）收錄的片名多半是大陸譯名（簡體），所以：
//   1. 使用者輸入的繁體字會先轉成簡體再送出，同時保留原始輸入一併搜尋
//   2. 同時向 TitleResolver 查詢「同一部作品的其他片名」（英文片名、台灣譯名 → 大陸譯名），
//      查到的片名也會一併搜尋
//   3. 把各關鍵字的結果合併去重，並把顯示用的文字轉成繁體
// 這樣不管輸入英文、繁體或簡體片名，都能找到同一部作品。

// 補充關鍵字（片名對照查到的）最多抓幾頁。片名很具體，通常不需要翻很多頁。
const EXTRA_QUERY_MAX_PAGES = 3;

// 搜尋結果中要轉成繁體顯示的欄位
const SEARCH_RESULT_TEXT_FIELDS = [
    'vod_name', 'vod_sub', 'type_name', 'vod_remarks', 'vod_actor', 'vod_director', 'vod_area', 'vod_lang', 'vod_class'
];

function normalizeSearchTerm(term) {
    return window.ZH ? (ZH.normalizeTitle(term) || term) : term;
}

function uniqueTerms(terms) {
    const seen = new Set();
    const out = [];
    for (const t of terms) {
        const term = (t || '').trim();
        if (!term) continue;
        const key = normalizeSearchTerm(term);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(term);
    }
    return out;
}

// 立刻可以決定的關鍵字：簡體寫法（來源最可能使用）＋使用者的原始輸入
function buildQuickQueries(query) {
    const q = (query || '').trim();
    if (!q) return [];
    const simplified = window.ZH ? ZH.toCN(q) : q;
    return [simplified, q].filter((t, i, arr) => t && arr.indexOf(t) === i);
}

// 片名對照查到的補充關鍵字（會排除已經在 quick 裡的）。同一個查詢只會真的查一次。
const extraTermsCache = new Map();

function resolveExtraTerms(query) {
    const key = (query || '').trim();
    if (!key) return Promise.resolve([]);
    if (!extraTermsCache.has(key)) {
        const resolver = window.TitleResolver;
        const quickKeys = new Set(buildQuickQueries(key).map(normalizeSearchTerm));
        const promise = (resolver ? resolver.resolve(key) : Promise.resolve(null))
            .then((r) => {
                if (!r) return [];
                return uniqueTerms([...r.cn, ...r.latin.slice(0, 1)])
                    .filter((t) => !quickKeys.has(normalizeSearchTerm(t)));
            })
            .catch(() => []);
        if (extraTermsCache.size >= 50) extraTermsCache.clear();
        extraTermsCache.set(key, promise);
    }
    return extraTermsCache.get(key);
}

// 這次搜尋實際使用的所有關鍵字（用來排序時判斷相關度）
async function getSearchTerms(query) {
    const quick = buildQuickQueries(query);
    const extra = await resolveExtraTerms(query);
    return uniqueTerms([...quick, ...extra]);
}

// 相關度：片名與搜尋關鍵字完全相同 3 分，以關鍵字開頭 2 分，包含 1 分，其餘 0 分
function scoreSearchResult(item, terms) {
    if (!window.ZH || !terms || terms.length === 0) return 0;
    const name = ZH.normalizeTitle(item && item.vod_name);
    if (!name) return 0;
    let best = 0;
    for (const t of terms) {
        const nt = typeof t === 'string' ? ZH.normalizeTitle(t) : '';
        if (!nt) continue;
        if (name === nt) return 3;
        if (name.startsWith(nt)) best = Math.max(best, 2);
        else if (name.includes(nt)) best = Math.max(best, 1);
    }
    return best;
}

function mergeSearchResults(lists) {
    const seen = new Set();
    const out = [];
    for (const item of lists.flat()) {
        if (!item) continue;
        const id = item.vod_id !== undefined && item.vod_id !== null ? item.vod_id : item.vod_name;
        const key = `${item.source_code}|${item.api_url || ''}|${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}

function localizeSearchResult(item) {
    return window.ZH ? ZH.localizeFields(item, SEARCH_RESULT_TEXT_FIELDS) : item;
}

// 透過代理請求搜尋介面，回傳解析後的 JSON；失敗回傳 null
async function fetchSearchJson(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // 新增鑑權參數到代理 URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ?
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(url)) :
            PROXY_URL + encodeURIComponent(url);

        const response = await fetch(proxiedUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });
        if (!response.ok) return null;
        return await response.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

// 向單一來源搜尋單一關鍵字，抓取多頁結果
async function fetchSearchPages(apiId, term, { maxPages = API_CONFIG.search.maxPages } = {}) {
    try {
        let apiBaseUrl, apiName, customApiUrl;

        // 處理自訂 API
        if (apiId.startsWith('custom_')) {
            const customIndex = apiId.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) return [];

            apiBaseUrl = customApi.url;
            apiName = customApi.name;
            customApiUrl = customApi.url;
        } else {
            // 內建 API
            if (!API_SITES[apiId]) return [];
            apiBaseUrl = API_SITES[apiId].api;
            apiName = API_SITES[apiId].name;
        }

        const decorate = (item) => ({
            ...item,
            source_name: apiName,
            source_code: apiId,
            api_url: customApiUrl
        });

        const firstUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(term);
        const data = await fetchSearchJson(firstUrl);

        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
            return [];
        }

        // 處理第一頁結果
        const results = data.list.map(decorate);

        // 取得總頁數，確定需要取得的額外頁數 (最多取得 maxPages 頁)
        const pageCount = data.pagecount || 1;
        const pagesToFetch = Math.min(pageCount - 1, maxPages - 1);

        // 如果有額外頁數，取得更多頁的結果
        if (pagesToFetch > 0) {
            const additionalPagePromises = [];

            for (let page = 2; page <= pagesToFetch + 1; page++) {
                // 建構分頁 URL
                const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(term))
                    .replace('{page}', page);

                // 建立取得額外頁的 Promise
                additionalPagePromises.push((async () => {
                    try {
                        const pageData = await fetchSearchJson(pageUrl);
                        if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];
                        return pageData.list.map(decorate);
                    } catch (error) {
                        console.warn(`API ${apiId} 第${page}頁搜尋失敗:`, error);
                        return [];
                    }
                })());
            }

            // 等待所有額外頁的結果並合併
            const additionalResults = await Promise.all(additionalPagePromises);
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) {
                    results.push(...pageResults);
                }
            });
        }

        return results;
    } catch (error) {
        console.warn(`API ${apiId} 搜尋失敗:`, error);
        return [];
    }
}

// 向單一來源搜尋。會自動處理繁簡轉換與片名對照，結果的顯示文字為繁體。
async function searchByAPIAndKeyWord(apiId, query) {
    try {
        const quick = buildQuickQueries(query);
        if (quick.length === 0) return [];

        // 立刻搜尋：第一個（簡體）關鍵字取得完整頁數，其餘只取前幾頁
        const quickRuns = quick.map((term, i) => fetchSearchPages(apiId, term, {
            maxPages: i === 0 ? API_CONFIG.search.maxPages : EXTRA_QUERY_MAX_PAGES
        }));

        // 同時等待片名對照的結果（與上面的搜尋並行，不會額外拖慢），再補搜對照到的片名
        const extraRun = resolveExtraTerms(query).then((terms) => Promise.all(
            terms.map((term) => fetchSearchPages(apiId, term, { maxPages: EXTRA_QUERY_MAX_PAGES }))
        ));

        const [quickResults, extraResults] = await Promise.all([Promise.all(quickRuns), extraRun]);
        return mergeSearchResults([...quickResults, ...extraResults]).map(localizeSearchResult);
    } catch (error) {
        console.warn(`API ${apiId} 搜尋失敗:`, error);
        return [];
    }
}
