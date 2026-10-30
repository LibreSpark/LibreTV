# 貢獻指南

感謝您對 LibreTV 專案的關注！我們歡迎所有形式的貢獻，包括但不限於程式碼提交、問題報告、功能建議、文件改進等。

## 🚀 快速開始

### 開發環境要求

- Node.js 16.0 或更高版本
- Git
- 支援 ES6 的現代瀏覽器

### 本地開發設定

1. **Fork 專案**
   ```bash
   # 透過 GitHub 網頁 Fork 本專案到您的賬戶
   ```

2. **克隆倉庫**
   ```bash
   git clone https://github.com/YOUR_USERNAME/LibreTV.git
   cd LibreTV
   ```

3. **安裝依賴**
   ```bash
   npm install
   ```

4. **配置環境變數**
   ```bash
   cp .env.example .env
   # 根據需要修改 .env 檔案中的配置
   ```

5. **啟動開發伺服器**
   ```bash
   npm run dev
   ```

6. **訪問應用**
   ```
   開啟瀏覽器訪問 http://localhost:8080
   ```

## 🤝 如何貢獻

### 報告問題

如果您發現了 bug 或希望建議新功能：

1. 首先查看 [Issues](https://github.com/LibreSpark/LibreTV/issues) 確保問題尚未被報告
2. 建立新的 Issue，請包含：
   - 清晰的標題和描述
   - 重現步驟（如果是 bug）
   - 預期行為和實際行為
   - 環境資訊（瀏覽器、作業系統等）
   - 截圖或錯誤日誌（如果適用）

### 提交程式碼

1. **建立分支**
   ```bash
   git checkout -b feature/your-feature-name
   # 或
   git checkout -b fix/your-bug-fix
   ```

2. **進行開發**
   - 保持程式碼風格一致
   - 新增必要的註釋
   - 確保功能正常工作

3. **測試更改**
   ```bash
   # 確保應用正常啟動
   npm run dev
   
   # 測試各項功能
   # - 影片搜尋
   # - 影片播放
   # - 響應式設計
   # - 各種部署方式
   ```

4. **提交更改**
   ```bash
   git add .
   git commit -m "類型: 簡潔的提交資訊"
   ```

5. **推送分支**
   ```bash
   git push origin feature/your-feature-name
   ```

6. **建立 Pull Request**
   - 在 GitHub 上建立 Pull Request
   - 填寫詳細的 PR 描述
   - 等待程式碼審查

### 提交資訊格式

請使用以下格式提交程式碼：

```
類型: 簡潔的描述

詳細描述（可選）

相關 Issue: #123
```

**提交類型：**
- `feat`: 新功能
- `fix`: 修復 bug
- `docs`: 文件更新
- `style`: 程式碼格式調整
- `refactor`: 程式碼重構
- `test`: 測試相關
- `chore`: 構建過程或輔助工具的變動

**示例：**
```
feat: 新增自定義播放器控制欄

- 增加播放速度調節功能
- 最佳化進度條拖拽體驗
- 新增音量記憶功能

相關 Issue: #45
```

## 📋 程式碼規範

### JavaScript 規範

- 使用 ES6+ 語法
- 優先使用 `const`，需要重新賦值時使用 `let`
- 使用有意義的變數和函式名
- 函式名使用駝峰命名
- 常量使用大寫字母和下劃線

```javascript
// ✅ 推薦
const API_BASE_URL = 'https://api.example.com';
const searchVideos = async (keyword) => {
    // 函式實現
};

// ❌ 不推薦
var url = 'https://api.example.com';
function search(k) {
    // 函式實現
}
```

### CSS 規範

- 使用 BEM 命名方式或語義化類名
- 優先使用 CSS 變數
- 移動端優先的響應式設計
- 避免使用 `!important`

```css
/* ✅ 推薦 */
.video-player {
    --primary-color: #00ccff;
    background-color: var(--primary-color);
}

.video-player__controls {
    display: flex;
    gap: 1rem;
}

/* ❌ 不推薦 */
.player {
    background-color: #00ccff !important;
}
```

### HTML 規範

- 使用語義化標籤
- 確保可訪問性（新增適當的 aria 屬性）
- 保持良好的縮排格式

```html
<!-- ✅ 推薦 -->
<main class="video-search">
    <section class="search-form" role="search">
        <input type="search" aria-label="搜尋影片" placeholder="輸入關鍵詞">
        <button type="submit" aria-label="搜尋">搜尋</button>
    </section>
</main>

<!-- ❌ 不推薦 -->
<div class="search">
    <input type="text" placeholder="搜尋">
    <div onclick="search()">搜尋</div>
</div>
```

## 🎯 貢獻重點領域

我們特別歡迎以下方面的貢獻：

### 核心功能
- **搜尋最佳化**: 改進搜尋演算法和使用者體驗
- **播放器增強**: 新的播放器功能和控制選項
- **API 整合**: 新增新的影片源 API 支援
- **效能最佳化**: 載入速度和播放效能改進

### 使用者體驗
- **介面設計**: UI/UX 改進和現代化
- **響應式設計**: 移動端體驗最佳化
- **無障礙功能**: 提高可訪問性
- **國際化**: 多語言支援

### 技術架構
- **程式碼重構**: 提高程式碼質量和可維護性
- **安全性**: 安全漏洞修復和防護
- **部署最佳化**: 改進各平台部署流程
- **監控日誌**: 新增錯誤監控和日誌系統

### 文件和社群
- **文件完善**: API 文件、部署指南等
- **示例專案**: 整合示例和最佳實踐
- **社群建設**: 問題回答和新手指導

## 🔍 程式碼審查流程

1. **自動檢查**: PR 會觸發自動化測試
2. **程式碼審查**: 維護者會審查程式碼質量和功能
3. **反饋修改**: 根據審查意見修改程式碼
4. **合併**: 審查透過後合併到主分支

### 審查標準

- **功能完整**: 功能按預期工作
- **程式碼質量**: 遵循專案編碼規範
- **效能影響**: 不顯著影響應用效能
- **相容性**: 與現有功能相容
- **文件更新**: 必要時更新相關文件

## 🚫 注意事項

### 不接受的貢獻

- **侵權內容**: 包含版權爭議的程式碼或資源
- **惡意程式碼**: 包含病毒、後門或其他惡意功能
- **商業推廣**: 純粹的商業宣傳或廣告
- **不相關功能**: 與專案核心功能無關的特性

### 法律要求

- 確保您的貢獻不侵犯他人版權
- 提交的程式碼必須是您原創或有合法使用權
- 同意以專案相同的 MIT 許可證分發您的貢獻

## 📞 聯絡方式

如果您有任何問題或需要幫助：

- **GitHub Issues**: [報告問題或建議](https://github.com/LibreSpark/LibreTV/issues)
- **GitHub Discussions**: [參與社群討論](https://github.com/LibreSpark/LibreTV/discussions)
- **Email**: 透過 GitHub 聯絡專案維護者

## 🙏 致謝

感謝所有為 LibreTV 專案做出貢獻的開發者！您的每一份貢獻都讓這個專案變得更好。

### 貢獻者列表

我們會在專案 README 中展示所有貢獻者。您的貢獻被合併後，您的 GitHub 頭像將出現在貢獻者列表中。

---

**再次感謝您的貢獻！** 🎉

讓我們一起構建一個更好的 LibreTV！
