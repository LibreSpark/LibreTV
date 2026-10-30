// 詳情資料中要轉成繁體顯示的欄位（來源回傳的是簡體）
const VIDEO_INFO_TEXT_FIELDS = ['title', 'type', 'area', 'director', 'actor', 'remarks'];

function localizeVideoInfo(info) {
    if (!window.ZH || !info) return info;
    const out = ZH.localizeFields(info, VIDEO_INFO_TEXT_FIELDS);
    // 劇情簡介是一般文字，連同台灣慣用詞彙一起轉換
    if (typeof out.desc === 'string') out.desc = ZH.toTWP(out.desc);
    return out;
}

// 改善的 API 請求處理函式
async function handleApiRequest(url) {
    const customApi = url.searchParams.get('customApi') || '';
    const customDetail = url.searchParams.get('customDetail') || '';
    const source = url.searchParams.get('source') || 'heimuer';
    
    try {
        if (url.pathname === '/api/search') {
            const searchQuery = url.searchParams.get('wd');
            if (!searchQuery) {
                throw new Error('缺少搜尋參數');
            }
            
            // 驗證 API 與 source 的有效性
            if (source === 'custom' && !customApi) {
                throw new Error('使用自訂 API 時必須提供 API 位址');
            }
            
            if (!API_SITES[source] && source !== 'custom') {
                throw new Error('無效的 API 來源');
            }
            
            const apiUrl = customApi
                ? `${customApi}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`
                : `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            // 新增逾時處理
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            try {
                // 新增鑑權參數到代理 URL
                const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                    await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
                    PROXY_URL + encodeURIComponent(apiUrl);
                    
                const response = await fetch(proxiedUrl, {
                    headers: API_CONFIG.search.headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`API 請求失敗: ${response.status}`);
                }
                
                const data = await response.json();
                
                // 檢查 JSON 格式的有效性
                if (!data || !Array.isArray(data.list)) {
                    throw new Error('API 回傳的資料格式無效');
                }
                
                // 新增來源資訊到每個結果
                data.list.forEach(item => {
                    item.source_name = source === 'custom' ? '自訂來源' : API_SITES[source].name;
                    item.source_code = source;
                    // 對於自訂來源，新增 API URL 資訊
                    if (source === 'custom') {
                        item.api_url = customApi;
                    }
                });
                
                return JSON.stringify({
                    code: 200,
                    list: data.list || [],
                });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }

        // 詳情處理
        if (url.pathname === '/api/detail') {
            const id = url.searchParams.get('id');
            const sourceCode = url.searchParams.get('source') || 'heimuer'; // 取得原始碼
            
            if (!id) {
                throw new Error('缺少影片 ID 參數');
            }
            
            // 驗證 ID 格式 - 僅允許數字和有限的特殊字元
            if (!/^[\w-]+$/.test(id)) {
                throw new Error('無效的影片 ID 格式');
            }

            // 驗證 API 與 source 的有效性
            if (sourceCode === 'custom' && !customApi) {
                throw new Error('使用自訂 API 時必須提供 API 位址');
            }
            
            if (!API_SITES[sourceCode] && sourceCode !== 'custom') {
                throw new Error('無效的 API 來源');
            }

            // 對於有 detail 參數的來源，皆使用特殊處理方式
            if (sourceCode !== 'custom' && API_SITES[sourceCode].detail) {
                return await handleSpecialSourceDetail(id, sourceCode);
            }
            
            // 如果是自訂 API，並且傳遞了 detail 參數，嘗試特殊處理
            // 優先 customDetail
            if (sourceCode === 'custom' && customDetail) {
                return await handleCustomApiSpecialDetail(id, customDetail);
            }
            if (sourceCode === 'custom' && url.searchParams.get('useDetail') === 'true') {
                return await handleCustomApiSpecialDetail(id, customApi);
            }
            
            const detailUrl = customApi
                ? `${customApi}${API_CONFIG.detail.path}${id}`
                : `${API_SITES[sourceCode].api}${API_CONFIG.detail.path}${id}`;
            
            // 新增逾時處理
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            
            try {
                // 新增鑑權參數到代理 URL
                const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                    await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
                    PROXY_URL + encodeURIComponent(detailUrl);
                    
                const response = await fetch(proxiedUrl, {
                    headers: API_CONFIG.detail.headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`詳情請求失敗: ${response.status}`);
                }
                
                // 解析 JSON
                const data = await response.json();
                
                // 檢查回傳的資料是否有效
                if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
                    throw new Error('取得的詳情內容無效');
                }
                
                // 取得第一個符合的影片詳情
                const videoDetail = data.list[0];
                
                // 擷取播放位址
                let episodes = [];
                
                if (videoDetail.vod_play_url) {
                    // 分割不同播放來源
                    const playSources = videoDetail.vod_play_url.split('$$$');
                    
                    // 擷取第一個播放來源的集數（通常為主要來源）
                    if (playSources.length > 0) {
                        const mainSource = playSources[0];
                        const episodeList = mainSource.split('#');
                        
                        // 從每個集數中擷取 URL
                        episodes = episodeList.map(ep => {
                            const parts = ep.split('$');
                            // 回傳 URL 部分（通常是第二部分，如果有的話）
                            return parts.length > 1 ? parts[1] : '';
                        }).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
                    }
                }
                
                // 如果沒有找到播放位址，嘗試使用規則運算式尋找 m3u8 連結
                if (episodes.length === 0 && videoDetail.vod_content) {
                    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
                    episodes = matches.map(link => link.replace(/^\$/, ''));
                }
                
                return JSON.stringify({
                    code: 200,
                    episodes: episodes,
                    detailUrl: detailUrl,
                    videoInfo: localizeVideoInfo({
                        title: videoDetail.vod_name,
                        cover: videoDetail.vod_pic,
                        desc: videoDetail.vod_content,
                        type: videoDetail.type_name,
                        year: videoDetail.vod_year,
                        area: videoDetail.vod_area,
                        director: videoDetail.vod_director,
                        actor: videoDetail.vod_actor,
                        remarks: videoDetail.vod_remarks,
                        // 新增來源資訊
                        source_name: sourceCode === 'custom' ? '自訂來源' : API_SITES[sourceCode].name,
                        source_code: sourceCode
                    })
                });
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }
        }

        throw new Error('未知的 API 路徑');
    } catch (error) {
        console.error('API 處理錯誤:', error);
        return JSON.stringify({
            code: 400,
            msg: error.message || '請求處理失敗',
            list: [],
            episodes: [],
        });
    }
}

// 處理自訂 API 的特殊詳情頁
async function handleCustomApiSpecialDetail(id, customApi) {
    try {
        // 建立詳情頁 URL
        const detailUrl = `${customApi}/index.php/vod/detail/id/${id}.html`;
        
        // 新增逾時處理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        // 新增鑑權參數到代理 URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
            PROXY_URL + encodeURIComponent(detailUrl);
            
        // 取得詳情頁 HTML
        const response = await fetch(proxiedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`自訂 API 詳情頁請求失敗: ${response.status}`);
        }
        
        // 取得 HTML 內容
        const html = await response.text();
        
        // 使用通用模式擷取 m3u8 連結
        const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
        let matches = html.match(generalPattern) || [];
        
        // 處理連結
        matches = matches.map(link => {
            link = link.substring(1, link.length);
            const parenIndex = link.indexOf('(');
            return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });
        
        // 擷取基本資訊
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleText = titleMatch ? titleMatch[1].trim() : '';
        
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
        const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            detailUrl: detailUrl,
            videoInfo: localizeVideoInfo({
                title: titleText,
                desc: descText,
                source_name: '自訂來源',
                source_code: 'custom'
            })
        });
    } catch (error) {
        console.error(`自訂 API 詳情取得失敗:`, error);
        throw error;
    }
}

// 通用特殊來源詳情處理函式
async function handleSpecialSourceDetail(id, sourceCode) {
    try {
        // 建立詳情頁 URL（使用設定中的 detail URL 而不是 api URL）
        const detailUrl = `${API_SITES[sourceCode].detail}/index.php/vod/detail/id/${id}.html`;
        
        // 新增逾時處理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        // 新增鑑權參數到代理 URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(detailUrl)) :
            PROXY_URL + encodeURIComponent(detailUrl);
            
        // 取得詳情頁 HTML
        const response = await fetch(proxiedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`詳情頁請求失敗: ${response.status}`);
        }
        
        // 取得 HTML 內容
        const html = await response.text();
        
        // 根據不同來源類型使用不同的規則運算式
        let matches = [];
        
        if (sourceCode === 'ffzy') {
            // 非凡影視使用特定的規則運算式
            const ffzyPattern = /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
            matches = html.match(ffzyPattern) || [];
        }
        
        // 如果沒有找到連結或者是其他來源類型，嘗試一個更通用的模式
        if (matches.length === 0) {
            const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
            matches = html.match(generalPattern) || [];
        }
        // 排除重複處理，避免一個播放來源多集顯示
        matches = [...new Set(matches)];
        // 處理連結
        matches = matches.map(link => {
            link = link.substring(1, link.length);
            const parenIndex = link.indexOf('(');
            return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });
        
        // 擷取可能存在的標題、簡介等基本資訊
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleText = titleMatch ? titleMatch[1].trim() : '';
        
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
        const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return JSON.stringify({
            code: 200,
            episodes: matches,
            detailUrl: detailUrl,
            videoInfo: localizeVideoInfo({
                title: titleText,
                desc: descText,
                source_name: API_SITES[sourceCode].name,
                source_code: sourceCode
            })
        });
    } catch (error) {
        console.error(`${API_SITES[sourceCode].name}詳情取得失敗:`, error);
        throw error;
    }
}

// 處理聚合搜尋
async function handleAggregatedSearch(searchQuery) {
    // 取得可用的 API 來源列表（排除 aggregated 和 custom）
    const availableSources = Object.keys(API_SITES).filter(key => 
        key !== 'aggregated' && key !== 'custom'
    );
    
    if (availableSources.length === 0) {
        throw new Error('沒有可用的 API 來源');
    }
    
    // 建立所有 API 來源的搜尋請求
    const searchPromises = availableSources.map(async (source) => {
        try {
            const apiUrl = `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            // 使用 Promise.race 新增逾時處理
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`${source}來源搜尋逾時`)), 8000)
            );
            
            // 新增鑑權參數到代理 URL
            const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
                PROXY_URL + encodeURIComponent(apiUrl);
            
            const fetchPromise = fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers
            });
            
            const response = await Promise.race([fetchPromise, timeoutPromise]);
            
            if (!response.ok) {
                throw new Error(`${source}來源請求失敗: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data || !Array.isArray(data.list)) {
                throw new Error(`${source}來源回傳的資料格式無效`);
            }
            
            // 為搜尋結果新增來源資訊
            const results = data.list.map(item => ({
                ...item,
                source_name: API_SITES[source].name,
                source_code: source
            }));
            
            return results;
        } catch (error) {
            console.warn(`${source}來源搜尋失敗:`, error);
            return []; // 回傳空陣列表示該來源搜尋失敗
        }
    });
    
    try {
        // 並行執行所有搜尋請求
        const resultsArray = await Promise.all(searchPromises);
        
        // 合併所有結果
        let allResults = [];
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });
        
        // 如果沒有搜尋結果，回傳空結果
        if (allResults.length === 0) {
            return JSON.stringify({
                code: 200,
                list: [],
                msg: '所有來源均無搜尋結果'
            });
        }
        
        // 排除重複（根據 vod_id 和 source_code 組合）
        const uniqueResults = [];
        const seen = new Set();
        
        allResults.forEach(item => {
            const key = `${item.source_code}_${item.vod_id}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(item);
            }
        });
        
        // 按照影片名稱和來源排序
        uniqueResults.sort((a, b) => {
            // 首先按照影片名稱排序
            const nameCompare = (a.vod_name || '').localeCompare(b.vod_name || '');
            if (nameCompare !== 0) return nameCompare;
            
            // 如果名稱相同，則按照來源排序
            return (a.source_name || '').localeCompare(b.source_name || '');
        });
        
        return JSON.stringify({
            code: 200,
            list: uniqueResults,
        });
    } catch (error) {
        console.error('聚合搜尋處理錯誤:', error);
        return JSON.stringify({
            code: 400,
            msg: '聚合搜尋處理失敗: ' + error.message,
            list: []
        });
    }
}

