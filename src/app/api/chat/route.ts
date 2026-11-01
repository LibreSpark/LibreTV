export const runtime = "nodejs";

export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin') || '*';
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ✅ 补丁3：简易字符估算裁剪逻辑
function sanitizeMessages(rawMessages: any[]) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return [{ role: 'user', content: '你好' }];
  }
  
  const cleaned: any[] = [];
  let totalChars = 0;
  const MAX_CHARS = 6000; // 控制最大长度，防止超限

  // 从后往前遍历，保留最新消息
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i];
    if (!msg || !msg.role || !msg.content || String(msg.content).trim() === '') continue;
    
    const contentStr = String(msg.content);
    // 如果加上这条会超长，且已经有消息了，就停止
    if (totalChars + contentStr.length > MAX_CHARS && cleaned.length > 0) break;

    cleaned.unshift({ role: msg.role, content: contentStr });
    totalChars += contentStr.length;
  }

  // 合并相邻同角色消息
  const merged: any[] = [];
  let lastRole = '';
  for (const msg of cleaned) {
    if (msg.role === lastRole && (msg.role === 'user' || msg.role === 'assistant')) {
      merged[merged.length - 1].content += '\n' + String(msg.content);
    } else {
      merged.push({ role: msg.role, content: String(msg.content) });
      lastRole = msg.role;
    }
  }

  if (!merged.some(m => m.role === 'user')) {
    merged.push({ role: 'user', content: '继续' });
  }
  return merged;
}

