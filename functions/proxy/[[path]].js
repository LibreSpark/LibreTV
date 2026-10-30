// functions/proxy/[[path]].js

// --- 配置 (現在從 Cloudflare 環境變數讀取) ---
// 在 Cloudflare Pages 設定 -> 函式 -> 環境變數繫結 中設定以下變數:
// CACHE_TTL (例如 86400)
// MAX_RECURSION (例如 5)
// FILTER_DISCONTINUITY (不再需要，設為 false 或移除)
// USER_AGENTS_JSON (例如 ["UA1", "UA2"]) - JSON 字串陣列
// DEBUG (例如 false 或 true)
// PASSWORD (例如 "your_password") - 鑑權密碼
// --- 配置結束 ---

// --- 常量 (之前在 config.js 中，現在移到這裡，因為它們與代理邏輯相關) ---
const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];
// --- 常量結束 ---


/**
 * 主要的 Pages Function 處理函式
 * 攔截髮往 /proxy/* 的請求
 */
export async function onRequest(context) {
    const { request, env, next, waitUntil } = context; // next 和 waitUntil 可能需要
    const url = new URL(request.url);

    // 驗證鑑權（主函式呼叫）
    const isValidAuth = await validateAuth(request, env);
    if (!isValidAuth) {
        return new Response(JSON.stringify({
            success: false,
            error: '代理訪問未授權：請檢查密碼配置或鑑權參數'
        }), { 
            status: 401,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Content-Type': 'application/json'
            }
        });
    }

    // --- 從環境變數讀取配置 ---
    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400'); // 預設 24 小時
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5'); // 預設 5 層
    // 廣告過濾已移至播放器處理，代理不再執行
    let USER_AGENTS = [ // 提供一個基礎的預設值
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    try {
        // 嘗試從環境變數解析 USER_AGENTS_JSON
        const agentsJson = env.USER_AGENTS_JSON;
        if (agentsJson) {
            const parsedAgents = JSON.parse(agentsJson);
            if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
                USER_AGENTS = parsedAgents;
            } else {
                 logDebug("環境變數 USER_AGENTS_JSON 格式無效或為空，使用預設值");
            }
        }
    } catch (e) {
        logDebug(`解析環境變數 USER_AGENTS_JSON 失敗: ${e.message}，使用預設值`);
    }
    // --- 配置讀取結束 ---


    // --- 輔助函式 ---

    // 驗證代理請求的鑑權
    async function validateAuth(request, env) {
        const url = new URL(request.url);
        const authHash = url.searchParams.get('auth');
        const timestamp = url.searchParams.get('t');
        
        // 獲取伺服器端密碼
        const serverPassword = env.PASSWORD;
        if (!serverPassword) {
            console.error('伺服器未設定 PASSWORD 環境變數，代理訪問被拒絕');
            return false;
        }
        
        // 使用 SHA-256 雜湊演算法（與其他平台保持一致）
        // 在 Cloudflare Workers 中使用 crypto.subtle
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(serverPassword);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const serverPasswordHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            
            if (!authHash || authHash !== serverPasswordHash) {
                console.warn('代理請求鑑權失敗：密碼雜湊不匹配');
                return false;
            }
        } catch (error) {
            console.error('計算密碼雜湊失敗:', error);
            return false;
        }
        
        // 驗證時間戳（10分鐘有效期）
        if (timestamp) {
            const now = Date.now();
            const maxAge = 10 * 60 * 1000; // 10分鐘
            if (now - parseInt(timestamp) > maxAge) {
                console.warn('代理請求鑑權失敗：時間戳過期');
                return false;
            }
        }
        
        return true;
    }

    // 驗證鑑權（主函式呼叫）
    if (!validateAuth(request, env)) {
        return new Response('Unauthorized', { 
            status: 401,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*'
            }
        });
    }

    // 輸出除錯日誌 (需要設定 DEBUG: true 環境變數)
    function logDebug(message) {
        if (DEBUG_ENABLED) {
            console.log(`[Proxy Func] ${message}`);
        }
    }

    // 從請求路徑中提取目標 URL
    function getTargetUrlFromPath(pathname) {
        // 路徑格式: /proxy/經過編碼的URL
        // 例如: /proxy/https%3A%2F%2Fexample.com%2Fplaylist.m3u8
        const encodedUrl = pathname.replace(/^\/proxy\//, '');
        if (!encodedUrl) return null;
        try {
            // 解碼
            let decodedUrl = decodeURIComponent(encodedUrl);

             // 簡單檢查解碼後是否是有效的 http/https URL
             if (!decodedUrl.match(/^https?:\/\//i)) {
                 // 也許原始路徑就沒有編碼？如果看起來像URL就直接用
                 if (encodedUrl.match(/^https?:\/\//i)) {
                     decodedUrl = encodedUrl;
                     logDebug(`Warning: Path was not encoded but looks like URL: ${decodedUrl}`);
                 } else {
                    logDebug(`無效的目標URL格式 (解碼後): ${decodedUrl}`);
                    return null;
                 }
             }
             return decodedUrl;

        } catch (e) {
            logDebug(`解碼目標URL時出錯: ${encodedUrl} - ${e.message}`);
            return null;
        }
    }

    // 建立標準化的響應
    function createResponse(body, status = 200, headers = {}) {
        const responseHeaders = new Headers(headers);
        // 關鍵：新增 CORS 跨域頭，允許前端 JS 訪問代理後的響應
        responseHeaders.set("Access-Control-Allow-Origin", "*"); // 允許任何來源訪問
        responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS"); // 允許的方法
        responseHeaders.set("Access-Control-Allow-Headers", "*"); // 允許所有請求頭

        // 處理 CORS 預檢請求 (OPTIONS) - 放在這裡確保所有響應都處理
         if (request.method === "OPTIONS") {
             // 使用下面的 onOptions 函式可以更規範，但在這裡處理也可以
             return new Response(null, {
                 status: 204, // No Content
                 headers: responseHeaders // 包含上面設定的 CORS 頭
             });
         }

        return new Response(body, { status, headers: responseHeaders });
    }

    // 建立 M3U8 類型的響應
    function createM3u8Response(content) {
        return createResponse(content, 200, {
            "Content-Type": "application/vnd.apple.mpegurl", // M3U8 的標準 MIME 類型
            "Cache-Control": `public, max-age=${CACHE_TTL}` // 允許瀏覽器和CDN快取
        });
    }

    // 獲取隨機 User-Agent
    function getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    // 獲取 URL 的基礎路徑 (用於解析相對路徑)
    function getBaseUrl(urlStr) {
        try {
            const parsedUrl = new URL(urlStr);
            // 如果路徑是根目錄，或者沒有斜槓，直接返回 origin + /
            if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
                return `${parsedUrl.origin}/`;
            }
            const pathParts = parsedUrl.pathname.split('/');
            pathParts.pop(); // 移除檔名或最後一個路徑段
            return `${parsedUrl.origin}${pathParts.join('/')}/`;
        } catch (e) {
            logDebug(`獲取 BaseUrl 時出錯: ${urlStr} - ${e.message}`);
            // 備用方法：找到最後一個斜槓
            const lastSlashIndex = urlStr.lastIndexOf('/');
            // 確保不是協議部分的斜槓 (http://)
            return lastSlashIndex > urlStr.indexOf('://') + 2 ? urlStr.substring(0, lastSlashIndex + 1) : urlStr + '/';
        }
    }


    // 將相對 URL 轉換為絕對 URL
    function resolveUrl(baseUrl, relativeUrl) {
        // 如果已經是絕對 URL，直接返回
        if (relativeUrl.match(/^https?:\/\//i)) {
            return relativeUrl;
        }
        try {
            // 使用 URL 物件來處理相對路徑
            return new URL(relativeUrl, baseUrl).toString();
        } catch (e) {
            logDebug(`解析 URL 失敗: baseUrl=${baseUrl}, relativeUrl=${relativeUrl}, error=${e.message}`);
            // 簡單的備用方法
            if (relativeUrl.startsWith('/')) {
                // 處理根路徑相對 URL
                const urlObj = new URL(baseUrl);
                return `${urlObj.origin}${relativeUrl}`;
            }
            // 處理同級目錄相對 URL
            return `${baseUrl.replace(/\/[^/]*$/, '/')}${relativeUrl}`; // 確保baseUrl以 / 結尾
        }
    }

    // 將目標 URL 重寫為內部代理路徑 (/proxy/...)
    function rewriteUrlToProxy(targetUrl) {
        // 確保目標URL被正確編碼，以便作為路徑的一部分
        return `/proxy/${encodeURIComponent(targetUrl)}`;
    }

    // 獲取遠端內容及其類型
    async function fetchContentWithType(targetUrl) {
        const headers = new Headers({
            'User-Agent': getRandomUserAgent(),
            'Accept': '*/*',
            // 嘗試傳遞一些原始請求的頭資訊
            'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
            // 嘗試設定 Referer 為目標網站的域名，或者傳遞原始 Referer
            'Referer': request.headers.get('Referer') || new URL(targetUrl).origin
        });

        try {
            // 直接請求目標 URL
            logDebug(`開始直接請求: ${targetUrl}`);
            // Cloudflare Functions 的 fetch 預設支援重定向
            const response = await fetch(targetUrl, { headers, redirect: 'follow' });

            if (!response.ok) {
                 const errorBody = await response.text().catch(() => '');
                 logDebug(`請求失敗: ${response.status} ${response.statusText} - ${targetUrl}`);
                 throw new Error(`HTTP error ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 150)}`);
            }

            // 讀取響應內容為文字
            const content = await response.text();
            const contentType = response.headers.get('Content-Type') || '';
            logDebug(`請求成功: ${targetUrl}, Content-Type: ${contentType}, 內容長度: ${content.length}`);
            return { content, contentType, responseHeaders: response.headers }; // 同時返回原始響應頭

        } catch (error) {
             logDebug(`請求徹底失敗: ${targetUrl}: ${error.message}`);
            // 丟擲更詳細的錯誤
            throw new Error(`請求目標URL失敗 ${targetUrl}: ${error.message}`);
        }
    }

    // 判斷是否是 M3U8 內容
    function isM3u8Content(content, contentType) {
        // 檢查 Content-Type
        if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
            return true;
        }
        // 檢查內容本身是否以 #EXTM3U 開頭
        return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
    }

    // 判斷是否是媒體檔案 (根據副檔名和 Content-Type) - 這部分在此代理中似乎未使用，但保留
    function isMediaFile(url, contentType) {
        if (contentType) {
            for (const mediaType of MEDIA_CONTENT_TYPES) {
                if (contentType.toLowerCase().startsWith(mediaType)) {
                    return true;
                }
            }
        }
        const urlLower = url.toLowerCase();
        for (const ext of MEDIA_FILE_EXTENSIONS) {
            if (urlLower.endsWith(ext) || urlLower.includes(`${ext}?`)) {
                return true;
            }
        }
        return false;
    }

    // 處理 M3U8 中的 #EXT-X-KEY 行 (加密金鑰)
    function processKeyLine(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const absoluteUri = resolveUrl(baseUrl, uri);
            logDebug(`處理 KEY URI: 原始='${uri}', 絕對='${absoluteUri}'`);
            return `URI="${rewriteUrlToProxy(absoluteUri)}"`; // 重寫為代理路徑
        });
    }

    // 處理 M3U8 中的 #EXT-X-MAP 行 (初始化片段)
    function processMapLine(line, baseUrl) {
         return line.replace(/URI="([^"]+)"/, (match, uri) => {
             const absoluteUri = resolveUrl(baseUrl, uri);
             logDebug(`處理 MAP URI: 原始='${uri}', 絕對='${absoluteUri}'`);
             return `URI="${rewriteUrlToProxy(absoluteUri)}"`; // 重寫為代理路徑
         });
     }

    // 處理媒體 M3U8 播放列表 (包含影片/音訊片段)
    function processMediaPlaylist(url, content) {
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        const output = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // 保留最後的空行
            if (!line && i === lines.length - 1) {
                output.push(line);
                continue;
            }
            if (!line) continue; // 跳過中間的空行

            if (line.startsWith('#EXT-X-KEY')) {
                output.push(processKeyLine(line, baseUrl));
                continue;
            }
            if (line.startsWith('#EXT-X-MAP')) {
                output.push(processMapLine(line, baseUrl));
                 continue;
            }
             if (line.startsWith('#EXTINF')) {
                 output.push(line);
                 continue;
             }
             if (!line.startsWith('#')) {
                 const absoluteUrl = resolveUrl(baseUrl, line);
                 logDebug(`重寫媒體片段: 原始='${line}', 絕對='${absoluteUrl}'`);
                 output.push(rewriteUrlToProxy(absoluteUrl));
                 continue;
             }
             // 其他 M3U8 標籤直接新增
             output.push(line);
        }
        return output.join('\n');
    }

    // 遞迴處理 M3U8 內容
     async function processM3u8Content(targetUrl, content, recursionDepth = 0, env) {
         if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
             logDebug(`檢測到主播放列表: ${targetUrl}`);
             return await processMasterPlaylist(targetUrl, content, recursionDepth, env);
         }
         logDebug(`檢測到媒體播放列表: ${targetUrl}`);
         return processMediaPlaylist(targetUrl, content);
     }

    // 處理主 M3U8 播放列表
    async function processMasterPlaylist(url, content, recursionDepth, env) {
        if (recursionDepth > MAX_RECURSION) {
            throw new Error(`處理主列表時遞迴層數過多 (${MAX_RECURSION}): ${url}`);
        }

        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        let highestBandwidth = -1;
        let bestVariantUrl = '';

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;

                 let variantUriLine = '';
                 for (let j = i + 1; j < lines.length; j++) {
                     const line = lines[j].trim();
                     if (line && !line.startsWith('#')) {
                         variantUriLine = line;
                         i = j;
                         break;
                     }
                 }

                 if (variantUriLine && currentBandwidth >= highestBandwidth) {
                     highestBandwidth = currentBandwidth;
                     bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
                 }
            }
        }

         if (!bestVariantUrl) {
             logDebug(`主列表中未找到 BANDWIDTH 或 STREAM-INF，嘗試查詢第一個子列表引用: ${url}`);
             for (let i = 0; i < lines.length; i++) {
                 const line = lines[i].trim();
                 if (line && !line.startsWith('#') && (line.endsWith('.m3u8') || line.includes('.m3u8?'))) { // 修復：檢查是否包含 .m3u8?
                    bestVariantUrl = resolveUrl(baseUrl, line);
                     logDebug(`備選方案：找到第一個子列表引用: ${bestVariantUrl}`);
                     break;
                 }
             }
         }

        if (!bestVariantUrl) {
            logDebug(`在主列表 ${url} 中未找到任何有效的子播放列表 URL。可能格式有問題或僅包含音訊/字幕。將嘗試按媒體列表處理原始內容。`);
            return processMediaPlaylist(url, content);
        }

        // --- 獲取並處理選中的子 M3U8 ---

        const cacheKey = `m3u8_processed:${bestVariantUrl}`; // 使用處理後的快取鍵

        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV; // 從環境獲取 KV 名稱空間 (變數名在 Cloudflare 設定)
            if (!kvNamespace) throw new Error("KV 名稱空間未繫結");
        } catch (e) {
            logDebug(`KV 名稱空間 'LIBRETV_PROXY_KV' 訪問出錯或未繫結: ${e.message}`);
            kvNamespace = null; // 確保設為 null
        }

        if (kvNamespace) {
            try {
                const cachedContent = await kvNamespace.get(cacheKey);
                if (cachedContent) {
                    logDebug(`[快取命中] 主列表的子列表: ${bestVariantUrl}`);
                    return cachedContent;
                } else {
                    logDebug(`[快取未命中] 主列表的子列表: ${bestVariantUrl}`);
                }
            } catch (kvError) {
                logDebug(`從 KV 讀取快取失敗 (${cacheKey}): ${kvError.message}`);
                // 出錯則繼續執行，不影響功能
            }
        }

        logDebug(`選擇的子列表 (頻寬: ${highestBandwidth}): ${bestVariantUrl}`);
        const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl);

        if (!isM3u8Content(variantContent, variantContentType)) {
            logDebug(`獲取到的子列表 ${bestVariantUrl} 不是 M3U8 內容 (類型: ${variantContentType})。可能直接是媒體檔案，返回原始內容。`);
             // 如果不是M3U8，但看起來像媒體內容，直接返回代理後的內容
             // 注意：這裡可能需要決定是否直接代理這個非 M3U8 的 URL
             // 為了簡化，我們假設如果不是 M3U8，則流程中斷或按原樣處理
             // 或者，嘗試將其作為媒體列表處理？（當前行為）
             // return createResponse(variantContent, 200, { 'Content-Type': variantContentType || 'application/octet-stream' });
             // 嘗試按媒體列表處理，以防萬一
             return processMediaPlaylist(bestVariantUrl, variantContent);

        }

        const processedVariant = await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1, env);

        if (kvNamespace) {
             try {
                 // 使用 waitUntil 非同步寫入快取，不阻塞響應返回
                 // 注意 KV 的寫入限制 (免費版每天 1000 次)
                 waitUntil(kvNamespace.put(cacheKey, processedVariant, { expirationTtl: CACHE_TTL }));
                 logDebug(`已將處理後的子列表寫入快取: ${bestVariantUrl}`);
             } catch (kvError) {
                 logDebug(`向 KV 寫入快取失敗 (${cacheKey}): ${kvError.message}`);
                 // 寫入失敗不影響返回結果
             }
        }

        return processedVariant;
    }

    // --- 主要請求處理邏輯 ---

    try {
        const targetUrl = getTargetUrlFromPath(url.pathname);

        if (!targetUrl) {
            logDebug(`無效的代理請求路徑: ${url.pathname}`);
            return createResponse("無效的代理請求。路徑應為 /proxy/<經過編碼的URL>", 400);
        }

        logDebug(`收到代理請求: ${targetUrl}`);

        // --- 快取檢查 (KV) ---
        const cacheKey = `proxy_raw:${targetUrl}`; // 使用原始內容的快取鍵
        let kvNamespace = null;
        try {
            kvNamespace = env.LIBRETV_PROXY_KV;
            if (!kvNamespace) throw new Error("KV 名稱空間未繫結");
        } catch (e) {
            logDebug(`KV 名稱空間 'LIBRETV_PROXY_KV' 訪問出錯或未繫結: ${e.message}`);
            kvNamespace = null;
        }

        if (kvNamespace) {
            try {
                const cachedDataJson = await kvNamespace.get(cacheKey); // 直接獲取字串
                if (cachedDataJson) {
                    logDebug(`[快取命中] 原始內容: ${targetUrl}`);
                    const cachedData = JSON.parse(cachedDataJson); // 解析 JSON
                    const content = cachedData.body;
                    let headers = {};
                    try { headers = JSON.parse(cachedData.headers); } catch(e){} // 解析頭部
                    const contentType = headers['content-type'] || headers['Content-Type'] || '';

                    if (isM3u8Content(content, contentType)) {
                        logDebug(`快取內容是 M3U8，重新處理: ${targetUrl}`);
                        const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env);
                        return createM3u8Response(processedM3u8);
                    } else {
                        logDebug(`從快取返回非 M3U8 內容: ${targetUrl}`);
                        return createResponse(content, 200, new Headers(headers));
                    }
                } else {
                     logDebug(`[快取未命中] 原始內容: ${targetUrl}`);
                 }
            } catch (kvError) {
                 logDebug(`從 KV 讀取或解析快取失敗 (${cacheKey}): ${kvError.message}`);
                 // 出錯則繼續執行，不影響功能
            }
        }

        // --- 實際請求 ---
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl);

        // --- 寫入快取 (KV) ---
        if (kvNamespace) {
             try {
                 const headersToCache = {};
                 responseHeaders.forEach((value, key) => { headersToCache[key.toLowerCase()] = value; });
                 const cacheValue = { body: content, headers: JSON.stringify(headersToCache) };
                 // 注意 KV 寫入限制
                 waitUntil(kvNamespace.put(cacheKey, JSON.stringify(cacheValue), { expirationTtl: CACHE_TTL }));
                 logDebug(`已將原始內容寫入快取: ${targetUrl}`);
            } catch (kvError) {
                 logDebug(`向 KV 寫入快取失敗 (${cacheKey}): ${kvError.message}`);
                 // 寫入失敗不影響返回結果
            }
        }

        // --- 處理響應 ---
        if (isM3u8Content(content, contentType)) {
            logDebug(`內容是 M3U8，開始處理: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, content, 0, env);
            return createM3u8Response(processedM3u8);
        } else {
            logDebug(`內容不是 M3U8 (類型: ${contentType})，直接返回: ${targetUrl}`);
            const finalHeaders = new Headers(responseHeaders);
            finalHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            // 新增 CORS 頭，確保非 M3U8 內容也能跨域訪問（例如圖片、字幕檔案等）
            finalHeaders.set("Access-Control-Allow-Origin", "*");
            finalHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
            finalHeaders.set("Access-Control-Allow-Headers", "*");
            return createResponse(content, 200, finalHeaders);
        }

    } catch (error) {
        logDebug(`處理代理請求時發生嚴重錯誤: ${error.message} \n ${error.stack}`);
        return createResponse(`代理處理錯誤: ${error.message}`, 500);
    }
}

// 處理 OPTIONS 預檢請求的函式
export async function onOptions(context) {
    // 直接返回允許跨域的頭資訊
    return new Response(null, {
        status: 204, // No Content
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*", // 允許所有請求頭
            "Access-Control-Max-Age": "86400", // 預檢請求結果快取一天
        },
    });
}
