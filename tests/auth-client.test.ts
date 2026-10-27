import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../apps/web/src/api.ts";
import { getCsrfToken, setCsrfToken } from "../apps/web/src/auth-client.ts";

test("protected auth requests and downloads clear expired state but wrong passwords preserve it", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  let expired = 0;
  events.addEventListener("vocabflow-session-expired", () => expired++);
  Object.defineProperty(globalThis, "window", {
    value: events,
    configurable: true,
  });
  try {
    setCsrfToken("active-csrf");
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "密码不正确" }), { status: 401 });
    await assert.rejects(api("/auth/login", { password: "wrong" }));
    await assert.rejects(api("/auth/password", { currentPassword: "wrong" }));
    assert.equal(expired, 0);
    assert.equal(getCsrfToken(), "active-csrf");
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: "请先登录", code: "SESSION_REQUIRED" }),
        { status: 401 },
      );
    for (const route of ["/auth/logout", "/auth/password", "/backup"]) {
      setCsrfToken("expired-csrf");
      await assert.rejects(
        api(route, undefined, "GET", 1000, route === "/backup"),
      );
      assert.equal(getCsrfToken(), "");
    }
    assert.equal(expired, 3);
    globalThis.fetch = async () => new Response("sqlite backup bytes");
    const blob = await api("/backup", undefined, "GET", 1000, true);
    assert.equal(await blob.text(), "sqlite backup bytes");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    setCsrfToken("");
  }
});
