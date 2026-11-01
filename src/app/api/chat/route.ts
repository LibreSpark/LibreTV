export const runtime = "nodejs";

const MAX_MESSAGES = 8;
const FETCH_SOURCES_KEEP_ROUND = 6;
const MAX_SSE_BUFFER = 1024 * 512;
const MAX_TOOL_ARGS_SIZE = 100 * 1024;
const MAX_TOOL_COUNT = 5;

const rateLimitMap = new Map<string, { count: number; lastReset: number }>();
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW = 60 * 1000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  if (rateLimitMap.size > 1000) {
    for (const [key, value] of rateLimitMap.entries()) {
      if (now - value.lastReset > RATE_LIMIT_WINDOW) rateLimitMap.delete(key);
    }
  }
  const record = rateLimitMap.get(ip);
  if (!record) {
    rateLimitMap.set(ip, { count: 1, lastReset: now });
    return true;
  }
  if (now - record.lastReset > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, lastReset: now });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count += 1;
  return true;
}

function getCorsHeaders(req: Request): Record<string, string> | null {
  const origin = req.headers.get("origin") || "";
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;

  // 未配置环境变量时：仅放行本地开发
  if (!allowedOriginsEnv) {
    if (!origin || origin.includes("localhost") || origin.includes("127.0.0.1")) {
      return {
        "Access-Control-Allow-Origin": origin || "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      };
    }
    return null;
  }

  const allowedList = allowedOriginsEnv.split(",").map((o) => o.trim());
  if (origin && allowedList.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  return null;
}

export async function OPTIONS(req: Request) {
  const corsHeaders = getCorsHeaders(req);
  if (!corsHeaders) return new Response("CORS Blocked", { status: 403 });
  return new Response(null, { headers: corsHeaders });
}

function sanitizeMessages(messages: any[]) {
  if (!Array.isArray(messages)) return [];

  const cleaned = messages
    .slice(-50)
    .filter(
      (msg) =>
        msg &&
        (msg.role === "user" || msg.role === "assistant") &&
        typeof msg.content === "string" &&
        msg.content.trim().length > 0
    )
    .map((msg) => ({
      role: msg.role,
      content: msg.content.trim().slice(0, 2000),
    }));

  return cleaned.length > MAX_MESSAGES ? cleaned.slice(-MAX_MESSAGES) : cleaned;
}

function validateToolCall(
  name: string,
  args: Record<string, any>
): { valid: boolean; msg?: string } {
  if (name === "search_movie") {
    if (
      typeof args.keyword !== "string" ||
      args.keyword.trim().length === 0 ||
      args.keyword.length > 100
    ) {
      return { valid: false, msg: "关键词为空或超长" };
    }
    return { valid: true };
  }
  if (name === "add_video_source" || name === "update_api_config") {
    if (typeof args.api_url !== "string" || args.api_url.length > 500) {
      return { valid: false, msg: "URL长度不合法" };
    }
    if (
      name === "add_video_source" &&
      (typeof args.name !== "string" || args.name.length > 30)
    ) {
      return { valid: false, msg: "源名称不合法" };
    }
    try {
      const u = new URL(args.api_url);
      if (!["http:", "https:"].includes(u.protocol)) {
        return { valid: false, msg: "协议不合法" };
      }
      if (u.username || u.password) {
        return { valid: false, msg: "禁止包含账密" };
      }
      const h = u.hostname.toLowerCase();
      if (
        h === "localhost" ||
        h === "127.0.0.1" ||
        h === "::1" ||
        h.startsWith("192.168.") ||
        h.startsWith("10.") ||
        h.startsWith("172.")
      ) {
        return { valid: false, msg: "禁止访问内网" };
      }
      return { valid: true };
    } catch {
      return { valid: false, msg: "URL格式错误" };
    }
  }
  if (name === "control_player") {
    const validActions = [
      "play",
      "pause",
      "seek_forward",
      "seek_backward",
      "volume_up",
      "volume_down",
      "fullscreen",
      "seek_to",
    ];
    if (!validActions.includes(args.action)) {
      return { valid: false, msg: "动作不合法" };
    }
    if (
      args.action === "seek_to" &&
      (typeof args.time !== "number" || !Number.isFinite(args.time))
    ) {
      return { valid: false, msg: "时间参数错误" };
    }
    return { valid: true };
  }
  if (name === "fetch_and_add_source") return { valid: true };
  return { valid: false, msg: "未知工具" };
}

export async function POST(req: Request) {
  const corsHeaders = getCorsHeaders(req);
  if (!corsHeaders) {
    return new Response(JSON.stringify({ error: "CORS Blocked" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const ip =
      process.env.TRUST_PROXY === "true"
        ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
        : req.headers.get("x-real-ip") || "unknown";
    if (!checkRateLimit(ip)) {
      return new Response(JSON.stringify({ error: "请求过于频繁" }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const MAX_PAYLOAD = 256 * 1024;
    const reader = req.body?.getReader();
    if (!reader) {
      return new Response(JSON.stringify({ error: "Empty body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let receivedLength = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedLength += value.length;
      if (receivedLength > MAX_PAYLOAD) {
        await reader.cancel();
        return new Response(JSON.stringify({ error: "请求体过大" }), {
          status: 413,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      chunks.push(value);
    }

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    } catch {
      return new Response(JSON.stringify({ error: "JSON格式错误" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!payload || typeof payload !== "object") {
      return new Response(JSON.stringify({ error: "Payload 必须为对象" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { messages, action, playerContext } = payload as {
      messages: any[];
      action?: string;
      playerContext?: string;
    };

    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "未配置 ZHIPU_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const finalMessages = sanitizeMessages(messages);

    const tools = [
      {
        type: "function",
        function: {
          name: "search_movie",
          description: "只用于搜索电影。",
          parameters: {
            type: "object",
            properties: { keyword: { type: "string" } },
            required: ["keyword"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "control_player",
          description: "控制播放器。",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string" },
              time: { type: "number" },
            },
            required: ["action"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "update_api_config",
          description: "修改本地 API 配置。",
          parameters: {
            type: "object",
            properties: { api_url: { type: "string" } },
            required: ["api_url"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "fetch_and_add_source",
          description: "当用户要求找新接口时调用。",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "add_video_source",
          description: "将选好的视频源写入系统。",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              api_url: { type: "string" },
            },
            required: ["name", "api_url"],
          },
        },
      },
    ];

    let systemPrompt = `你是 Friday 助手。能力：1. search_movie 搜片；2. control_player 控播放；3. 日常闲聊。
严禁输出废话，系统提示带[]的环境信息不要复述，严禁瞎联想旧电影。
控制播放时 seek_to 的 time 单位必须是秒（number）。`;

    if (playerContext) {
      systemPrompt += `\n【环境】${String(playerContext).slice(0, 500)}`;
    }

    let apiMessages = [{ role: "system", content: systemPrompt }, ...finalMessages];
    let finalTools = tools;
    let toolChoice: any = "auto";

    if (action === "fetch_sources") {
      let githubData: { name: string; api: string }[] = [];
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);
      try {
        const ghRes = await fetch(
          "https://raw.githubusercontent.com/gaotianliuyun/gao/master/js.json",
          { signal: controller.signal }
        );
        if (ghRes.ok) {
          const data = await ghRes.json();
          if (data && data.sites) {
            githubData = data.sites
              .filter(
                (s: any) =>
                  typeof s.name === "string" &&
                  typeof s.api === "string" &&
                  s.api.startsWith("http")
              )
              .slice(0, 10)
              .map((s: any) => ({ name: s.name, api: s.api }));
          }
        }
      } catch {
        // ignore
      } finally {
        clearTimeout(timeoutId);
      }

      if (githubData.length === 0) {
        githubData = [
          { name: "非凡资源", api: "https://cj.ffzyapi.com/api.php/provide/vod/" },
          { name: "量子资源", api: "https://cj.lziapi.com/api.php/provide/vod/" },
        ];
      }

      apiMessages = [
        { role: "system", content: "请直接调用 add_video_source。" },
        ...finalMessages.slice(-FETCH_SOURCES_KEEP_ROUND),
        { role: "user", content: `源列表：${JSON.stringify(githubData)}` },
      ];
      finalTools = tools.filter((t) => t.function.name !== "fetch_and_add_source");
      toolChoice = { type: "function", function: { name: "add_video_source" } };
    }

    const upstreamController = new AbortController();
    const onAbort = () => upstreamController.abort();
    req.signal.addEventListener("abort", onAbort);

    const response = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "glm-4-air",
          messages: apiMessages,
          tools: finalTools,
          tool_choice: toolChoice,
          stream: true,
          temperature: 0.2,
          max_tokens: 1024,
        }),
        signal: upstreamController.signal,
      }
    );

    if (!response.ok || !response.body) {
      const errText = response.body ? await response.text() : "Empty response";
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {}
      }
      req.signal.removeEventListener("abort", onAbort);
      return new Response(JSON.stringify({ error: `上游报错: ${errText}` }), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const upstreamReader = response.body!.getReader();

        let buffer = "";
        let receivedUpstreamDone = false;
        let streamInvalid = false;

        const toolCallBuffer: { name: string; arguments: string }[] = [];
        let hasToolCall = false;
        let totalToolArgsSize = 0;

        try {
          while (true) {
            const { done, value } = await upstreamReader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > MAX_SSE_BUFFER) {
              throw new Error("上游 SSE 数据块过大");
            }

            let match;
            const delimiter = /\r\n\r\n|\n\n|\r\r/;

            while ((match = delimiter.exec(buffer)) !== null) {
              const eventBlock = buffer.slice(0, match.index);
              buffer = buffer.slice(match.index + match[0].length);

              const dataMatches = eventBlock.match(/^data:\s?(.*)$/gm);
              if (!dataMatches) continue;
              const dataStr = dataMatches
                .map((m) => m.replace(/^data:\s?/, ""))
                .join("\n");

              if (dataStr === "[DONE]") {
                receivedUpstreamDone = true;
                break;
              }

              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta;

                if (delta?.tool_calls) {
                  hasToolCall = true;
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    if (!toolCallBuffer[idx]) {
                      toolCallBuffer[idx] = { name: "", arguments: "" };
                    }
                    if (tc.function?.name) {
                      toolCallBuffer[idx].name += tc.function.name;
                    }
                    if (tc.function?.arguments) {
                      toolCallBuffer[idx].arguments += tc.function.arguments;
                      totalToolArgsSize += tc.function.arguments.length;

                      const activeCount = toolCallBuffer.filter(
                        (b) => b && (b.name || b.arguments)
                      ).length;
                      if (
                        totalToolArgsSize > MAX_TOOL_ARGS_SIZE ||
                        activeCount > MAX_TOOL_COUNT
                      ) {
                        streamInvalid = true;
                        throw new Error("工具参数过多或体积过大");
                      }
                    }
                  }
                } else {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`)
                  );
                }
              } catch {
                streamInvalid = true;
                throw new Error("数据解析失败或异常");
              }
            }

            if (receivedUpstreamDone || streamInvalid) break;
          }

          if (!receivedUpstreamDone || streamInvalid) {
            throw new Error("上游异常或数据损坏，未正常完成");
          }

          if (hasToolCall) {
            let isValid = true;
            let errorMsg = "";

            const activeCalls = toolCallBuffer.filter(
              (c) => c && c.name && c.arguments
            );

            for (const call of activeCalls) {
              try {
                const args = JSON.parse(call.arguments);
                const v = validateToolCall(call.name, args);
                if (!v.valid) {
                  isValid = false;
                  errorMsg = `工具 ${call.name} 校验失败: ${v.msg}`;
                  break;
                }
              } catch {
                isValid = false;
                errorMsg = "参数 JSON 解析失败";
                break;
              }
            }

            if (isValid && activeCalls.length > 0) {
              const toolMsg = {
                choices: [
                  {
                    delta: {
                      tool_calls: activeCalls.map((c, i) => ({
                        index: i,
                        function: { name: c.name, arguments: c.arguments },
                      })),
                    },
                  },
                ],
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(toolMsg)}\n\n`)
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } else {
              const errMsg = {
                choices: [
                  {
                    delta: {
                      content: `\n[服务端拦截] ${errorMsg || "无效工具调用"}`,
                    },
                  },
                ],
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(errMsg)}\n\n`)
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
          } else {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }

          controller.close();
        } catch (err: unknown) {
          try {
            controller.error(err);
          } catch {}
        } finally {
          req.signal.removeEventListener("abort", onAbort);
          try {
            upstreamReader.releaseLock();
          } catch {}
        }
      },
      cancel() {
        upstreamController.abort();
        req.signal.removeEventListener("abort", onAbort);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...corsHeaders,
      },
    });
  } catch (err: unknown) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
