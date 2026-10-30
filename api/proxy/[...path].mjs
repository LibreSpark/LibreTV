// /api/proxy/[...path].mjs - Vercel Serverless Function (ES Module)

import fetch from 'node-fetch';
import { URL } from 'url'; // 使用 Node.js 內建 URL 處理
import crypto from 'crypto'; // 匯入 crypto 模組用於密碼雜湊

// --- 配置 (從環境變數讀取) ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10); // 預設 24 小時
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '5', 10); // 預設 5 層

// --- User Agent 處理 ---
// 預設 User Agent 列表
let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
// 嘗試從環境變數讀取並解析 USER_AGENTS_JSON
try {
    const agentsJsonString = process.env.USER_AGENTS_JSON;
    if (agentsJsonString) {
        const parsedAgents = JSON.parse(agentsJsonString);
        // 檢查解析結果是否為非空陣列
        if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
            USER_AGENTS = parsedAgents; // 使用環境變數中的陣列
            console.log(`[代理日誌] 已從環境變數載入 ${USER_AGENTS.length} 個 User Agent。`);
        } else {
            console.warn("[代理日誌] 環境變數 USER_AGENTS_JSON 不是有效的非空陣列，使用預設值。");
        }
    } else {
        console.log("[代理日誌] 未設定環境變數 USER_AGENTS_JSON，使用預設 User Agent。");
    }
} catch (e) {
    // 如果 JSON 解析失敗，記錄錯誤並使用預設值
    console.error(`[代理日誌] 解析環境變數 USER_AGENTS_JSON 出錯: ${e.message}。使用預設 User Agent。`);
}

// 廣告過濾在代理中禁用，由播放器處理
const FILTER_DISCONTINUITY = false;


// --- 輔助函式 ---

function logDebug(message) {
    if (DEBUG_ENABLED) {
        console.log(`[代理日誌] ${message}`);
    }
}

/**
 * 從代理請求路徑中提取編碼後的目標 URL。
 * @param {string} encodedPath - URL 編碼後的路徑部分 (例如 "https%3A%2F%2F...")
 * @returns {string|null} 解碼後的目標 URL，如果無效則返回 null。
 */
function getTargetUrlFromPath(encodedPath) {
    if (!encodedPath) {
        logDebug("getTargetUrlFromPath 收到空路徑。");
        return null;
    }
    try {
        const decodedUrl = decodeURIComponent(encodedPath);
        // 基礎檢查，看是否像一個 HTTP/HTTPS URL
        if (decodedUrl.match(/^https?:\/\/.+/i)) {
            return decodedUrl;
        } else {
            logDebug(`無效的解碼 URL 格式: ${decodedUrl}`);
            // 備選檢查：原始路徑是否未編碼但看起來像 URL？
            if (encodedPath.match(/^https?:\/\/.+/i)) {
                logDebug(`警告: 路徑未編碼但看起來像 URL: ${encodedPath}`);
                return encodedPath;
            }
            return null;
        }
    } catch (e) {
        // 捕獲解碼錯誤 (例如格式錯誤的 URI)
        logDebug(`解碼目標 URL 出錯: ${encodedPath} - ${e.message}`);
        return null;
    }
}

