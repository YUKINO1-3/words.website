import { getCsrfToken, sessionExpired } from "./auth-client.ts";
export async function api(
  url: string,
  body?: unknown,
  method?: string,
  timeoutMs = 60_000,
  download = false,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (body && !(body instanceof FormData))
      headers["Content-Type"] = "application/json";
    if (getCsrfToken()) headers["X-CSRF-Token"] = getCsrfToken();
    const response = await fetch("/api" + url, {
      credentials: "same-origin",
      method: method || (body ? "POST" : "GET"),
      headers,
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
      signal: controller.signal,
    });
    if (response.ok && download) return response.blob();
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`接口返回非 JSON 响应（${response.status}）`);
    }
    if (
      response.status === 401 &&
      (result.code === "SESSION_REQUIRED" || !url.startsWith("/auth/"))
    )
      sessionExpired();
    if (!response.ok)
      throw new Error(result.error || `请求失败（${response.status}）`);
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        "请求超时，请检查启动窗口是否仍在运行；导入可能已完成，请先查看导入记录或词库，再决定是否重试。",
      );
    if (error instanceof TypeError)
      throw new Error("无法连接服务，请检查网络或稍后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
