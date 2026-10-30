// UI相關函式
function toggleSettings(e) {
    // 強化的密碼保護校驗 - 防止繞過
    try {
        if (window.ensurePasswordProtection) {
            window.ensurePasswordProtection();
        } else {
            // 相容性檢查
            if (window.isPasswordProtected && window.isPasswordVerified) {
                if (window.isPasswordProtected() && !window.isPasswordVerified()) {
                    showPasswordModal && showPasswordModal();
                    return;
                }
            }
        }
    } catch (error) {
        console.warn('Password protection check failed:', error.message);
        return;
    }
    // 阻止事件冒泡，防止觸發document的點擊事件
    e && e.stopPropagation();
    const panel = document.getElementById('settingsPanel');
    panel.classList.toggle('show');
}

// 改進的Toast顯示函式 - 支援佇列顯示多個Toast
const toastQueue = [];
let isShowingToast = false;

function showToast(message, type = 'error') {
    // 首先確保toast元素存在
    let toast = document.getElementById('toast');
    let toastMessage = document.getElementById('toastMessage');

    // 如果toast元素不存在，建立它
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'fixed top-4 left-1/2 -translate-x-1/2 px-6 py-3 rounded-lg shadow-lg transform transition-all duration-300 z-50 opacity-0';
        toast.style = 'z-index: 2147483647'
        toastMessage = document.createElement('p');
        toastMessage.id = 'toastMessage';
        toast.appendChild(toastMessage);

        document.body.appendChild(toast);
    }

    // 將新的toast新增到佇列
    toastQueue.push({ message, type });

    // 如果當前沒有顯示中的toast，則開始顯示
    if (!isShowingToast) {
        showNextToast();
    }
}

function showNextToast() {
    if (toastQueue.length === 0) {
        isShowingToast = false;
        return;
    }

    isShowingToast = true;
    const { message, type } = toastQueue.shift();

    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');

    const bgColors = {
        'error': 'bg-red-500',
        'success': 'bg-green-500',
        'info': 'bg-blue-500',
        'warning': 'bg-yellow-500'
    };

    const bgColor = bgColors[type] || bgColors.error;
    toast.className = `fixed top-4 left-1/2 -translate-x-1/2 px-6 py-3 rounded-lg shadow-lg transform transition-all duration-300 ${bgColor} text-white z-50`;
    toastMessage.textContent = message;

    // 顯示提示
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';

    // 3秒後自動隱藏
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-100%)';

        // 等待動畫完成後顯示下一個toast
        setTimeout(() => {
            showNextToast();
        }, 300);
    }, 3000);
}

// 新增顯示/隱藏 loading 的函式
let loadingTimeoutId = null;

function showLoading(message = '載入中...') {
    // 清除任何現有的超時
    if (loadingTimeoutId) {
        clearTimeout(loadingTimeoutId);
    }

    const loading = document.getElementById('loading');
    const messageEl = loading.querySelector('p');
    messageEl.textContent = message;
    loading.style.display = 'flex';

    // 設定30秒後自動關閉loading，防止無限loading
    loadingTimeoutId = setTimeout(() => {
        hideLoading();
        showToast('操作超時，請稍後重試', 'warning');
    }, 30000);
}

function hideLoading() {
    // 清除超時
    if (loadingTimeoutId) {
        clearTimeout(loadingTimeoutId);
        loadingTimeoutId = null;
    }

    const loading = document.getElementById('loading');
    loading.style.display = 'none';
}

function updateSiteStatus(isAvailable) {
    const statusEl = document.getElementById('siteStatus');
    if (isAvailable) {
        statusEl.innerHTML = '<span class="text-green-500">●</span> 可用';
    } else {
        statusEl.innerHTML = '<span class="text-red-500">●</span> 不可用';
    }
}

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
    // 清除 iframe 內容
    document.getElementById('modalContent').innerHTML = '';
}

// 獲取搜尋歷史的增強版本 - 支援新舊格式
function getSearchHistory() {
    try {
        const data = localStorage.getItem(SEARCH_HISTORY_KEY);
        if (!data) return [];

        const parsed = JSON.parse(data);

        // 檢查是否是陣列
        if (!Array.isArray(parsed)) return [];

        // 支援舊格式（字串陣列）和新格式（物件陣列）
        return parsed.map(item => {
            if (typeof item === 'string') {
                return { text: item, timestamp: 0 };
            }
            return item;
        }).filter(item => item && item.text);
    } catch (e) {
        console.error('獲取搜尋歷史出錯:', e);
        return [];
    }
}

