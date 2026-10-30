// 密碼保護功能

/**
 * 檢查是否設定了密碼保護
 * 透過讀取頁面上嵌入的環境變數來檢查
 */
function isPasswordProtected() {
    // 只檢查普通密碼
    const pwd = window.__ENV__ && window.__ENV__.PASSWORD;
    
    // 檢查普通密碼是否有效
    return typeof pwd === 'string' && pwd.length === 64 && !/^0+$/.test(pwd);
}

/**
 * 檢查是否強制要求設定密碼
 * 如果沒有設定有效的 PASSWORD，則認為需要強制設定密碼
 * 為了安全考慮，所有部署都必須設定密碼
 */
function isPasswordRequired() {
    return !isPasswordProtected();
}

/**
 * 強制密碼保護檢查 - 防止繞過
 * 在關鍵操作前都應該呼叫此函式
 */
function ensurePasswordProtection() {
    if (isPasswordRequired()) {
        showPasswordModal();
        throw new Error('Password protection is required');
    }
    if (isPasswordProtected() && !isPasswordVerified()) {
        showPasswordModal();
        throw new Error('Password verification required');
    }
    return true;
}

window.isPasswordProtected = isPasswordProtected;
window.isPasswordRequired = isPasswordRequired;

/**
 * 驗證使用者輸入的密碼是否正確（非同步，使用SHA-256雜湊）
 */
async function verifyPassword(password) {
    try {
        const correctHash = window.__ENV__?.PASSWORD;
        if (!correctHash) return false;

        const inputHash = await sha256(password);
        const isValid = inputHash === correctHash;

        if (isValid) {
            localStorage.setItem(PASSWORD_CONFIG.localStorageKey, JSON.stringify({
                verified: true,
                timestamp: Date.now(),
                passwordHash: correctHash
            }));
        }
        return isValid;
    } catch (error) {
        console.error('驗證密碼時出錯:', error);
        return false;
    }
}

// 驗證狀態檢查
function isPasswordVerified() {
    try {
        if (!isPasswordProtected()) return true;

        const stored = localStorage.getItem(PASSWORD_CONFIG.localStorageKey);
        if (!stored) return false;

        const { timestamp, passwordHash } = JSON.parse(stored);
        const currentHash = window.__ENV__?.PASSWORD;

        return timestamp && passwordHash === currentHash &&
            Date.now() - timestamp < PASSWORD_CONFIG.verificationTTL;
    } catch (error) {
        console.error('檢查密碼驗證狀態時出錯:', error);
        return false;
    }
}

// 更新全域性匯出
window.isPasswordProtected = isPasswordProtected;
window.isPasswordRequired = isPasswordRequired;
window.isPasswordVerified = isPasswordVerified;
window.verifyPassword = verifyPassword;
window.ensurePasswordProtection = ensurePasswordProtection;

// SHA-256實現，可用Web Crypto API
async function sha256(message) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
        const msgBuffer = new TextEncoder().encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // HTTP 下呼叫原始 js‑sha256
    if (typeof window._jsSha256 === 'function') {
        return window._jsSha256(message);
    }
    throw new Error('No SHA-256 implementation available.');
}

/**
 * 顯示密碼驗證彈窗
 */
function showPasswordModal() {
    const passwordModal = document.getElementById('passwordModal');
    if (passwordModal) {
        // 防止出現豆瓣區域捲軸
        document.getElementById('doubanArea').classList.add('hidden');
        document.getElementById('passwordCancelBtn').classList.add('hidden');

        // 檢查是否需要強制設定密碼
        if (isPasswordRequired()) {
            // 修改彈窗內容提示使用者需要先設定密碼
            const title = passwordModal.querySelector('h2');
            const description = passwordModal.querySelector('p');
            if (title) title.textContent = '需要設定密碼';
            if (description) description.textContent = '請先在部署平台設定 PASSWORD 環境變數來保護您的實例';
            
            // 隱藏密碼輸入框和提交按鈕，只顯示提示資訊
            const form = passwordModal.querySelector('form');
            const errorMsg = document.getElementById('passwordError');
            if (form) form.style.display = 'none';
            if (errorMsg) {
                errorMsg.textContent = '為確保安全，必須設定 PASSWORD 環境變數才能使用本服務，請聯絡管理員進行配置';
                errorMsg.classList.remove('hidden');
                errorMsg.className = 'text-red-500 mt-2 font-medium'; // 改為更醒目的紅色
            }
        } else {
            // 正常的密碼驗證模式
            const title = passwordModal.querySelector('h2');
            const description = passwordModal.querySelector('p');
            if (title) title.textContent = '訪問驗證';
            if (description) description.textContent = '請輸入密碼繼續訪問';
            
            const form = passwordModal.querySelector('form');
            if (form) form.style.display = 'block';
        }

        passwordModal.style.display = 'flex';

        // 只有在非強制設定密碼模式下才聚焦輸入框
        if (!isPasswordRequired()) {
            // 確保輸入框獲取焦點
            setTimeout(() => {
                const passwordInput = document.getElementById('passwordInput');
                if (passwordInput) {
                    passwordInput.focus();
                }
            }, 100);
        }
    }
}

/**
 * 隱藏密碼驗證彈窗
 */
function hidePasswordModal() {
    const passwordModal = document.getElementById('passwordModal');
    if (passwordModal) {
        // 隱藏密碼錯誤提示
        hidePasswordError();

        // 清空密碼輸入框
        const passwordInput = document.getElementById('passwordInput');
        if (passwordInput) passwordInput.value = '';

        passwordModal.style.display = 'none';

        // 如果啟用豆瓣區域則顯示豆瓣區域
        if (localStorage.getItem('doubanEnabled') === 'true') {
            document.getElementById('doubanArea').classList.remove('hidden');
            initDouban();
        }
    }
}

/**
 * 顯示密碼錯誤資訊
 */
function showPasswordError() {
    const errorElement = document.getElementById('passwordError');
    if (errorElement) {
        errorElement.classList.remove('hidden');
    }
}

/**
 * 隱藏密碼錯誤資訊
 */
function hidePasswordError() {
    const errorElement = document.getElementById('passwordError');
    if (errorElement) {
        errorElement.classList.add('hidden');
    }
}

/**
 * 處理密碼提交事件（非同步）
 */
async function handlePasswordSubmit() {
    const passwordInput = document.getElementById('passwordInput');
    const password = passwordInput ? passwordInput.value.trim() : '';
    if (await verifyPassword(password)) {
        hidePasswordModal();

        // 觸發密碼驗證成功事件
        document.dispatchEvent(new CustomEvent('passwordVerified'));
    } else {
        showPasswordError();
        if (passwordInput) {
            passwordInput.value = '';
            passwordInput.focus();
        }
    }
}

/**
 * 初始化密碼驗證系統
 */
function initPasswordProtection() {
    // 如果需要強制設定密碼，顯示警告彈窗
    if (isPasswordRequired()) {
        showPasswordModal();
        return;
    }
    
    // 如果設定了密碼但使用者未驗證，顯示密碼輸入框
    if (isPasswordProtected() && !isPasswordVerified()) {
        showPasswordModal();
        return;
    }
}

// 在頁面載入完成後初始化密碼保護
document.addEventListener('DOMContentLoaded', function () {
    initPasswordProtection();
});