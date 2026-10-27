export type AIProvider = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  redirect?: RequestRedirect;
};
export type AITransport = (url: string, init: RequestInit) => Promise<Response>;

// Never expose upstream response text: providers can echo credentials or user input.
export async function chatCompletion(
  config: AIProvider,
  messages: { role: string; content: string }[],
  transport: AITransport = fetch,
) {
  if (!config.apiKey) throw new Error("请先填写个人 API Key");
  if (!config.model.trim()) throw new Error("请先填写模型名称");
  const hostname = new URL(config.baseUrl).hostname;
  const mimo = [
    "api.xiaomimimo.com",
    "token-plan-cn.xiaomimimo.com",
    "token-plan-sgp.xiaomimimo.com",
    "token-plan-ams.xiaomimimo.com",
  ].includes(hostname);
  try {
    const response = await transport(
      config.baseUrl.replace(/\/$/, "") + "/chat/completions",
      {
        method: "POST",
        redirect: config.redirect ?? "manual",
        headers: {
          "Content-Type": "application/json",
          ...(mimo
            ? { "api-key": config.apiKey }
            : { Authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          ...(hostname === "api.deepseek.com"
            ? { thinking: { type: "disabled" } }
            : {}),
          ...(mimo
            ? { max_completion_tokens: 1800, thinking: { type: "disabled" } }
            : { max_tokens: 1800 }),
        }),
        signal: AbortSignal.timeout(45000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      const reason =
        response.status === 401
          ? "密钥无效或与当前服务地址不匹配"
          : response.status === 403
            ? "服务拒绝访问，请检查账号、订阅或地区权限"
            : response.status === 404
              ? "接口路径或模型不存在，请核对 Base URL 和模型名称"
              : response.status === 429
                ? "服务额度不足或请求过于频繁"
                : response.status >= 300 && response.status < 400
                  ? "服务返回重定向，请填写最终 API 地址"
                  : response.status === 400 || response.status === 422
                    ? "服务不接受请求，请核对模型名称及该模型的接口兼容性"
                    : "上游服务暂时异常";
      throw new Error(`AI 调用失败：HTTP ${response.status}，${reason}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("AI 返回空响应");
    let text = "",
      size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw new Error("AI 响应过大");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("AI 返回非 JSON 响应，请检查 API 地址");
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim())
      throw new Error("AI 未返回文字内容，请检查模型或输出 token 配额");
    if (content.length > 30000) throw new Error("AI 响应过大");
    return content;
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error("AI 网络连接失败，请检查服务地址、DNS 或服务可用性");
    if (
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
    )
      throw new Error("AI 请求超时（45 秒），请稍后重试或更换模型");
    throw error;
  }
}