// 儲存搜尋歷史的增強版本 - 新增時間戳和最大數量限制，現在快取2個月
function saveSearchHistory(query) {
    if (!query || !query.trim()) return;

    // 清理輸入，防止XSS
    query = query.trim().substring(0, 50).replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let history = getSearchHistory();

    // 獲取當前時間
    const now = Date.now();

    // 過濾掉超過2個月的記錄（約60天，60*24*60*60*1000 = 5184000000毫秒）
    history = history.filter(item =>
        typeof item === 'object' && item.timestamp && (now - item.timestamp < 5184000000)
    );

    // 刪除已存在的相同項
    history = history.filter(item =>
        typeof item === 'object' ? item.text !== query : item !== query
    );

    // 新項新增到開頭，包含時間戳
    history.unshift({
        text: query,
        timestamp: now
    });

    // 限制歷史記錄數量
    if (history.length > MAX_HISTORY_ITEMS) {
        history = history.slice(0, MAX_HISTORY_ITEMS);
    }

    try {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        console.error('儲存搜尋歷史失敗:', e);
        // 如果儲存失敗（可能是localStorage已滿），嘗試清理舊資料
        try {
            localStorage.removeItem(SEARCH_HISTORY_KEY);
            localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, 3)));
        } catch (e2) {
            console.error('再次儲存搜尋歷史失敗:', e2);
        }
    }

    renderSearchHistory();
}

// 渲染最近搜尋歷史的增強版本
function renderSearchHistory() {
    const historyContainer = document.getElementById('recentSearches');
    if (!historyContainer) return;

    const history = getSearchHistory();

    if (history.length === 0) {
        historyContainer.innerHTML = '';
        return;
    }

    // 建立一個包含標題和清除按鈕的行
    historyContainer.innerHTML = `
        <div class="flex justify-between items-center w-full mb-2">
            <div class="text-gray-500">最近搜尋:</div>
            <button id="clearHistoryBtn" class="text-gray-500 hover:text-white transition-colors"
                    onclick="clearSearchHistory()" aria-label="清除搜尋歷史">
                清除搜尋歷史
            </button>
        </div>
    `;

    history.forEach(item => {
        const tag = document.createElement('button');
        tag.className = 'search-tag flex items-center gap-1';
        const textSpan = document.createElement('span');
        textSpan.textContent = item.text;
        tag.appendChild(textSpan);

        // 新增刪除按鈕
        const deleteButton = document.createElement('span');
        deleteButton.className = 'pl-1 text-gray-500 hover:text-red-500 transition-colors';
        deleteButton.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
        deleteButton.onclick = function(e) {
            // 阻止事件冒泡，避免觸發搜尋
            e.stopPropagation();
            // 刪除對應歷史記錄
            deleteSingleSearchHistory(item.text);
            // 重新渲染搜尋歷史
            renderSearchHistory();
        };
        tag.appendChild(deleteButton);

        // 新增時間提示（如果有時間戳）
        if (item.timestamp) {
            const date = new Date(item.timestamp);
            tag.title = `搜尋於: ${date.toLocaleString()}`;
        }

        tag.onclick = function() {
            document.getElementById('searchInput').value = item.text;
            search();
        };
        historyContainer.appendChild(tag);
    });
}

// 刪除單條搜尋歷史記錄
function deleteSingleSearchHistory(query) {
    // 當url中包含刪除的關鍵詞時，頁面重新整理後會自動加入歷史記錄，導致誤認為刪除功能有bug。此問題無需修復，功能無實際影響。
    try {
        let history = getSearchHistory();
        // 過濾掉要刪除的記錄
        history = history.filter(item => item.text !== query);
        console.log('更新後的搜尋歷史:', history);
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
        console.error('刪除單條搜尋歷史失敗:', e);
        showToast('刪除單條搜尋歷史失敗', 'error');
    }
}

// 增加清除搜尋歷史功能
function clearSearchHistory() {
    // 密碼保護校驗
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    try {
        localStorage.removeItem(SEARCH_HISTORY_KEY);
        renderSearchHistory();
        showToast('搜尋歷史已清除', 'success');
    } catch (e) {
        console.error('清除搜尋歷史失敗:', e);
        showToast('清除搜尋歷史失敗:', 'error');
    }
}

// 歷史面板相關函式
function toggleHistory(e) {
    // 密碼保護校驗
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    if (e) e.stopPropagation();

    const panel = document.getElementById('historyPanel');
    if (panel) {
        panel.classList.toggle('show');

        // 如果開啟了歷史記錄面板，則載入歷史資料
        if (panel.classList.contains('show')) {
            loadViewingHistory();
        }

        // 如果設定面板是開啟的，則關閉它
        const settingsPanel = document.getElementById('settingsPanel');
        if (settingsPanel && settingsPanel.classList.contains('show')) {
            settingsPanel.classList.remove('show');
        }
    }
}

