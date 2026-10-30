// 新增動畫樣式
(function() {
    const style = document.createElement('style');
    style.textContent = `
        @keyframes pulse {
            0%, 100% {
                opacity: 1;
            }
            50% {
                opacity: 0.6;
            }
        }
        .animate-pulse {
            animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
    `;
    document.head.appendChild(style);
})();

// 獲取版本資訊
async function fetchVersion(url, errorMessage, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) {
        throw new Error(errorMessage);
    }
    return await response.text();
}

// 版本檢查函式
async function checkForUpdates() {
    try {
        // 獲取當前版本
        const currentVersion = await fetchVersion('/VERSION.txt', '獲取當前版本失敗', {
            cache: 'no-store'
        });
        
        // 獲取最新版本
        let latestVersion;
        const VERSION_URL = {
            PROXY: 'https://ghfast.top/raw.githubusercontent.com/LibreSpark/LibreTV/main/VERSION.txt',
            DIRECT: 'https://raw.githubusercontent.com/LibreSpark/LibreTV/main/VERSION.txt'
        };
        const FETCH_TIMEOUT = 1500;
        
        try {
            // 嘗試使用代理URL獲取最新版本
            const proxyPromise = fetchVersion(VERSION_URL.PROXY, '代理請求失敗');
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('代理請求超時')), FETCH_TIMEOUT)
            );
            
            latestVersion = await Promise.race([proxyPromise, timeoutPromise]);
            console.log('透過代理伺服器獲取版本成功');
        } catch (error) {
            console.log('代理請求失敗，嘗試直接請求:', error.message);
            try {
                // 代理失敗後嘗試直接獲取
                latestVersion = await fetchVersion(VERSION_URL.DIRECT, '獲取最新版本失敗');
                console.log('直接請求獲取版本成功');
            } catch (directError) {
                console.error('所有版本檢查請求均失敗:', directError);
                throw new Error('無法獲取最新版本資訊');
            }
        }
        
        console.log('當前版本:', currentVersion);
        console.log('最新版本:', latestVersion);
        
        // 清理版本字串（移除可能的空格或換行符）
        const cleanCurrentVersion = currentVersion.trim();
        const cleanLatestVersion = latestVersion.trim();
        
        // 返回版本資訊
        return {
            current: cleanCurrentVersion,
            latest: cleanLatestVersion,
            hasUpdate: parseInt(cleanLatestVersion) > parseInt(cleanCurrentVersion),
            currentFormatted: formatVersion(cleanCurrentVersion),
            latestFormatted: formatVersion(cleanLatestVersion)
        };
    } catch (error) {
        console.error('版本檢測出錯:', error);
        throw error;
    }
}

// 格式化版本號為可讀形式 (yyyyMMddhhmm -> yyyy-MM-dd hh:mm)
function formatVersion(versionString) {
    // 檢測版本字串是否有效
    if (!versionString) {
        return '未知版本';
    }
    
    // 清理版本字串（移除可能的空格或換行符）
    const cleanedString = versionString.trim();
    
    // 格式化標準12位版本號
    if (cleanedString.length === 12) {
        const year = cleanedString.substring(0, 4);
        const month = cleanedString.substring(4, 6);
        const day = cleanedString.substring(6, 8);
        const hour = cleanedString.substring(8, 10);
        const minute = cleanedString.substring(10, 12);
        
        return `${year}-${month}-${day} ${hour}:${minute}`;
    }
    
    return cleanedString;
}

// 建立錯誤版本資訊元素
function createErrorVersionElement(errorMessage) {
    const errorElement = document.createElement('p');
    errorElement.className = 'text-gray-500 text-sm mt-1 text-center md:text-left';
    errorElement.innerHTML = `版本: <span class="text-amber-500">檢測失敗</span>`;
    errorElement.title = errorMessage;
    return errorElement;
}

// 新增版本資訊到頁尾
function addVersionInfoToFooter() {
    checkForUpdates().then(result => {
        if (!result) {
            // 如果版本檢測失敗，顯示錯誤資訊
            const versionElement = createErrorVersionElement();
            // 在頁尾顯示錯誤元素
            displayVersionElement(versionElement);
            return;
        }
        
        // 建立版本資訊元素
        const versionElement = document.createElement('p');
        versionElement.className = 'text-gray-500 text-sm mt-1 text-center md:text-left';
        
        // 新增當前版本資訊
        versionElement.innerHTML = `版本: ${result.currentFormatted}`;
        
        // 如果有更新，新增更新提示
        if (result.hasUpdate) {
            versionElement.innerHTML += ` <span class="inline-flex items-center bg-red-600 text-white text-xs px-2 py-0.5 rounded-md ml-1 cursor-pointer animate-pulse font-medium">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                發現新版
            </span>`;
            
            setTimeout(() => {
                const updateBtn = versionElement.querySelector('span');
                if (updateBtn) {
                    updateBtn.addEventListener('click', () => {
                        window.open('https://github.com/LibreSpark/LibreTV', '_blank');
                    });
                }
            }, 100);
        } else {
            // 如果沒有更新，顯示當前版本為最新版本
            versionElement.innerHTML = `版本: ${result.currentFormatted} <span class="text-green-500">(最新版本)</span>`;
        }
        
        // 顯示版本元素
        displayVersionElement(versionElement);
    }).catch(error => {
        console.error('版本檢測出錯:', error);
        // 建立錯誤版本資訊元素並顯示
        const errorElement = createErrorVersionElement(`錯誤資訊: ${error.message}`);
        displayVersionElement(errorElement);
    });
}

// 在頁尾顯示版本元素的輔助函式
function displayVersionElement(element) {
    // 獲取頁尾元素
    const footerElement = document.querySelector('.footer p.text-gray-500.text-sm');
    if (footerElement) {
        // 在原版權資訊後插入版本資訊
        footerElement.insertAdjacentElement('afterend', element);
    } else {
        // 如果找不到頁尾元素，嘗試在頁尾區域最後新增
        const footer = document.querySelector('.footer .container');
        if (footer) {
            footer.querySelector('div').appendChild(element);
        }
    }
}

// 頁面載入完成後新增版本資訊
document.addEventListener('DOMContentLoaded', addVersionInfoToFooter);
