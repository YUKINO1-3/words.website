import { test } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion } from "../packages/shared/ai-client.ts";

test("MiMo Token Plan uses official api-key authentication and completion token parameter", async () => {
  const content = await chatCompletion(
    {
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      apiKey: "fixture-key",
      model: "fixture-model",
    },
    [{ role: "user", content: "Reply OK" }],
    async (_, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("api-key"), "fixture-key");
      assert.equal(headers.get("authorization"), null);
      assert.equal(init?.redirect, "manual");
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.max_completion_tokens, 1800);
      assert.equal(payload.max_tokens, undefined);
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    },
  );
  assert.equal(content, "OK");
});

test("DeepSeek keeps Bearer auth and reports actionable failures without upstream secrets", async () => {
  const config = {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "fixture-secret",
    model: "deepseek-flash",
  };
  await chatCompletion(
    config,
    [{ role: "user", content: "OK" }],
    async (_, init) => {
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer fixture-secret",
      );
      assert.equal(new Headers(init.headers).get("api-key"), null);
      assert.equal(JSON.parse(String(init.body)).max_tokens, 1800);
      assert.equal(JSON.parse(String(init.body)).thinking.type, "disabled");
      return Response.json({ choices: [{ message: { content: "OK" } }] });
    },
  );
  for (const [status, reason] of [
    [401, "密钥"],
    [403, "权限"],
    [404, "模型"],
    [429, "额度"],
    [500, "异常"],
    [302, "重定向"],
  ] as const) {
    await assert.rejects(
      chatCompletion(
        config,
        [],
        async () => new Response("fixture-secret", { status }),
      ),
      (e) =>
        e instanceof Error &&
        e.message.includes(String(status)) &&
        e.message.includes(reason) &&
        !e.message.includes("fixture-secret"),
    );
  }
  await assert.rejects(
    chatCompletion(config, [], async () =>
      Response.json({
        choices: [{ message: { content: "", reasoning_content: "thinking" } }],
      }),
    ),
    /未返回文字/,
  );
  await assert.rejects(
    chatCompletion(config, [], async () => new Response("<html>error</html>")),
    /非 JSON/,
  );
  await assert.rejects(
    chatCompletion(config, [], async () => {
      throw new TypeError("secret");
    }),
    /网络连接失败/,
  );
  await assert.rejects(
    chatCompletion(config, [], async () => {
      throw new DOMException("secret", "TimeoutError");
    }),
    /超时/,
  );
});

test("connection probe uses current inputs, saved key only for same origin, and never saves or requires AI enabled", async () => {
  const { testAIConnection } = await import("../apps/worker/ai.ts");
  const calls: string[] = [];
  const auth = {
    throttle: async (key: string) => {
      calls.push(key);
    },
    config: async () => ({
      baseUrl: "https://api.deepseek.com/v1",
      model: "saved-model",
      apiKey: "saved-secret",
    }),
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (_, init) => {
    assert.equal(init?.redirect, "follow");
    assert.equal(JSON.parse(String(init?.body)).model, "deepseek-flash");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer saved-secret",
    );
    return Response.json({ choices: [{ message: { content: "OK" } }] });
  };
  try {
    const result = await testAIConnection(
      auth as any,
      {} as any,
      12,
      { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, []);
    await assert.rejects(
      testAIConnection(
        auth as any,
        {} as any,
        12,
        { baseUrl: "https://api.openai.com/v1", model: "gpt-test" },
      ),
      /重新输入/,
    );
    for (let i = 0; i < 7; i++) {
      assert.equal(
        (
          await testAIConnection(auth as any, {} as any, 12, {
            baseUrl: "http://localhost:8080/v1",
            model: "deepseek-flash",
            apiKey: "saved-secret",
          })
        ).ok,
        true,
      );
    }
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = original;
  }
});
