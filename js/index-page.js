// 页面加载后显示弹窗脚本
document.addEventListener('DOMContentLoaded', function() {
    // 弹窗显示脚本
    // 检查用户是否已经看过声明
    const hasSeenDisclaimer = localStorage.getItem('hasSeenDisclaimer');
    
    if (!hasSeenDisclaimer) {
        // 显示弹窗
        const disclaimerModal = document.getElementById('disclaimerModal');
        disclaimerModal.style.display = 'flex';
        
        // 添加接受按钮事件
        document.getElementById('acceptDisclaimerBtn').addEventListener('click', function() {
            // 保存用户已看过声明的状态
            localStorage.setItem('hasSeenDisclaimer', 'true');
            // 隐藏弹窗
            disclaimerModal.style.display = 'none';
        });
    }

    // URL搜索参数处理脚本
    // 首先检查是否是播放URL格式 (/watch 开头的路径)
    if (window.location.pathname.startsWith('/watch')) {
        // 播放URL，不做额外处理，watch.html会处理重定向
        return;
    }
    
    // 检查页面路径中的搜索参数 (格式: /s=keyword)
    const path = window.location.pathname;
    const searchPrefix = '/s=';
    
    if (path.startsWith(searchPrefix)) {
        // 提取搜索关键词
        const keyword = decodeURIComponent(path.substring(searchPrefix.length));
        if (keyword) {
            // 设置搜索框的值
            document.getElementById('searchInput').value = keyword;
            // 显示清空按钮
            toggleClearButton();
            // 执行搜索
            setTimeout(() => {
                // 使用setTimeout确保其他DOM加载和初始化完成
                search();
                // 更新浏览器历史，不改变URL (保持搜索参数在地址栏)
                try {
                    window.history.replaceState(
                        { search: keyword }, 
                        `搜索: ${keyword} - BoyloveTV`, 
                        window.location.href
                    );
                } catch (e) {
                    console.error('更新浏览器历史失败:', e);
                }
            }, 300);
        }
    }
    
    // 也检查查询字符串中的搜索参数 (格式: ?s=keyword)
    const urlParams = new URLSearchParams(window.location.search);
    const searchQuery = urlParams.get('s');
    
    if (searchQuery) {
        // 设置搜索框的值
        document.getElementById('searchInput').value = searchQuery;
        // 执行搜索
        setTimeout(() => {
            search();
            // 更新URL为规范格式
            try {
                window.history.replaceState(
                    { search: searchQuery }, 
                    `搜索: ${searchQuery} - BoyloveTV`, 
                    `/s=${encodeURIComponent(searchQuery)}`
                );
            } catch (e) {
                console.error('更新浏览器历史失败:', e);
            }
        }, 300);
    }
});