function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        // 處理根目錄或只有檔名的情況
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean); // 移除空字串
        if (pathSegments.length <= 1) {
            return `${parsedUrl.origin}/`;
        }
        pathSegments.pop(); // 移除最後一段
        return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) {
        logDebug(`獲取 BaseUrl 失敗: "${urlStr}": ${e.message}`);
        // 備用方法：查詢最後一個斜槓
        const lastSlashIndex = urlStr.lastIndexOf('/');
        if (lastSlashIndex > urlStr.indexOf('://') + 2) { // 確保不是協議部分的斜槓
            return urlStr.substring(0, lastSlashIndex + 1);
        }
        return urlStr + '/'; // 如果沒有路徑，新增斜槓
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return ''; // 處理空的 relativeUrl
    if (relativeUrl.match(/^https?:\/\/.+/i)) {
        return relativeUrl; // 已經是絕對 URL
    }
    if (!baseUrl) return relativeUrl; // 沒有基礎 URL 無法解析

    try {
        // 使用 Node.js 的 URL 建構函式處理相對路徑
        return new URL(relativeUrl, baseUrl).toString();
    } catch (e) {
        logDebug(`URL 解析失敗: base="${baseUrl}", relative="${relativeUrl}". 錯誤: ${e.message}`);
        // 簡單的備用邏輯
        if (relativeUrl.startsWith('/')) {
             try {
                const baseOrigin = new URL(baseUrl).origin;
                return `${baseOrigin}${relativeUrl}`;
             } catch { return relativeUrl; } // 如果 baseUrl 也無效，返回原始相對路徑
        } else {
            // 假設相對於包含基礎 URL 資源的目錄
            return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`;
        }
    }
}

// ** 已修正：確保生成 /proxy/ 前綴的連結 **
function rewriteUrlToProxy(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    // 返回與 vercel.json 的 "source" 和前端 PROXY_URL 一致的路徑
    return `/proxy/${encodeURIComponent(targetUrl)}`;
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchContentWithType(targetUrl, requestHeaders) {
    // 準備請求頭
    const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': requestHeaders['accept'] || '*/*', // 傳遞原始 Accept 頭（如果有）
        'Accept-Language': requestHeaders['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        // 嘗試設定一個合理的 Referer
        'Referer': requestHeaders['referer'] || new URL(targetUrl).origin,
    };
    // 清理空值的頭
    Object.keys(headers).forEach(key => headers[key] === undefined || headers[key] === null || headers[key] === '' ? delete headers[key] : {});

    logDebug(`準備請求目標: ${targetUrl}，請求頭: ${JSON.stringify(headers)}`);

    try {
        // 發起 fetch 請求
        const response = await fetch(targetUrl, { headers, redirect: 'follow' });

        // 檢查響應是否成功
        if (!response.ok) {
            const errorBody = await response.text().catch(() => ''); // 嘗試獲取錯誤響應體
            logDebug(`請求失敗: ${response.status} ${response.statusText} - ${targetUrl}`);
            // 建立一個包含狀態碼的錯誤物件
            const err = new Error(`HTTP 錯誤 ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
            err.status = response.status; // 將狀態碼附加到錯誤物件
            throw err; // 丟擲錯誤
        }

        // 讀取響應內容
        const content = await response.text();
        const contentType = response.headers.get('content-type') || '';
        logDebug(`請求成功: ${targetUrl}, Content-Type: ${contentType}, 內容長度: ${content.length}`);
        // 返回結果
        return { content, contentType, responseHeaders: response.headers };

    } catch (error) {
        // 捕獲 fetch 本身的錯誤（網路、超時等）或上面丟擲的 HTTP 錯誤
        logDebug(`請求異常 ${targetUrl}: ${error.message}`);
        // 重新丟擲，確保包含原始錯誤資訊
        throw new Error(`請求目標 URL 失敗 ${targetUrl}: ${error.message}`);
    }
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
        return true;
    }
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processKeyLine(line, baseUrl) {
    return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`處理 KEY URI: 原始='${uri}', 絕對='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
    });
}

function processMapLine(line, baseUrl) {
     return line.replace(/URI="([^"]+)"/, (match, uri) => {
        const absoluteUri = resolveUrl(baseUrl, uri);
        logDebug(`處理 MAP URI: 原始='${uri}', 絕對='${absoluteUri}'`);
        return `URI="${rewriteUrlToProxy(absoluteUri)}"`;
     });
 }

function processMediaPlaylist(url, content) {
    const baseUrl = getBaseUrl(url);
    if (!baseUrl) {
        logDebug(`無法確定媒體列表的 Base URL: ${url}，相對路徑可能無法處理。`);
    }
    const lines = content.split('\n');
    const output = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // 保留最後一個空行
        if (!line && i === lines.length - 1) { output.push(line); continue; }
        if (!line) continue; // 跳過中間空行
        // 廣告過濾已禁用
        if (line.startsWith('#EXT-X-KEY')) { output.push(processKeyLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXT-X-MAP')) { output.push(processMapLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXTINF')) { output.push(line); continue; }
        // 處理 URL 行
        if (!line.startsWith('#')) {
            const absoluteUrl = resolveUrl(baseUrl, line);
            logDebug(`重寫媒體片段: 原始='${line}', 解析後='${absoluteUrl}'`);
            output.push(rewriteUrlToProxy(absoluteUrl)); continue;
        }
        // 保留其他 M3U8 標籤
        output.push(line);
    }
    return output.join('\n');
}

async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
    // 判斷是主列表還是媒體列表
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
        logDebug(`檢測到主播放列表: ${targetUrl} (深度: ${recursionDepth})`);
        return await processMasterPlaylist(targetUrl, content, recursionDepth);
    }
    logDebug(`檢測到媒體播放列表: ${targetUrl} (深度: ${recursionDepth})`);
    return processMediaPlaylist(targetUrl, content);
}

async function processMasterPlaylist(url, content, recursionDepth) {
    // 檢查遞迴深度
    if (recursionDepth > MAX_RECURSION) {
        throw new Error(`處理主播放列表時，遞迴深度超過最大限制 (${MAX_RECURSION}): ${url}`);
    }
    const baseUrl = getBaseUrl(url);
    const lines = content.split('\n');
    let highestBandwidth = -1;
    let bestVariantUrl = '';

    // 查詢最高頻寬的流
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/);
            const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
            let variantUriLine = '';
            // 找到下一行的 URI
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j].trim();
                if (line && !line.startsWith('#')) { variantUriLine = line; i = j; break; }
            }
            if (variantUriLine && currentBandwidth >= highestBandwidth) {
                highestBandwidth = currentBandwidth;
                bestVariantUrl = resolveUrl(baseUrl, variantUriLine);
            }
        }
    }
    // 如果沒有找到頻寬資訊，嘗試查詢第一個 .m3u8 連結
    if (!bestVariantUrl) {
        logDebug(`主播放列表中未找到 BANDWIDTH 資訊，嘗試查詢第一個 URI: ${url}`);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
             // 更可靠地匹配 .m3u8 連結
            if (line && !line.startsWith('#') && line.match(/\.m3u8($|\?.*)/i)) {
                bestVariantUrl = resolveUrl(baseUrl, line);
                logDebug(`備選方案: 找到第一個子播放列表 URI: ${bestVariantUrl}`);
                break;
            }
        }
    }
    // 如果仍然沒有找到子列表 URL
    if (!bestVariantUrl) {
        logDebug(`在主播放列表 ${url} 中未找到有效的子列表 URI，將其作為媒體列表處理。`);
        return processMediaPlaylist(url, content);
    }

    logDebug(`選擇的子播放列表 (頻寬: ${highestBandwidth}): ${bestVariantUrl}`);
    // 請求選定的子播放列表內容 (注意：這裡傳遞 {} 作為請求頭，不傳遞客戶端的原始請求頭)
    const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, {});

    // 檢查獲取的內容是否是 M3U8
    if (!isM3u8Content(variantContent, variantContentType)) {
        logDebug(`獲取的子播放列表 ${bestVariantUrl} 不是 M3U8 (類型: ${variantContentType})，將其作為媒體列表處理。`);
        return processMediaPlaylist(bestVariantUrl, variantContent);
    }

    // 遞迴處理獲取到的子 M3U8 內容
    return await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);
}

/**
 * 驗證代理請求的鑑權
 */
async function validateAuth(req) {
    const authHash = req.query.auth;
    const timestamp = req.query.t;
    
    // 獲取伺服器端密碼雜湊
    const serverPassword = process.env.PASSWORD;
    if (!serverPassword) {
        console.error('伺服器未設定 PASSWORD 環境變數，代理訪問被拒絕');
        return false;
    }
    
    // 使用 crypto 模組計算 SHA-256 雜湊
    const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
    
    if (!authHash || authHash !== serverPasswordHash) {
        console.warn('代理請求鑑權失敗：密碼雜湊不匹配');
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

// --- Vercel Handler 函式 ---
export default async function handler(req, res) {
    // --- 記錄請求開始 ---
    console.info('--- Vercel 代理請求開始 ---');
    console.info('時間:', new Date().toISOString());
    console.info('方法:', req.method);
    console.info('URL:', req.url); // 原始請求 URL (例如 /proxy/...)
    console.info('查詢參數:', JSON.stringify(req.query)); // Vercel 解析的查詢參數

    // --- 提前設定 CORS 頭 ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*'); // 允許所有請求頭

    // --- 處理 OPTIONS 預檢請求 ---
    if (req.method === 'OPTIONS') {
        console.info("處理 OPTIONS 預檢請求");
        res.status(204).setHeader('Access-Control-Max-Age', '86400').end(); // 快取預檢結果 24 小時
        return;
    }

    let targetUrl = null; // 初始化目標 URL

    try { // ---- 開始主處理邏輯的 try 塊 ----

        // --- 驗證鑑權 ---
        const isAuthorized = await validateAuth(req);
        if (!isAuthorized) {
            console.warn('代理請求鑑權失敗');
            res.status(401).json({
                success: false,
                error: '代理訪問未授權：請檢查密碼配置或鑑權參數'
            });
            return;
        }

        // --- 提取目標 URL (主要依賴 req.query["...path"]) ---
        // Vercel 將 :path* 捕獲的內容（可能包含斜槓）放入 req.query["...path"] 陣列
        const pathData = req.query["...path"]; // 使用正確的鍵名
        let encodedUrlPath = '';

        if (pathData) {
            if (Array.isArray(pathData)) {
                encodedUrlPath = pathData.join('/'); // 重新組合
                console.info(`從 req.query["...path"] (陣列) 組合的編碼路徑: ${encodedUrlPath}`);
            } else if (typeof pathData === 'string') {
                encodedUrlPath = pathData; // 也處理 Vercel 可能只返回字串的情況
                console.info(`從 req.query["...path"] (字串) 獲取的編碼路徑: ${encodedUrlPath}`);
            } else {
                console.warn(`[代理警告] req.query["...path"] 類型未知: ${typeof pathData}`);
            }
        } else {
            console.warn(`[代理警告] req.query["...path"] 為空或未定義。`);
            // 備選：嘗試從 req.url 提取（如果需要）
            if (req.url && req.url.startsWith('/proxy/')) {
                encodedUrlPath = req.url.substring('/proxy/'.length);
                console.info(`使用備選方法從 req.url 提取的編碼路徑: ${encodedUrlPath}`);
            }
        }

        // 如果仍然為空，則無法繼續
        if (!encodedUrlPath) {
             throw new Error("無法從請求中確定編碼後的目標路徑。");
        }

        // 解析目標 URL
        targetUrl = getTargetUrlFromPath(encodedUrlPath);
        console.info(`解析出的目標 URL: ${targetUrl || 'null'}`); // 記錄解析結果

        // 檢查目標 URL 是否有效
        if (!targetUrl) {
            // 丟擲包含更多上下文的錯誤
            throw new Error(`無效的代理請求路徑。無法從組合路徑 "${encodedUrlPath}" 中提取有效的目標 URL。`);
        }

        console.info(`開始處理目標 URL 的代理請求: ${targetUrl}`);

        // --- 獲取並處理目標內容 ---
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, req.headers);

        // --- 如果是 M3U8，處理並返回 ---
        if (isM3u8Content(content, contentType)) {
            console.info(`正在處理 M3U8 內容: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, content);

            console.info(`成功處理 M3U8: ${targetUrl}`);
            // 傳送處理後的 M3U8 響應
            res.status(200)
                .setHeader('Content-Type', 'application/vnd.apple.mpegurl;charset=utf-8')
                .setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`)
                // 移除可能導致問題的原始響應頭
                .removeHeader('content-encoding') // 很重要！node-fetch 已解壓
                .removeHeader('content-length')   // 長度已改變
                .send(processedM3u8); // 傳送 M3U8 文字

        } else {
            // --- 如果不是 M3U8，直接返回原始內容 ---
            console.info(`直接返回非 M3U8 內容: ${targetUrl}, 類型: ${contentType}`);

            // 設定原始響應頭，但排除有問題的頭和 CORS 頭（已設定）
            responseHeaders.forEach((value, key) => {
                 const lowerKey = key.toLowerCase();
                 if (!lowerKey.startsWith('access-control-') &&
                     lowerKey !== 'content-encoding' && // 很重要！
                     lowerKey !== 'content-length') {   // 很重要！
                     res.setHeader(key, value); // 設定其他原始頭
                 }
             });
            // 設定我們自己的快取策略
            res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL}`);

            // 傳送原始（已解壓）內容
            res.status(200).send(content);
        }

    // ---- 結束主處理邏輯的 try 塊 ----
    } catch (error) { // ---- 捕獲處理過程中的任何錯誤 ----
        // **檢查這個錯誤是否是 "Assignment to constant variable"**
        console.error(`[代理錯誤處理 V3] 捕獲錯誤！目標: ${targetUrl || '解析失敗'} | 錯誤類型: ${error.constructor.name} | 錯誤訊息: ${error.message}`);
        console.error(`[代理錯誤堆疊 V3] ${error.stack}`); // 記錄完整的錯誤堆疊資訊

        // 特別標記 "Assignment to constant variable" 錯誤
        if (error instanceof TypeError && error.message.includes("Assignment to constant variable")) {
             console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
             console.error("捕獲到 'Assignment to constant variable' 錯誤!");
             console.error("請再次檢查函式程式碼及所有輔助函式中，是否有 const 聲明的變數被重新賦值。");
             console.error("錯誤堆疊指向:", error.stack);
             console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        }

        // 嘗試從錯誤物件獲取狀態碼，否則預設為 500
        const statusCode = error.status || 500;

        // 確保在傳送錯誤響應前沒有傳送過響應頭
        if (!res.headersSent) {
             res.setHeader('Content-Type', 'application/json');
             // CORS 頭應該已經在前面設定好了
             res.status(statusCode).json({
                success: false,
                error: `代理處理錯誤: ${error.message}`, // 返回錯誤訊息給前端
                targetUrl: targetUrl // 包含目標 URL 以便除錯
            });
        } else {
            // 如果響應頭已傳送，無法再傳送 JSON 錯誤
            console.error("[代理錯誤處理 V3] 響應頭已傳送，無法傳送 JSON 錯誤響應。");
            // 嘗試結束響應
             if (!res.writableEnded) {
                 res.end();
             }
        }
    } finally {
         // 記錄請求處理結束
         console.info('--- Vercel 代理請求結束 ---');
    }
}

// --- [確保所有輔助函式定義都在這裡] ---
// getTargetUrlFromPath, getBaseUrl, resolveUrl, rewriteUrlToProxy, getRandomUserAgent,
// fetchContentWithType, isM3u8Content, processKeyLine, processMapLine,
// processMediaPlaylist, processM3u8Content, processMasterPlaylist
