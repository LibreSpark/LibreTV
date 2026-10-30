FROM node:lts-alpine

LABEL maintainer="LibreTV Team"
LABEL description="LibreTV - 免費線上影片搜尋與觀看平台"

# 設定環境變數
ENV PORT=8080
ENV CORS_ORIGIN=*
ENV DEBUG=false
ENV REQUEST_TIMEOUT=5000
ENV MAX_RETRIES=2
ENV CACHE_MAX_AGE=1d

# 設定工作目錄
WORKDIR /app

# 複製 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安裝依賴
RUN npm ci --only=production && npm cache clean --force

# 複製應用檔案
COPY . .

# 暴露埠
EXPOSE 8080

# 健康檢查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# 啟動應用
CMD ["npm", "start"]