// 格式化時間戳為友好的日期時間格式
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    // 小於1小時，顯示"X分鐘前"
    if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        return minutes <= 0 ? '剛剛' : `${minutes}分鐘前`;
    }

    // 小於24小時，顯示"X小時前"
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours}小時前`;
    }

    // 小於7天，顯示"X天前"
    if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return `${days}天前`;
    }

    // 其他情況，顯示完整日期
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hour = date.getHours().toString().padStart(2, '0');
    const minute = date.getMinutes().toString().padStart(2, '0');

    return `${year}-${month}-${day} ${hour}:${minute}`;
}

// 獲取觀看歷史記錄
function getViewingHistory() {
    try {
        const data = localStorage.getItem('viewingHistory');
        return data ? JSON.parse(data) : [];
    } catch (e) {
        console.error('獲取觀看歷史失敗:', e);
        return [];
    }
}

// 載入觀看歷史並渲染
function loadViewingHistory() {
    const historyList = document.getElementById('historyList');
    if (!historyList) return;

    const history = getViewingHistory();

    if (history.length === 0) {
        historyList.innerHTML = `<div class="text-center text-gray-500 py-8">暫無觀看記錄</div>`;
        return;
    }

    // 渲染歷史記錄
    historyList.innerHTML = history.map(item => {
        // 防止XSS
        const escapeHtml = (text) => text
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        // safeTitle 會傳給 playFromHistory，必須維持歷史紀錄中的原始片名（觀看歷史靠片名判斷是不是同一部）；
        // 畫面上顯示的 displayTitle 才轉成繁體（舊紀錄的片名可能是簡體）
        const safeTitle = escapeHtml(item.title);
        const displayTitle = escapeHtml(window.ZH ? ZH.toTW(item.title) : item.title);

        const safeSource = item.sourceName ?
            item.sourceName.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') :
            '未知來源';

        const episodeText = item.episodeIndex !== undefined ?
            `第${item.episodeIndex + 1}集` : '';

        // 格式化劇集資訊
        let episodeInfoHtml = '';
        if (item.episodes && Array.isArray(item.episodes) && item.episodes.length > 0) {
            const totalEpisodes = item.episodes.length;
            const syncStatus = item.lastSyncTime ?
                `<span class="text-green-400 text-xs" title="劇集列表已同步">✓</span>` :
                `<span class="text-yellow-400 text-xs" title="使用快取資料">⚠</span>`;
            episodeInfoHtml = `<span class="text-xs text-gray-400">共${totalEpisodes}集 ${syncStatus}</span>`;
        }

        // 格式化進度資訊
        let progressHtml = '';
        if (item.playbackPosition && item.duration && item.playbackPosition > 10 && item.playbackPosition < item.duration * 0.95) {
            const percent = Math.round((item.playbackPosition / item.duration) * 100);
            const formattedTime = formatPlaybackTime(item.playbackPosition);
            const formattedDuration = formatPlaybackTime(item.duration);

            progressHtml = `
                <div class="history-progress">
                    <div class="progress-bar">
                        <div class="progress-filled" style="width:${percent}%"></div>
                    </div>
                    <div class="progress-text">${formattedTime} / ${formattedDuration}</div>
                </div>
            `;
        }

        // 為防止XSS，使用encodeURIComponent編碼URL
        const safeURL = encodeURIComponent(item.url);

        // 構建歷史記錄項HTML，新增刪除按鈕，需要放在position:relative的容器中
        return `
            <div class="history-item cursor-pointer relative group" onclick="playFromHistory('${item.url}', '${safeTitle}', ${item.episodeIndex || 0}, ${item.playbackPosition || 0})">
                <button onclick="event.stopPropagation(); deleteHistoryItem('${safeURL}')"
                        class="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-gray-400 hover:text-red-400 p-1 rounded-full hover:bg-gray-800 z-10"
                        title="刪除記錄">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                </button>
                <div class="history-info">
                    <div class="history-title">${displayTitle}</div>
                    <div class="history-meta">
                        <span class="history-episode">${episodeText}</span>
                        ${episodeText ? '<span class="history-separator mx-1">·</span>' : ''}
                        <span class="history-source">${safeSource}</span>
                        ${episodeInfoHtml ? '<span class="history-separator mx-1">·</span>' : ''}
                        ${episodeInfoHtml}
                    </div>
                    ${progressHtml}
                    <div class="history-time">${formatTimestamp(item.timestamp)}</div>
                </div>
            </div>
        `;
    }).join('');

    // 檢查是否存在較多歷史記錄，新增底部邊距確保底部按鈕不會擋住內容
    if (history.length > 5) {
        historyList.classList.add('pb-4');
    }
}

// 格式化播放時間為 mm:ss 格式
function formatPlaybackTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);

    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 刪除單個歷史記錄項
function deleteHistoryItem(encodedUrl) {
    try {
        // 解碼URL
        const url = decodeURIComponent(encodedUrl);

        // 獲取當前歷史記錄
        const history = getViewingHistory();

        // 過濾掉要刪除的項
        const newHistory = history.filter(item => item.url !== url);

        // 儲存回localStorage
        localStorage.setItem('viewingHistory', JSON.stringify(newHistory));

        // 重新載入歷史記錄顯示
        loadViewingHistory();

        // 顯示成功提示
        showToast('已刪除該記錄', 'success');
    } catch (e) {
        console.error('刪除歷史記錄項失敗:', e);
        showToast('刪除記錄失敗', 'error');
    }
}

// 從歷史記錄播放
async function playFromHistory(url, title, episodeIndex, playbackPosition = 0) {
    // console.log('[playFromHistory in ui.js] Called with:', { url, title, episodeIndex, playbackPosition }); // Log 1
    try {
        let episodesList = [];
        let historyItem = null; // To store the full history item
        let syncSuccessful = false;

        // 檢查viewingHistory，查詢匹配的項
        const historyRaw = localStorage.getItem('viewingHistory');
        if (historyRaw) {
            const history = JSON.parse(historyRaw);
            historyItem = history.find(item => item.url === url);
            // console.log('[playFromHistory in ui.js] Found historyItem:', historyItem ? JSON.parse(JSON.stringify(historyItem)) : null); // Log 2 (stringify/parse for deep copy)
            if (historyItem) {
                // console.log('[playFromHistory in ui.js] historyItem.vod_id:', historyItem.vod_id, 'historyItem.sourceName:', historyItem.sourceName); // Log 3
            }

            if (historyItem && historyItem.episodes && Array.isArray(historyItem.episodes)) {
                episodesList = historyItem.episodes; // Default to stored episodes
                // console.log(`從歷史記錄找到影片 "${title}" 的集數資料 (預設):`, episodesList.length);
            }
        }

        // Always attempt to fetch fresh episode list if we have the necessary info
        if (historyItem && historyItem.vod_id && historyItem.sourceName) {
            // Show loading toast to indicate syncing
            showToast('正在同步最新劇集列表...', 'info');

            // console.log(`[playFromHistory in ui.js] Attempting to fetch details for vod_id: ${historyItem.vod_id}, sourceName: ${historyItem.sourceName}`); // Log 4
            try {
                // Construct the API URL for detail fetching
                // historyItem.sourceName is used as the sourceCode here
                // Add a cache buster timestamp
                const timestamp = new Date().getTime();
                const apiUrl = `/api/detail?id=${encodeURIComponent(historyItem.vod_id)}&source=${encodeURIComponent(historyItem.sourceName)}&_t=${timestamp}`;

                // Add timeout to the fetch request
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

                const response = await fetch(apiUrl, {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`API request failed with status ${response.status}`);
                }
                const videoDetails = await response.json();

                if (videoDetails && videoDetails.episodes && videoDetails.episodes.length > 0) {
                    const oldEpisodeCount = episodesList.length;
                    episodesList = videoDetails.episodes;
                    syncSuccessful = true;

                    // Show success message with episode count info
                    const newEpisodeCount = episodesList.length;
                    if (newEpisodeCount > oldEpisodeCount) {
                        showToast(`已同步最新劇集列表 (${newEpisodeCount}集，新增${newEpisodeCount - oldEpisodeCount}集)`, 'success');
                    } else if (newEpisodeCount === oldEpisodeCount) {
                        showToast(`劇集列表已是最新 (${newEpisodeCount}集)`, 'success');
                    } else {
                        showToast(`已同步最新劇集列表 (${newEpisodeCount}集)`, 'success');
                    }

                    // console.log(`成功獲取 "${title}" 最新劇集列表:`, episodesList.length, "集");
                    // Update the history item in localStorage with the fresh episodes
                    if (historyItem) {
                        historyItem.episodes = [...episodesList]; // Deep copy
                        historyItem.lastSyncTime = Date.now(); // Add sync timestamp
                        const history = JSON.parse(historyRaw); // Re-parse to ensure we have the latest version
                        const idx = history.findIndex(item => item.url === url);
                        if (idx !== -1) {
                            history[idx] = { ...history[idx], ...historyItem }; // Merge, ensuring other properties are kept
                            localStorage.setItem('viewingHistory', JSON.stringify(history));
                            // console.log("觀看歷史中的劇集列表已更新。");
                        }
                    }
                } else {
                    // console.log(`未能獲取 "${title}" 的最新劇集列表，或列表為空。將使用已儲存的劇集。`);
                    showToast('未獲取到最新劇集資訊，使用快取資料', 'warning');
                }
            } catch (fetchError) {
                // console.error(`獲取 "${title}" 最新劇集列表失敗:`, fetchError, "將使用已儲存的劇集。");
                if (fetchError.name === 'AbortError') {
                    showToast('同步劇集列表超時，使用快取資料', 'warning');
                } else {
                    showToast('同步劇集列表失敗，使用快取資料', 'warning');
                }
            }
        } else if (historyItem) {
            // console.log(`歷史記錄項 "${title}" 缺少 vod_id 或 sourceName，無法重新整理劇集列表。將使用已儲存的劇集。`);
            showToast('無法同步劇集列表，使用快取資料', 'info');
        }


        // 如果在歷史記錄中沒找到，嘗試使用上一個會話的集數資料
        if (episodesList.length === 0) {
            try {
                const storedEpisodes = JSON.parse(localStorage.getItem('currentEpisodes') || '[]');
                if (storedEpisodes.length > 0) {
                    episodesList = storedEpisodes;
                    // console.log(`使用localStorage中的集數資料:`, episodesList.length);
                }
            } catch (e) {
                // console.error('解析currentEpisodes失敗:', e);
            }
        }

        // 將劇集列表儲存到localStorage，播放器頁面會讀取它
        if (episodesList.length > 0) {
            localStorage.setItem('currentEpisodes', JSON.stringify(episodesList));
            // console.log(`已將劇集列表儲存到localStorage，共 ${episodesList.length} 集`);
        }

        // 儲存當前頁面URL作為返回地址
        let currentPath;
        if (window.location.pathname.startsWith('/player.html') || window.location.pathname.startsWith('/watch.html')) {
            currentPath = localStorage.getItem('lastPageUrl') || '/';
        } else {
            currentPath = window.location.origin + window.location.pathname + window.location.search;
        }
        localStorage.setItem('lastPageUrl', currentPath);

        // 構造播放器URL
        let playerUrl;
        const sourceNameForUrl = historyItem ? historyItem.sourceName : (new URLSearchParams(new URL(url, window.location.origin).search)).get('source');
        const sourceCodeForUrl = historyItem ? historyItem.sourceCode || historyItem.sourceName : (new URLSearchParams(new URL(url, window.location.origin).search)).get('source_code');
        const idForUrl = historyItem ? historyItem.vod_id : '';


        if (url.includes('player.html') || url.includes('watch.html')) {
            // console.log('檢測到巢狀播放連結，解析真實URL');
            try {
                const nestedUrl = new URL(url, window.location.origin);
                const nestedParams = nestedUrl.searchParams;
                const realVideoUrl = nestedParams.get('url') || url;

                playerUrl = `player.html?url=${encodeURIComponent(realVideoUrl)}&title=${encodeURIComponent(title)}&index=${episodeIndex}&position=${Math.floor(playbackPosition || 0)}&returnUrl=${encodeURIComponent(currentPath)}`;
                if (sourceNameForUrl) playerUrl += `&source=${encodeURIComponent(sourceNameForUrl)}`;
                if (sourceCodeForUrl) playerUrl += `&source_code=${encodeURIComponent(sourceCodeForUrl)}`;
                if (idForUrl) playerUrl += `&id=${encodeURIComponent(idForUrl)}`;


            } catch (e) {
                // console.error('解析巢狀URL出錯:', e);
                playerUrl = `player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}&index=${episodeIndex}&position=${Math.floor(playbackPosition || 0)}&returnUrl=${encodeURIComponent(currentPath)}`;
                if (sourceNameForUrl) playerUrl += `&source=${encodeURIComponent(sourceNameForUrl)}`;
                if (sourceCodeForUrl) playerUrl += `&source_code=${encodeURIComponent(sourceCodeForUrl)}`;
                if (idForUrl) playerUrl += `&id=${encodeURIComponent(idForUrl)}`;
            }
        } else {
             // This case should ideally not happen if 'url' is always a player.html link from history
            // console.warn("Playing from history with a non-player.html URL structure. This might be an issue.");
            const playUrl = new URL(url, window.location.origin);
            if (!playUrl.searchParams.has('index') && episodeIndex > 0) {
                playUrl.searchParams.set('index', episodeIndex);
            }
            playUrl.searchParams.set('position', Math.floor(playbackPosition || 0).toString());
            playUrl.searchParams.set('returnUrl', encodeURIComponent(currentPath));
            if (sourceNameForUrl) playUrl.searchParams.set('source', sourceNameForUrl);
            if (sourceCodeForUrl) playUrl.searchParams.set('source_code', sourceCodeForUrl);
            if (idForUrl) playUrl.searchParams.set('id', idForUrl);
            playerUrl = playUrl.toString();
        }

        showVideoPlayer(playerUrl);
    } catch (e) {
        // console.error('從歷史記錄播放失敗:', e);
        const simpleUrl = `player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}&index=${episodeIndex}`;
        showVideoPlayer(simpleUrl);
    }
}

// 新增觀看歷史 - 確保每個影片標題只有一條記錄
// IMPORTANT: videoInfo passed to this function should include a 'showIdentifier' property
// (ideally `${sourceName}_${vod_id}`), 'sourceName', and 'vod_id'.
function addToViewingHistory(videoInfo) {
    // 密碼保護校驗
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    try {
        const history = getViewingHistory();

        // Ensure videoInfo has a showIdentifier
        if (!videoInfo.showIdentifier) {
            if (videoInfo.sourceName && videoInfo.vod_id) {
                videoInfo.showIdentifier = `${videoInfo.sourceName}_${videoInfo.vod_id}`;
            } else {
                // Fallback if critical IDs are missing for the preferred identifier
                videoInfo.showIdentifier = (videoInfo.episodes && videoInfo.episodes.length > 0) ? videoInfo.episodes[0] : videoInfo.directVideoUrl;
                // console.warn(`addToViewingHistory: videoInfo for "${videoInfo.title}" was missing sourceName or vod_id for preferred showIdentifier. Generated fallback: ${videoInfo.showIdentifier}`);
            }
        }

        const existingIndex = history.findIndex(item =>
            item.title === videoInfo.title &&
            item.sourceName === videoInfo.sourceName &&
            item.showIdentifier === videoInfo.showIdentifier // Strict check using the determined showIdentifier
        );

        if (existingIndex !== -1) {
            // Exact match with showIdentifier: Update existing series entry
            const existingItem = history[existingIndex];
            existingItem.episodeIndex = videoInfo.episodeIndex;
            existingItem.timestamp = Date.now();
            existingItem.sourceName = videoInfo.sourceName || existingItem.sourceName;
            existingItem.sourceCode = videoInfo.sourceCode || existingItem.sourceCode;
            existingItem.vod_id = videoInfo.vod_id || existingItem.vod_id;
            existingItem.directVideoUrl = videoInfo.directVideoUrl || existingItem.directVideoUrl;
            existingItem.url = videoInfo.url || existingItem.url;
            existingItem.playbackPosition = videoInfo.playbackPosition > 10 ? videoInfo.playbackPosition : (existingItem.playbackPosition || 0);
            existingItem.duration = videoInfo.duration || existingItem.duration;

            if (videoInfo.episodes && Array.isArray(videoInfo.episodes) && videoInfo.episodes.length > 0) {
                if (!existingItem.episodes ||
                    !Array.isArray(existingItem.episodes) ||
                    existingItem.episodes.length !== videoInfo.episodes.length ||
                    !videoInfo.episodes.every((ep, i) => ep === existingItem.episodes[i])) {
                    existingItem.episodes = [...videoInfo.episodes];
                    // console.log(`更新 (addToViewingHistory) "${videoInfo.title}" 的劇集資料: ${videoInfo.episodes.length}集`);
                }
            }

            history.splice(existingIndex, 1);
            history.unshift(existingItem);
            // console.log(`更新歷史記錄 (addToViewingHistory): "${videoInfo.title}", 第 ${videoInfo.episodeIndex !== undefined ? videoInfo.episodeIndex + 1 : 'N/A'} 集`);
        } else {
            // No exact match: Add as a new entry
            const newItem = {
                ...videoInfo, // Includes the showIdentifier we ensured is present
                timestamp: Date.now()
            };

            if (videoInfo.episodes && Array.isArray(videoInfo.episodes)) {
                newItem.episodes = [...videoInfo.episodes];
            } else {
                newItem.episodes = [];
            }

            history.unshift(newItem);
            // console.log(`建立新的歷史記錄 (addToViewingHistory): "${videoInfo.title}", Episode: ${videoInfo.episodeIndex !== undefined ? videoInfo.episodeIndex + 1 : 'N/A'}`);
        }

        // 限制歷史記錄數量為50條
        const maxHistoryItems = 50;
        if (history.length > maxHistoryItems) {
            history.splice(maxHistoryItems);
        }

        // 儲存到本地儲存
        localStorage.setItem('viewingHistory', JSON.stringify(history));
    } catch (e) {
        // console.error('儲存觀看歷史失敗:', e);
    }
}

// 清空觀看歷史
function clearViewingHistory() {
    try {
        localStorage.removeItem('viewingHistory');
        loadViewingHistory(); // 重新載入空的歷史記錄
        showToast('觀看歷史已清空', 'success');
    } catch (e) {
        // console.error('清除觀看歷史失敗:', e);
        showToast('清除觀看歷史失敗', 'error');
    }
}

// 更新toggleSettings函式以處理歷史面板互動
const originalToggleSettings = toggleSettings;
toggleSettings = function(e) {
    if (e) e.stopPropagation();

    // 原始設定面板切換邏輯
    originalToggleSettings(e);

    // 如果歷史記錄面板是開啟的，則關閉它
    const historyPanel = document.getElementById('historyPanel');
    if (historyPanel && historyPanel.classList.contains('show')) {
        historyPanel.classList.remove('show');
    }
};

// 點擊外部關閉歷史面板
document.addEventListener('DOMContentLoaded', function() {
    document.addEventListener('click', function(e) {
        const historyPanel = document.getElementById('historyPanel');
        const historyButton = document.querySelector('button[onclick="toggleHistory(event)"]');

        if (historyPanel && historyButton &&
            !historyPanel.contains(e.target) &&
            !historyButton.contains(e.target) &&
            historyPanel.classList.contains('show')) {
            historyPanel.classList.remove('show');
        }
    });
});

// 清除本地儲存快取並重新整理頁面
function clearLocalStorage() {
    // 確保彈出視窗在頁面上只有一個實例
    let modal = document.getElementById('messageBoxModal');
    if (modal) {
        document.body.removeChild(modal);
    }

    // 建立彈出視窗元素
    modal = document.createElement('div');
    modal.id = 'messageBoxModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-40';

    modal.innerHTML = `
        <div class="bg-[#191919] rounded-lg p-6 max-w-md w-full max-h-[90vh] overflow-y-auto relative">
            <button id="closeBoxModal" class="absolute top-4 right-4 text-gray-400 hover:text-white text-xl">&times;</button>

            <h3 class="text-xl font-bold text-red-500 mb-4">警告</h3>

            <div class="mb-0">
                <div class="text-sm font-medium text-gray-300">確定要清除頁面快取嗎？</div>
                <div class="text-sm font-medium text-gray-300 mb-4">此功能會刪除你的觀看記錄、自定義 API 介面和 Cookie，<scan class="text-red-500 font-bold">此操作不可恢復！</scan></div>
                <div class="flex justify-end space-x-2">
                    <button id="confirmBoxModal" class="ml-2 bg-gray-600 hover:bg-gray-700 text-white px-4 py-1 rounded">確定</button>
                    <button id="cancelBoxModal" class="ml-2 bg-pink-600 hover:bg-pink-700 text-white px-4 py-1 rounded">取消</button>
                </div>
            </div>
        </div>`;

    // 新增彈出視窗到頁面
    document.body.appendChild(modal);

    // 新增事件監聽器 - 關閉按鈕
    document.getElementById('closeBoxModal').addEventListener('click', function () {
        document.body.removeChild(modal);
    });

    // 新增事件監聽器 - 確定按鈕
    document.getElementById('confirmBoxModal').addEventListener('click', function () {
        // 清除所有localStorage資料
        localStorage.clear();

        // 清除所有cookie
        const cookies = document.cookie.split(";");
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i];
            const eqPos = cookie.indexOf("=");
            const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
            document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
        }

        modal.innerHTML = `
            <div class="bg-[#191919] rounded-lg p-6 max-w-md w-full max-h-[90vh] overflow-y-auto relative">
                <button id="closeBoxModal" class="absolute top-4 right-4 text-gray-400 hover:text-white text-xl">&times;</button>

                <h3 class="text-xl font-bold text-white mb-4">提示</h3>

                <div class="mb-4">
                    <div class="text-sm font-medium text-gray-300 mb-4">頁面快取和Cookie已清除，<span id="countdown">3</span> 秒後自動重新整理本頁面。</div>
                </div>
            </div>`;

        let countdown = 3;
        const countdownElement = document.getElementById('countdown');

        const countdownInterval = setInterval(() => {
            countdown--;
            if (countdown >= 0) {
                countdownElement.textContent = countdown;
            } else {
                clearInterval(countdownInterval);
                window.location.reload();
            }
        }, 1000);
    });

    // 新增事件監聽器 - 取消按鈕
    document.getElementById('cancelBoxModal').addEventListener('click', function () {
        document.body.removeChild(modal);
    });

    // 新增事件監聽器 - 點擊彈出視窗外部關閉
    modal.addEventListener('click', function (e) {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}

// 顯示配置檔案匯入頁面
function showImportBox(fun) {
    // 確保彈出視窗在頁面上只有一個實例
    let modal = document.getElementById('showImportBoxModal');
    if (modal) {
        document.body.removeChild(modal);
    }

    // 建立彈出視窗元素
    modal = document.createElement('div');
    modal.id = 'showImportBoxModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-40';

    modal.innerHTML = `
        <div class="bg-[#191919] rounded-lg p-6 max-w-md w-full max-h-[90vh] overflow-y-auto relative">
            <button id="closeBoxModal" class="absolute top-4 right-4 text-gray-400 hover:text-white text-xl">&times;</button>

            <div class="m-4">
                <div id="dropZone" class="w-full py-9 bg-[#111] rounded-2xl border border-gray-300 gap-3 grid border-dashed">
                    <div class="grid gap-1">
                        <svg class="mx-auto" width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <g id="File">
                                <path id="icon" d="M31.6497 10.6056L32.2476 10.0741L31.6497 10.6056ZM28.6559 7.23757L28.058 7.76907L28.058 7.76907L28.6559 7.23757ZM26.5356 5.29253L26.2079 6.02233L26.2079 6.02233L26.5356 5.29253ZM33.1161 12.5827L32.3683 12.867V12.867L33.1161 12.5827ZM31.8692 33.5355L32.4349 34.1012L31.8692 33.5355ZM24.231 11.4836L25.0157 11.3276L24.231 11.4836ZM26.85 14.1026L26.694 14.8872L26.85 14.1026ZM11.667 20.8667C11.2252 20.8667 10.867 21.2248 10.867 21.6667C10.867 22.1085 11.2252 22.4667 11.667 22.4667V20.8667ZM25.0003 22.4667C25.4422 22.4667 25.8003 22.1085 25.8003 21.6667C25.8003 21.2248 25.4422 20.8667 25.0003 20.8667V22.4667ZM11.667 25.8667C11.2252 25.8667 10.867 26.2248 10.867 26.6667C10.867 27.1085 11.2252 27.4667 11.667 27.4667V25.8667ZM20.0003 27.4667C20.4422 27.4667 20.8003 27.1085 20.8003 26.6667C20.8003 26.2248 20.4422 25.8667 20.0003 25.8667V27.4667ZM23.3337 34.2H16.667V35.8H23.3337V34.2ZM7.46699 25V15H5.86699V25H7.46699ZM32.5337 15.0347V25H34.1337V15.0347H32.5337ZM16.667 5.8H23.6732V4.2H16.667V5.8ZM23.6732 5.8C25.2185 5.8 25.7493 5.81639 26.2079 6.02233L26.8633 4.56274C26.0191 4.18361 25.0759 4.2 23.6732 4.2V5.8ZM29.2539 6.70608C28.322 5.65771 27.7076 4.94187 26.8633 4.56274L26.2079 6.02233C26.6665 6.22826 27.0314 6.6141 28.058 7.76907L29.2539 6.70608ZM34.1337 15.0347C34.1337 13.8411 34.1458 13.0399 33.8638 12.2984L32.3683 12.867C32.5216 13.2702 32.5337 13.7221 32.5337 15.0347H34.1337ZM31.0518 11.1371C31.9238 12.1181 32.215 12.4639 32.3683 12.867L33.8638 12.2984C33.5819 11.5569 33.0406 10.9662 32.2476 10.0741L31.0518 11.1371ZM16.667 34.2C14.2874 34.2 12.5831 34.1983 11.2872 34.0241C10.0144 33.8529 9.25596 33.5287 8.69714 32.9698L7.56577 34.1012C8.47142 35.0069 9.62375 35.4148 11.074 35.6098C12.5013 35.8017 14.3326 35.8 16.667 35.8V34.2ZM5.86699 25C5.86699 27.3344 5.86529 29.1657 6.05718 30.593C6.25217 32.0432 6.66012 33.1956 7.56577 34.1012L8.69714 32.9698C8.13833 32.411 7.81405 31.6526 7.64292 30.3798C7.46869 29.0839 7.46699 27.3796 7.46699 25H5.86699ZM23.3337 35.8C25.6681 35.8 27.4993 35.8017 28.9266 35.6098C30.3769 35.4148 31.5292 35.0069 32.4349 34.1012L31.3035 32.9698C30.7447 33.5287 29.9863 33.8529 28.7134 34.0241C27.4175 34.1983 25.7133 34.2 23.3337 34.2V35.8ZM32.5337 25C32.5337 27.3796 32.532 29.0839 32.3577 30.3798C32.1866 31.6526 31.8623 32.411 31.3035 32.9698L32.4349 34.1012C33.3405 33.1956 33.7485 32.0432 33.9435 30.593C34.1354 29.1657 34.1337 27.3344 34.1337 25H32.5337ZM7.46699 15C7.46699 12.6204 7.46869 10.9161 7.64292 9.62024C7.81405 8.34738 8.13833 7.58897 8.69714 7.03015L7.56577 5.89878C6.66012 6.80443 6.25217 7.95676 6.05718 9.40704C5.86529 10.8343 5.86699 12.6656 5.86699 15H7.46699ZM16.667 4.2C14.3326 4.2 12.5013 4.1983 11.074 4.39019C9.62375 4.58518 8.47142 4.99313 7.56577 5.89878L8.69714 7.03015C9.25596 6.47133 10.0144 6.14706 11.2872 5.97592C12.5831 5.8017 14.2874 5.8 16.667 5.8V4.2ZM23.367 5V10H24.967V5H23.367ZM28.3337 14.9667H33.3337V13.3667H28.3337V14.9667ZM23.367 10C23.367 10.7361 23.3631 11.221 23.4464 11.6397L25.0157 11.3276C24.9709 11.1023 24.967 10.8128 24.967 10H23.367ZM28.3337 13.3667C27.5209 13.3667 27.2313 13.3628 27.0061 13.318L26.694 14.8872C27.1127 14.9705 27.5976 14.9667 28.3337 14.9667V13.3667ZM23.4464 11.6397C23.7726 13.2794 25.0543 14.5611 26.694 14.8872L27.0061 13.318C26.0011 13.1181 25.2156 12.3325 25.0157 11.3276L23.4464 11.6397ZM11.667 22.4667H25.0003V20.8667H11.667V22.4667ZM11.667 27.4667H20.0003V25.8667H11.667V27.4667ZM32.2476 10.0741L29.2539 6.70608L28.058 7.76907L31.0518 11.1371L32.2476 10.0741Z" fill="#DB2777" />
                            </g>
                        </svg>
                    </div>
                    <div class="grid gap-2">
                        <h4 class="text-center text-white-900 text-sm font-medium leading-snug">將配置檔案拖到此處，或手動選擇檔案</h4>
                    <div class="flex items-center justify-center gap-2">
                        <label>
                            <input type="file" id="ChooseFile" hidden />
                            <div class="flex w-28 h-9 px-2 flex-col bg-pink-600 rounded-full shadow text-white text-xs font-semibold leading-4 items-center justify-center cursor-pointer focus:outline-none">選擇檔案</div>
                        </label>
                        <button onclick="importConfigFromUrl()" class="flex w-28 h-9 px-2 flex-col bg-blue-600 rounded-full shadow text-white text-xs font-semibold leading-4 items-center justify-center cursor-pointer focus:outline-none">從URL匯入</button>
                    </div>
                    </div>
                </div>
            </div>
        </div>`;

    // 新增彈出視窗到頁面
    document.body.appendChild(modal);

    // 新增事件監聽器 - 關閉按鈕
    document.getElementById('closeBoxModal').addEventListener('click', function () {
        document.body.removeChild(modal);
    });

    // 新增事件監聽器 - 點擊彈出視窗外部關閉
    modal.addEventListener('click', function (e) {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });

    // 新增事件監聽器 - 拖拽檔案
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('ChooseFile');

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('border-blue-500');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('border-blue-500');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        fun(e.dataTransfer.files[0]);
    });

    fileInput.addEventListener('change', (e) => {
        fun(fileInput.files[0]);
    });
}