// 處理多個自訂 API 來源的聚合搜尋
async function handleMultipleCustomSearch(searchQuery, customApiUrls) {
    // 解析自訂 API 列表
    const apiUrls = customApiUrls.split(CUSTOM_API_CONFIG.separator)
        .map(url => url.trim())
        .filter(url => url.length > 0 && /^https?:\/\//.test(url))
        .slice(0, CUSTOM_API_CONFIG.maxSources);
    
    if (apiUrls.length === 0) {
        throw new Error('沒有提供有效的自訂 API 位址');
    }
    
    // 為每個 API 建立搜尋請求
    const searchPromises = apiUrls.map(async (apiUrl, index) => {
        try {
            const fullUrl = `${apiUrl}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            
            // 使用 Promise.race 新增逾時處理
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error(`自訂 API ${index+1} 搜尋逾時`)), 8000)
            );
            
            // 新增鑑權參數到代理 URL
            const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(fullUrl)) :
                PROXY_URL + encodeURIComponent(fullUrl);
            
            const fetchPromise = fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers
            });
            
            const response = await Promise.race([fetchPromise, timeoutPromise]);
            
            if (!response.ok) {
                throw new Error(`自訂 API ${index+1} 請求失敗: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data || !Array.isArray(data.list)) {
                throw new Error(`自訂 API ${index+1} 回傳的資料格式無效`);
            }
            
            // 為搜尋結果新增來源資訊
            const results = data.list.map(item => ({
                ...item,
                source_name: `${CUSTOM_API_CONFIG.namePrefix}${index+1}`,
                source_code: 'custom',
                api_url: apiUrl // 儲存 API URL 以便取得詳情
            }));
            
            return results;
        } catch (error) {
            console.warn(`自訂 API ${index+1} 搜尋失敗:`, error);
            return []; // 回傳空陣列表示該來源搜尋失敗
        }
    });
    
    try {
        // 並行執行所有搜尋請求
        const resultsArray = await Promise.all(searchPromises);
        
        // 合併所有結果
        let allResults = [];
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });
        
        // 如果沒有搜尋結果，回傳空結果
        if (allResults.length === 0) {
            return JSON.stringify({
                code: 200,
                list: [],
                msg: '所有自訂 API 來源均無搜尋結果'
            });
        }
        
        // 排除重複（根據 vod_id 和 api_url 組合）
        const uniqueResults = [];
        const seen = new Set();
        
        allResults.forEach(item => {
            const key = `${item.api_url || ''}_${item.vod_id}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueResults.push(item);
            }
        });
        
        return JSON.stringify({
            code: 200,
            list: uniqueResults,
        });
    } catch (error) {
        console.error('自訂 API 聚合搜尋處理錯誤:', error);
        return JSON.stringify({
            code: 400,
            msg: '自訂 API 聚合搜尋處理失敗: ' + error.message,
            list: []
        });
    }
}

// 攔截 API 請求
(function() {
    const originalFetch = window.fetch;
    
    window.fetch = async function(input, init) {
        const requestUrl = typeof input === 'string' ? new URL(input, window.location.origin) : input.url;
        
        if (requestUrl.pathname.startsWith('/api/')) {
            if (window.isPasswordProtected && window.isPasswordVerified) {
                if (window.isPasswordProtected() && !window.isPasswordVerified()) {
                    return;
                }
            }
            try {
                const data = await handleApiRequest(requestUrl);
                return new Response(data, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            } catch (error) {
                return new Response(JSON.stringify({
                    code: 500,
                    msg: '伺服器內部錯誤',
                }), {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                });
            }
        }
        
        // 非 API 請求使用原始 fetch
        return originalFetch.apply(this, arguments);
    };
})();

async function testSiteAvailability(apiUrl) {
    try {
        // 使用更簡單的測試查詢
        const response = await fetch('/api/search?wd=test&customApi=' + encodeURIComponent(apiUrl), {
            // 新增逾時
            signal: AbortSignal.timeout(5000)
        });
        
        // 檢查回應狀態
        if (!response.ok) {
            return false;
        }
        
        const data = await response.json();
        
        // 檢查 API 回應的有效性
        return data && data.code !== 400 && Array.isArray(data.list);
    } catch (error) {
        console.error('網站可用性測試失敗:', error);
        return false;
    }
}