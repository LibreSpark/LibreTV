// 頁面載入後顯示彈窗指令碼
document.addEventListener('DOMContentLoaded', function() {
    // 彈窗顯示指令碼
    // 檢查使用者是否已經看過聲明
    const hasSeenDisclaimer = localStorage.getItem('hasSeenDisclaimer');
    
    if (!hasSeenDisclaimer) {
        // 顯示彈窗
        const disclaimerModal = document.getElementById('disclaimerModal');
        disclaimerModal.style.display = 'flex';
        
        // 新增接受按鈕事件
        document.getElementById('acceptDisclaimerBtn').addEventListener('click', function() {
            // 儲存使用者已看過聲明的狀態
            localStorage.setItem('hasSeenDisclaimer', 'true');
            // 隱藏彈窗
            disclaimerModal.style.display = 'none';
        });
    }

    // URL搜尋參數處理指令碼
    // 首先檢查是否是播放URL格式 (/watch 開頭的路徑)
    if (window.location.pathname.startsWith('/watch')) {
        // 播放URL，不做額外處理，watch.html會處理重定向
        return;
    }
    
    // 檢查頁面路徑中的搜尋參數 (格式: /s=keyword)
    const path = window.location.pathname;
    const searchPrefix = '/s=';
    
    if (path.startsWith(searchPrefix)) {
        // 提取搜尋關鍵詞
        const keyword = decodeURIComponent(path.substring(searchPrefix.length));
        if (keyword) {
            // 設定搜尋框的值
            document.getElementById('searchInput').value = keyword;
            // 顯示清空按鈕
            toggleClearButton();
            // 執行搜尋
            setTimeout(() => {
                // 使用setTimeout確保其他DOM載入和初始化完成
                search();
                // 更新瀏覽器歷史，不改變URL (保持搜尋參數在位址列)
                try {
                    window.history.replaceState(
                        { search: keyword }, 
                        `搜尋: ${keyword} - LibreTV`, 
                        window.location.href
                    );
                } catch (e) {
                    console.error('更新瀏覽器歷史失敗:', e);
                }
            }, 300);
        }
    }
    
    // 也檢查查詢字串中的搜尋參數 (格式: ?s=keyword)
    const urlParams = new URLSearchParams(window.location.search);
    const searchQuery = urlParams.get('s');
    
    if (searchQuery) {
        // 設定搜尋框的值
        document.getElementById('searchInput').value = searchQuery;
        // 執行搜尋
        setTimeout(() => {
            search();
            // 更新URL為規範格式
            try {
                window.history.replaceState(
                    { search: searchQuery }, 
                    `搜尋: ${searchQuery} - LibreTV`, 
                    `/s=${encodeURIComponent(searchQuery)}`
                );
            } catch (e) {
                console.error('更新瀏覽器歷史失敗:', e);
            }
        }, 300);
    }
});
