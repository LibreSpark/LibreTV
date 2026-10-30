// /netlify/functions/proxy.mjs - Netlify Function (ES Module)

import fetch from 'node-fetch';
import { URL } from 'url'; // Use Node.js built-in URL
import crypto from 'crypto'; // 匯入 crypto 模組用於密碼雜湊

// --- Configuration (Read from Environment Variables) ---
const DEBUG_ENABLED = process.env.DEBUG === 'true';
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10); // Default 24 hours
const MAX_RECURSION = parseInt(process.env.MAX_RECURSION || '5', 10); // Default 5 levels

// --- User Agent Handling ---
let USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
];
try {
    const agentsJsonString = process.env.USER_AGENTS_JSON;
    if (agentsJsonString) {
        const parsedAgents = JSON.parse(agentsJsonString);
        if (Array.isArray(parsedAgents) && parsedAgents.length > 0) {
            USER_AGENTS = parsedAgents;
            console.log(`[Proxy Log Netlify] Loaded ${USER_AGENTS.length} user agents from environment variable.`);
        } else {
            console.warn("[Proxy Log Netlify] USER_AGENTS_JSON environment variable is not a valid non-empty array, using default.");
        }
    } else {
        console.log("[Proxy Log Netlify] USER_AGENTS_JSON environment variable not set, using default user agents.");
    }
} catch (e) {
    console.error(`[Proxy Log Netlify] Error parsing USER_AGENTS_JSON environment variable: ${e.message}. Using default user agents.`);
}
const FILTER_DISCONTINUITY = false; // Ad filtering disabled

// --- Helper Functions (Same as Vercel version, except rewriteUrlToProxy) ---

function logDebug(message) {
    if (DEBUG_ENABLED) {
        console.log(`[Proxy Log Netlify] ${message}`);
    }
}

function getTargetUrlFromPath(encodedPath) {
    if (!encodedPath) { logDebug("getTargetUrlFromPath received empty path."); return null; }
    try {
        const decodedUrl = decodeURIComponent(encodedPath);
        if (decodedUrl.match(/^https?:\/\/.+/i)) { return decodedUrl; }
        else {
            logDebug(`Invalid decoded URL format: ${decodedUrl}`);
            if (encodedPath.match(/^https?:\/\/.+/i)) { logDebug(`Warning: Path was not encoded but looks like URL: ${encodedPath}`); return encodedPath; }
            return null;
        }
    } catch (e) { logDebug(`Error decoding target URL: ${encodedPath} - ${e.message}`); return null; }
}

function getBaseUrl(urlStr) {
    if (!urlStr) return '';
    try {
        const parsedUrl = new URL(urlStr);
        const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
        if (pathSegments.length <= 1) { return `${parsedUrl.origin}/`; }
        pathSegments.pop(); return `${parsedUrl.origin}/${pathSegments.join('/')}/`;
    } catch (e) {
        logDebug(`Getting BaseUrl failed for "${urlStr}": ${e.message}`);
        const lastSlashIndex = urlStr.lastIndexOf('/');
        if (lastSlashIndex > urlStr.indexOf('://') + 2) { return urlStr.substring(0, lastSlashIndex + 1); }
        return urlStr + '/';
    }
}

function resolveUrl(baseUrl, relativeUrl) {
    if (!relativeUrl) return ''; if (relativeUrl.match(/^https?:\/\/.+/i)) { return relativeUrl; } if (!baseUrl) return relativeUrl;
    try { return new URL(relativeUrl, baseUrl).toString(); }
    catch (e) {
        logDebug(`URL resolution failed: base="${baseUrl}", relative="${relativeUrl}". Error: ${e.message}`);
        if (relativeUrl.startsWith('/')) { try { const baseOrigin = new URL(baseUrl).origin; return `${baseOrigin}${relativeUrl}`; } catch { return relativeUrl; } }
        else { return `${baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)}${relativeUrl}`; }
    }
}

// ** MODIFIED for Netlify redirect **
function rewriteUrlToProxy(targetUrl) {
    if (!targetUrl || typeof targetUrl !== 'string') return '';
    // Use the path defined in netlify.toml 'from' field
    return `/proxy/${encodeURIComponent(targetUrl)}`;
}

function getRandomUserAgent() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

/**
 * 驗證代理請求的鑑權
 */
