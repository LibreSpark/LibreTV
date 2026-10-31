export const runtime = "nodejs";

export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin') || '*';
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Secret',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function sanitizeMessages(rawMessages: any[]) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return [{ role: 'user', content: '你好' }];
  }
  const cleaned: any[] = [];
  let lastRole = '';
  for (const msg of rawMessages) {
    if (!msg || !msg.role || !msg.content || String(msg.content).trim() === '') continue;
    if (msg.role === lastRole && (msg.role === 'user' || msg.role === 'assistant')) {
      cleaned[cleaned.length - 1].content += '\n' + String(msg.content);
    } else {
      cleaned.push({ role: msg.role, content: String(msg.content) });
      lastRole = msg.role;
    }
  }
  if (!cleaned.some(m => m.role === 'user')) {
    cleaned.push({ role: 'user', content: '继续' });
  }
  return cleaned;
}

export async function POST(req: Request) {
  try {
    const { messages, action } = await req.json();
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "未配置 ZHIPU_API_KEY" }), { status: 500 });

    // 🚨 全局强鉴权，彻底封杀一切裸奔接口
    const agentSecret = req.headers.get('X-Agent-Secret');
    const serverSecret = process.env.AGENT_SECRET || 'default_fallback_secret_change_me';
    if (!agentSecret || agentSecret !== serverSecret) {
      return new Response(JSON.stringify({ error: "非法调用：密钥校验失败" }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    let finalMessages = sanitizeMessages(messages || []);

    if (finalMessages.length > 12) {
      const systemMsgs = finalMessages.filter((m: any) => m.role === 'system').slice(-2);
      const chatMsgs = finalMessages.filter((m: any) => m.role !== 'system').slice(-8);
      finalMessages = [...systemMsgs, ...chatMsgs];
    }

    if (action && action !== 'fetch_sources') return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });

    const tools = [
      { type: "function", function: { name: "search_movie", description: "搜索电影。", parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] } } },
      { type: "function", function: { name: "update_api_config", description: "修改全局 API 配置。", parameters: { type: "object", properties: { api_url: { type: "string" } }, required: ["api_url"] } } },
      { type: "function", function: { name: "fetch_and_add_source", description: "当用户要求找新接口、新源时调用此函数。", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "add_video_source", description: "将选好的视频源写入系统。", parameters: { type: "object", properties: { name: { type: "string" }, api_url: { type: "string" } }, required: ["name", "api_url"] } } }
    ];

    let systemPrompt = '你是管家，不要有任何废话。如果用户意图是搜电影、找片、看剧，你必须立刻调用 search_movie 工具。如果用户要求加源，立刻调用 fetch_and_add_source。绝对禁止输出“我将调用”、“好的我来帮你”之类的自然语言，直接返回工具调用！';

    if (action === 'fetch_sources') {
      let githubData = [];
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const ghRes = await fetch('https://raw.githubusercontent.com/gaotianliuyun/gao/master/js.json', { signal: controller.signal });
        if (ghRes.ok) {
          try {
            const data = await ghRes.json();
            if (data && data.sites) {
              githubData = data.sites.slice(0, 10).map((s: any) => ({ name: s.name, api: s.api }));
            }
          } catch (jsonErr) {
            console.warn("Github JSON解析失败，使用兜底数据");
          }
        }
      } catch (e) {
        console.warn("Github拉取失败，使用真实HTTPS兜底数据");
      } finally { clearTimeout(timeoutId); }

      if (githubData.length === 0) {
        githubData = [
          { name: "非凡资源", api: "https://cj.ffzyapi.com/api.php/provide/vod/" },
          { name: "量子资源", api: "https://cj.lziapi.com/api.php/provide/vod/" }
        ];
      }

      const recentChat = finalMessages.filter((m: any) => m.role !== 'system').slice(-6);
      const globalSystem = finalMessages.filter((m: any) => m.role === 'system' && !m.content.includes('系统为你抓取到'));
      finalMessages = [...globalSystem, ...recentChat,
        { role: 'system', content: `系统为你抓取到以下源列表，请立刻调用 add_video_source 挑选一个添加：${JSON.stringify(githubData)}` }
      ];
      systemPrompt = '你正在执行自动添加源的任务，必须直接调用 add_video_source，禁止输出废话。';
    }

    const finalTools = action === 'fetch_sources' ? tools.filter(t => t.function.name !== 'fetch_and_add_source') : tools;

    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ model: 'glm-4-flash', messages: [{ role: 'system', content: systemPrompt }, ...finalMessages], tools: finalTools, stream: true })
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.body) {
        try { await response.body.cancel(); } catch { /* ignore */ }
      }
      return new Response(JSON.stringify({ error: `上游报错: ${errText}` }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const errData = await response.text();
      if (response.body) {
        try { await response.body.cancel(); } catch { /* ignore */ }
      }
      return new Response(JSON.stringify({ error: `API格式错误: ${errData}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(response.body, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