export async function POST(req: Request) {
  try {
    // ✅ 补丁1：接收独立 playerContext
    const { messages, action, playerContext } = await req.json(); 
    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "未配置 ZHIPU_API_KEY" }), { status: 500 });

    let finalMessages = sanitizeMessages(messages || []);
    if (action && action !== 'fetch_sources') return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });

    // ✅ 补丁1：将 playerContext 安全拼接到最后一条 user 消息
    if (playerContext) {
      const lastUserMsg = finalMessages[finalMessages.length - 1];
      if (lastUserMsg && lastUserMsg.role === 'user') {
        lastUserMsg.content = `${playerContext}\n用户说：${lastUserMsg.content}`;
      }
    }

    const tools = [
      {
        "type": "function",
        "function": {
          "name": "search_movie",
          "description": "只用于搜索电影或推荐影视资源。如果用户想要看片、找资源、求推荐电影时才调用。闲聊、问天气、问常识时绝对不要调用此工具。",
          "parameters": {
            "type": "object",
            "properties": {
              "keyword": { "type": "string", "description": "电影名称或推荐类型（例如：蜘蛛侠、2026年最新电影、热门科幻片）" }
            },
            "required": ["keyword"]
          }
        }
      },
      {
        "type": "function",
        "function": {
          "name": "control_player",
          "description": "控制网页视频播放器。可以播放、暂停、快进、回退、跳转到绝对时间、调音量、全屏。",
          "parameters": {
            "type": "object",
            "properties": {
              "action": {
                "type": "string",
                "enum": ["play", "pause", "seek_forward", "seek_backward", "volume_up", "volume_down", "fullscreen", "seek_to"],
                "description": "要执行的操作"
              },
              "time": {
                "type": "number",
                "description": "当action为seek_to时必填，表示要跳转到的绝对秒数，例如80。"
              }
            },
            "required": ["action"]
          }
        }
      },
      { type: "function", function: { name: "update_api_config", description: "修改全局 API 配置。", parameters: { type: "object", properties: { api_url: { type: "string" } }, required: ["api_url"] } } },
      { type: "function", function: { name: "fetch_and_add_source", description: "当用户要求找新接口、新源时调用此函数。", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "add_video_source", description: "将选好的视频源写入系统。", parameters: { type: "object", properties: { name: { type: "string" }, api_url: { type: "string" } }, required: ["name", "api_url"] } } }
    ];

    // ✅ 补丁2：增强 Prompt，指导模型识别系统反馈
    let systemPrompt = `你是一个名叫 Friday 的全能 AI 助手，驻扎在 LibreTV 影视网站。
你有两个核心能力：
1. 【影视管家模式】：当用户想看电影、找资源、求推荐时，你必须立刻调用 search_movie 工具。提取电影名或推荐条件作为 keyword。绝对禁止反问，直接调用！
2. 【视频控制模式】：如果用户要求播放、暂停、快进、调音量、跳转到指定时间或全屏，你必须立刻调用 control_player 工具。
3. 【日常聊天模式】：如果用户问与电影无关的事情（比如"你是谁"、"今天天气"、"讲笑话"），你要像朋友一样自然回复，绝对不要调用任何工具。
【最高准则】：
- 系统会附带当前播放器的状态信息。你要根据该状态回答用户关于进度的提问。
- 只有当用户确实有对应需求时才调用工具，千万不要把闲聊当成电影名去搜。
- 请用简短、自然、流畅的口语回答，不要像机器人。
- 【注意】：如果你看到以"【内部系统执行结果"开头的消息，那是工具的执行反馈，不是用户说的话，请根据执行结果继续下一步，或者总结给用户。`;

    if (action === 'fetch_sources') {
      let githubData = [];
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);
      try {
        const ghRes = await fetch('https://raw.githubusercontent.com/gaotianliuyun/gao/master/js.json', { signal: controller.signal });
        if (ghRes.ok) {
          try {
            const data = await ghRes.json();
            if (data && data.sites) {
              githubData = data.sites.slice(0, 10).map((s: any) => ({ name: s.name, api: s.api }));
            }
          } catch (jsonErr) { console.warn("Github JSON解析失败"); }
        }
      } catch (e) { console.warn("Github拉取失败或超时，使用兜底源"); } finally { clearTimeout(timeoutId); }
      
      if (githubData.length === 0) {
        githubData = [
          { name: "非凡资源", api: "https://cj.ffzyapi.com/api.php/provide/vod/" },
          { name: "量子资源", api: "https://cj.lziapi.com/api.php/provide/vod/" }
        ];
      }
      
      const recentChat = finalMessages.filter((m: any) => m.role !== 'system').slice(-6);
      finalMessages = [...recentChat, { role: 'user', content: `系统为你抓取到以下源列表，请立刻调用 add_video_source 挑选一个添加：${JSON.stringify(githubData)}` }];
      systemPrompt = '你正在执行自动添加源的任务，必须直接调用 add_video_source，禁止输出废话。';
    }

    const finalTools = action === 'fetch_sources' ? tools.filter(t => t.function.name !== 'fetch_and_add_source') : tools;
    const apiMessages = [{ role: 'system', content: systemPrompt }, ...finalMessages];

    const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({
        model: 'glm-4-air',
        messages: apiMessages,
        tools: finalTools,
        stream: true,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.body) { try { await response.body.cancel(); } catch { /* ignore */ } }
      return new Response(JSON.stringify({ error: `上游报错: ${errText}` }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const errData = await response.text();
      if (response.body) { try { await response.body.cancel(); } catch { /* ignore */ } }
      return new Response(JSON.stringify({ error: `API格式错误: ${errData}` }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // Safari 心跳修复
    const upstreamReader = response.body!.getReader();
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const pingTimer = setInterval(() => {
          try { controller.enqueue(encoder.encode(': ping\n\n')); } catch (e) { clearInterval(pingTimer); }
        }, 750);

        try {
          while (true) {
            const { done, value } = await upstreamReader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (error) {
          controller.error(error);
        } finally {
          clearInterval(pingTimer);
          controller.close();
        }
      },
      cancel() { upstreamReader.cancel(); }
    });

    return new Response(stream, {
      headers: { 
        'Content-Type': 'text/event-stream', 
        'Cache-Control': 'no-cache', 
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