function validateAuth(event) {
    const params = new URLSearchParams(event.queryStringParameters || {});
    const authHash = params.get('auth');
    const timestamp = params.get('t');
    
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

async function fetchContentWithType(targetUrl, requestHeaders) {
    const headers = {
        'User-Agent': getRandomUserAgent(),
        'Accept': requestHeaders['accept'] || '*/*',
        'Accept-Language': requestHeaders['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': requestHeaders['referer'] || new URL(targetUrl).origin,
    };
    Object.keys(headers).forEach(key => headers[key] === undefined || headers[key] === null || headers[key] === '' ? delete headers[key] : {});
    logDebug(`Fetching target: ${targetUrl} with headers: ${JSON.stringify(headers)}`);
    try {
        const response = await fetch(targetUrl, { headers, redirect: 'follow' });
        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            logDebug(`Fetch failed: ${response.status} ${response.statusText} - ${targetUrl}`);
            const err = new Error(`HTTP error ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${errorBody.substring(0, 200)}`);
            err.status = response.status; throw err;
        }
        const content = await response.text();
        const contentType = response.headers.get('content-type') || '';
        logDebug(`Fetch success: ${targetUrl}, Content-Type: ${contentType}, Length: ${content.length}`);
        return { content, contentType, responseHeaders: response.headers };
    } catch (error) {
        logDebug(`Fetch exception for ${targetUrl}: ${error.message}`);
        throw new Error(`Failed to fetch target URL ${targetUrl}: ${error.message}`);
    }
}

function isM3u8Content(content, contentType) {
    if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) { return true; }
    return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
}

function processKeyLine(line, baseUrl) { return line.replace(/URI="([^"]+)"/, (match, uri) => { const absoluteUri = resolveUrl(baseUrl, uri); logDebug(`Processing KEY URI: Original='${uri}', Absolute='${absoluteUri}'`); return `URI="${rewriteUrlToProxy(absoluteUri)}"`; }); }
function processMapLine(line, baseUrl) { return line.replace(/URI="([^"]+)"/, (match, uri) => { const absoluteUri = resolveUrl(baseUrl, uri); logDebug(`Processing MAP URI: Original='${uri}', Absolute='${absoluteUri}'`); return `URI="${rewriteUrlToProxy(absoluteUri)}"`; }); }
function processMediaPlaylist(url, content) {
    const baseUrl = getBaseUrl(url); if (!baseUrl) { logDebug(`Could not determine base URL for media playlist: ${url}. Cannot process relative paths.`); }
    const lines = content.split('\n'); const output = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim(); if (!line && i === lines.length - 1) { output.push(line); continue; } if (!line) continue;
        if (line.startsWith('#EXT-X-KEY')) { output.push(processKeyLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXT-X-MAP')) { output.push(processMapLine(line, baseUrl)); continue; }
        if (line.startsWith('#EXTINF')) { output.push(line); continue; }
        if (!line.startsWith('#')) { const absoluteUrl = resolveUrl(baseUrl, line); logDebug(`Rewriting media segment: Original='${line}', Resolved='${absoluteUrl}'`); output.push(rewriteUrlToProxy(absoluteUrl)); continue; }
        output.push(line);
    } return output.join('\n');
}
async function processM3u8Content(targetUrl, content, recursionDepth = 0) {
    if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) { logDebug(`Detected master playlist: ${targetUrl} (Depth: ${recursionDepth})`); return await processMasterPlaylist(targetUrl, content, recursionDepth); }
    logDebug(`Detected media playlist: ${targetUrl} (Depth: ${recursionDepth})`); return processMediaPlaylist(targetUrl, content);
}
async function processMasterPlaylist(url, content, recursionDepth) {
    if (recursionDepth > MAX_RECURSION) { throw new Error(`Max recursion depth (${MAX_RECURSION}) exceeded for master playlist: ${url}`); }
    const baseUrl = getBaseUrl(url); const lines = content.split('\n'); let highestBandwidth = -1; let bestVariantUrl = '';
    for (let i = 0; i < lines.length; i++) { if (lines[i].startsWith('#EXT-X-STREAM-INF')) { const bandwidthMatch = lines[i].match(/BANDWIDTH=(\d+)/); const currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0; let variantUriLine = ''; for (let j = i + 1; j < lines.length; j++) { const line = lines[j].trim(); if (line && !line.startsWith('#')) { variantUriLine = line; i = j; break; } } if (variantUriLine && currentBandwidth >= highestBandwidth) { highestBandwidth = currentBandwidth; bestVariantUrl = resolveUrl(baseUrl, variantUriLine); } } }
    if (!bestVariantUrl) { logDebug(`No BANDWIDTH found, trying first URI in: ${url}`); for (let i = 0; i < lines.length; i++) { const line = lines[i].trim(); if (line && !line.startsWith('#') && line.match(/\.m3u8($|\?.*)/i)) { bestVariantUrl = resolveUrl(baseUrl, line); logDebug(`Fallback: Found first sub-playlist URI: ${bestVariantUrl}`); break; } } }
    if (!bestVariantUrl) { logDebug(`No valid sub-playlist URI found in master: ${url}. Processing as media playlist.`); return processMediaPlaylist(url, content); }
    logDebug(`Selected sub-playlist (Bandwidth: ${highestBandwidth}): ${bestVariantUrl}`);
    const { content: variantContent, contentType: variantContentType } = await fetchContentWithType(bestVariantUrl, {});
    if (!isM3u8Content(variantContent, variantContentType)) { logDebug(`Fetched sub-playlist ${bestVariantUrl} is not M3U8 (Type: ${variantContentType}). Treating as media playlist.`); return processMediaPlaylist(bestVariantUrl, variantContent); }
    return await processM3u8Content(bestVariantUrl, variantContent, recursionDepth + 1);
}


