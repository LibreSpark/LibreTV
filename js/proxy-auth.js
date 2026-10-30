/**
 * 代理請求鑑權模組
 * 為代理請求新增基於 PASSWORD 的鑑權機制
 */

// 從全域性配置獲取密碼雜湊（如果存在）
let cachedPasswordHash = null;

/**
 * 獲取當前會話的密碼雜湊
 */
async function getPasswordHash() {
    if (cachedPasswordHash) {
        return cachedPasswordHash;
    }
    
    // 1. 優先從已儲存的代理鑑權雜湊獲取
    const storedHash = localStorage.getItem('proxyAuthHash');
    if (storedHash) {
        cachedPasswordHash = storedHash;
        return storedHash;
    }
    
    // 2. 嘗試從密碼驗證狀態獲取（password.js 驗證後儲存的雜湊）
    const passwordVerified = localStorage.getItem('passwordVerified');
    const storedPasswordHash = localStorage.getItem('passwordHash');
    if (passwordVerified === 'true' && storedPasswordHash) {
        localStorage.setItem('proxyAuthHash', storedPasswordHash);
        cachedPasswordHash = storedPasswordHash;
        return storedPasswordHash;
    }
    
    // 3. 嘗試從使用者輸入的密碼生成雜湊
    const userPassword = localStorage.getItem('userPassword');
    if (userPassword) {
        try {
            // 動態匯入 sha256 函式
            const { sha256 } = await import('./sha256.js');
            const hash = await sha256(userPassword);
            localStorage.setItem('proxyAuthHash', hash);
            cachedPasswordHash = hash;
            return hash;
        } catch (error) {
            console.error('生成密碼雜湊失敗:', error);
        }
    }
    
    // 4. 如果使用者沒有設定密碼，嘗試使用環境變數中的密碼雜湊
    if (window.__ENV__ && window.__ENV__.PASSWORD) {
        cachedPasswordHash = window.__ENV__.PASSWORD;
        return window.__ENV__.PASSWORD;
    }
    
    return null;
}

/**
 * 為代理請求URL新增鑑權參數
 */
async function addAuthToProxyUrl(url) {
    try {
        const hash = await getPasswordHash();
        if (!hash) {
            console.warn('無法獲取密碼雜湊，代理請求可能失敗');
            return url;
        }
        
        // 新增時間戳防止重放攻擊
        const timestamp = Date.now();
        
        // 檢查URL是否已包含查詢參數
        const separator = url.includes('?') ? '&' : '?';
        
        return `${url}${separator}auth=${encodeURIComponent(hash)}&t=${timestamp}`;
    } catch (error) {
        console.error('新增代理鑑權失敗:', error);
        return url;
    }
}

/**
 * 驗證代理請求的鑑權
 */
function validateProxyAuth(authHash, serverPasswordHash, timestamp) {
    if (!authHash || !serverPasswordHash) {
        return false;
    }
    
    // 驗證雜湊是否匹配
    if (authHash !== serverPasswordHash) {
        return false;
    }
    
    // 驗證時間戳（10分鐘有效期）
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10分鐘
    
    if (timestamp && (now - parseInt(timestamp)) > maxAge) {
        console.warn('代理請求時間戳過期');
        return false;
    }
    
    return true;
}

/**
 * 清除快取的鑑權資訊
 */
function clearAuthCache() {
    cachedPasswordHash = null;
    localStorage.removeItem('proxyAuthHash');
}

// 監聽密碼變化，清除快取
window.addEventListener('storage', (e) => {
    if (e.key === 'userPassword' || (window.PASSWORD_CONFIG && e.key === window.PASSWORD_CONFIG.localStorageKey)) {
        clearAuthCache();
    }
});

// 匯出函式
window.ProxyAuth = {
    addAuthToProxyUrl,
    validateProxyAuth,
    clearAuthCache,
    getPasswordHash
};
