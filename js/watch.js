// 獲取當前URL的參數，並將它們傳遞給player.html
window.onload = function() {
    // 獲取當前URL的查詢參數
    const currentParams = new URLSearchParams(window.location.search);
    
    // 建立player.html的URL物件
    const playerUrlObj = new URL("player.html", window.location.origin);
    
    // 更新狀態文字
    const statusElement = document.getElementById('redirect-status');
    const manualRedirect = document.getElementById('manual-redirect');
    let statusMessages = [
        "準備影片資料中...",
        "正在載入影片資訊...",
        "即將開始播放...",
    ];
    let currentStatus = 0;
    
    // 狀態文字動畫
    let statusInterval = setInterval(() => {
        if (currentStatus >= statusMessages.length) {
            currentStatus = 0;
        }
        if (statusElement) {
            statusElement.textContent = statusMessages[currentStatus];
            statusElement.style.opacity = 0.7;
            setTimeout(() => {
                if (statusElement) statusElement.style.opacity = 1;
            }, 300);
        }
        currentStatus++;
    }, 1000);
    
    // 確保保留所有原始參數
    currentParams.forEach((value, key) => {
        playerUrlObj.searchParams.set(key, value);
    });
    
    // 獲取來源URL (如果存在)
    const referrer = document.referrer;
    
    // 獲取當前URL中的返回URL參數（如果有）
    const backUrl = currentParams.get('back');
    
    // 確定返回URL的優先順序：1. 指定的back參數 2. referrer 3. 搜尋頁面
    let returnUrl = '';
    if (backUrl) {
        // 有顯式指定的返回URL
        returnUrl = decodeURIComponent(backUrl);
    } else if (referrer && (referrer.includes('/s=') || referrer.includes('?s='))) {
        // 來源是搜尋頁面
        returnUrl = referrer;
    } else if (referrer && referrer.trim() !== '') {
        // 如果有referrer但不是搜尋頁，也使用它
        returnUrl = referrer;
    } else {
        // 預設回到首頁
        returnUrl = '/';
    }
    
    // 將返回URL新增到player.html的參數中
    if (!playerUrlObj.searchParams.has('returnUrl')) {
        playerUrlObj.searchParams.set('returnUrl', encodeURIComponent(returnUrl));
    }
    
    // 同時儲存在localStorage中，作為備用
    localStorage.setItem('lastPageUrl', returnUrl);
    
    // 標記來自搜尋頁面
    if (returnUrl.includes('/s=') || returnUrl.includes('?s=')) {
        localStorage.setItem('cameFromSearch', 'true');
        localStorage.setItem('searchPageUrl', returnUrl);
    }
    
    // 獲取最終的URL字串
    const finalPlayerUrl = playerUrlObj.toString();
    
    // 更新手動重定向連結
    if (manualRedirect) {
        manualRedirect.href = finalPlayerUrl;
    }

    // 更新meta refresh標籤
    const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
    if (metaRefresh) {
        metaRefresh.content = `3; url=${finalPlayerUrl}`;
    }
    
    // 重定向到播放器頁面
    setTimeout(() => {
        clearInterval(statusInterval);
        window.location.href = finalPlayerUrl;
    }, 2800); // 稍微早於meta refresh的時間，確保我們的JS控制重定向
};