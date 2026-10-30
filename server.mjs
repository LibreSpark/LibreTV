import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function sha256Hash(input) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    hash.update(input);
    resolve(hash.digest('hex'));
  });
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  } else {
    content = content.replace('{{PASSWORD}}', '');
  }
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }
    
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('頁面渲染錯誤:', error);
    res.status(500).send('讀取靜態頁面失敗');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('搜尋頁面渲染錯誤:', error);
    res.status(500).send('讀取靜態頁面失敗');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 從環境變數獲取阻止的主機名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 從環境變數獲取阻止的 IP 前綴
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// 驗證代理請求的鑑權
function validateProxyAuth(req) {
  const authHash = req.query.auth;
  const timestamp = req.query.t;
  
  // 獲取伺服器端密碼雜湊
  const serverPassword = config.password;
  if (!serverPassword) {
    console.error('伺服器未設定 PASSWORD 環境變數，代理訪問被拒絕');
    return false;
  }
  
  // 使用 crypto 模組計算 SHA-256 雜湊
  const serverPasswordHash = crypto.createHash('sha256').update(serverPassword).digest('hex');
  
  if (!authHash || authHash !== serverPasswordHash) {
    console.warn('代理請求鑑權失敗：密碼雜湊不匹配');
    console.warn(`期望: ${serverPasswordHash}, 收到: ${authHash}`);
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

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    // 驗證鑑權
    if (!validateProxyAuth(req)) {
      return res.status(401).json({
        success: false,
        error: '代理訪問未授權：請檢查密碼配置或鑑權參數'
      });
    }

    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    // 安全驗證
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('無效的 URL');
    }

    log(`代理請求: ${targetUrl}`);

    // 新增請求超時和重試邏輯
    const maxRetries = config.maxRetries;
    let retries = 0;
    
    const makeRequest = async () => {
      try {
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: config.timeout,
          headers: {
            'User-Agent': config.userAgent
          }
        });
      } catch (error) {
        if (retries < maxRetries) {
          retries++;
          log(`重試請求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    // 轉發響應頭（過濾敏感頭）
    const headers = { ...response.headers };
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS || 
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');
    
    sensitiveHeaders.forEach(header => delete headers[header]);
    res.set(headers);

    // 管道傳輸響應流
    response.data.pipe(res);
  } catch (error) {
    console.error('代理請求錯誤:', error.message);
    if (error.response) {
      res.status(error.response.status || 500);
      error.response.data.pipe(res);
    } else {
      res.status(500).send(`請求失敗: ${error.message}`);
    }
  }
});

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge
}));

app.use((err, req, res, next) => {
  console.error('伺服器錯誤:', err);
  res.status(500).send('伺服器內部錯誤');
});

app.use((req, res) => {
  res.status(404).send('頁面未找到');
});

// 啟動伺服器
app.listen(config.port, () => {
  console.log(`伺服器執行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('使用者登入密碼已設定');
  } else {
    console.log('警告: 未設定 PASSWORD 環境變數，使用者將被要求設定密碼');
  }
  if (config.debug) {
    console.log('除錯模式已啟用');
    console.log('配置:', { ...config, password: config.password ? '******' : '' });
  }
});