// --- Netlify Handler ---
export const handler = async (event, context) => {
    console.log('--- Netlify Proxy Request ---');
    console.log('Time:', new Date().toISOString());
    console.log('Method:', event.httpMethod);
    console.log('Path:', event.path);
    // Note: event.queryStringParameters contains query params if any
    // Note: event.headers contains incoming headers

    // --- CORS Headers (for all responses) ---
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*', // Allow all headers client might send
    };

    // --- Handle OPTIONS Preflight Request ---
    if (event.httpMethod === 'OPTIONS') {
        logDebug("Handling OPTIONS request");
        return {
            statusCode: 204,
            headers: {
                ...corsHeaders,
                'Access-Control-Max-Age': '86400', // Cache preflight for 24 hours
            },
            body: '',
        };
    }

    // --- 驗證鑑權 ---
    if (!validateAuth(event)) {
        console.warn('Netlify 代理請求鑑權失敗');
        return {
            statusCode: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                error: '代理訪問未授權：請檢查密碼配置或鑑權參數'
            }),
        };
    }

    // --- Extract Target URL ---
    // Based on netlify.toml rewrite: from = "/proxy/*" to = "/.netlify/functions/proxy/:splat"
    // The :splat part should be available in event.path after the base path
    let encodedUrlPath = '';
    const proxyPrefix = '/proxy/'; // Match the 'from' path in netlify.toml
    if (event.path && event.path.startsWith(proxyPrefix)) {
        encodedUrlPath = event.path.substring(proxyPrefix.length);
        logDebug(`Extracted encoded path from event.path: ${encodedUrlPath}`);
    } else {
        logDebug(`Could not extract encoded path from event.path: ${event.path}`);
        // Potentially handle direct calls too? Less likely needed.
        // const functionPath = '/.netlify/functions/proxy/';
        // if (event.path && event.path.startsWith(functionPath)) {
        //     encodedUrlPath = event.path.substring(functionPath.length);
        // }
    }

    const targetUrl = getTargetUrlFromPath(encodedUrlPath);
    logDebug(`Resolved target URL: ${targetUrl || 'null'}`);

    if (!targetUrl) {
        logDebug('Error: Invalid proxy request path.');
        return {
            statusCode: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: "Invalid proxy request path. Could not extract target URL." }),
        };
    }

    logDebug(`Processing proxy request for target: ${targetUrl}`);

    try {
        // 驗證鑑權
        const isValidAuth = validateAuth(event);
        if (!isValidAuth) {
            return {
                statusCode: 403,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: false, error: "Forbidden: Invalid auth credentials." }),
            };
        }

        // Fetch Original Content (Pass Netlify event headers)
        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl, event.headers);

        // --- Process if M3U8 ---
        if (isM3u8Content(content, contentType)) {
            logDebug(`Processing M3U8 content: ${targetUrl}`);
            const processedM3u8 = await processM3u8Content(targetUrl, content);

            logDebug(`Successfully processed M3U8 for ${targetUrl}`);
            return {
                statusCode: 200,
                headers: {
                    ...corsHeaders, // Include CORS headers
                    'Content-Type': 'application/vnd.apple.mpegurl;charset=utf-8',
                    'Cache-Control': `public, max-age=${CACHE_TTL}`,
                    // Note: Do NOT include content-encoding or content-length from original response
                    // as node-fetch likely decompressed it and length changed.
                },
                body: processedM3u8, // Netlify expects body as string
            };
        } else {
            // --- Return Original Content (Non-M3U8) ---
            logDebug(`Returning non-M3U8 content directly: ${targetUrl}, Type: ${contentType}`);

            // Prepare headers for Netlify response object
            const netlifyHeaders = { ...corsHeaders };
            responseHeaders.forEach((value, key) => {
                 const lowerKey = key.toLowerCase();
                 // Exclude problematic headers and CORS headers (already added)
                 if (!lowerKey.startsWith('access-control-') &&
                     lowerKey !== 'content-encoding' &&
                     lowerKey !== 'content-length') {
                     netlifyHeaders[key] = value; // Add other original headers
                 }
             });
            netlifyHeaders['Cache-Control'] = `public, max-age=${CACHE_TTL}`; // Set our cache policy

            return {
                statusCode: 200,
                headers: netlifyHeaders,
                body: content, // Body as string
                // isBase64Encoded: false, // Set true only if returning binary data as base64
            };
        }

    } catch (error) {
        logDebug(`ERROR in proxy processing for ${targetUrl}: ${error.message}`);
        console.error(`[Proxy Error Stack Netlify] ${error.stack}`); // Log full stack

        const statusCode = error.status || 500; // Get status from error if available

        return {
            statusCode: statusCode,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                error: `Proxy processing error: ${error.message}`,
                targetUrl: targetUrl
            }),
        };
    }
};
