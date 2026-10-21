import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { root, Store } from "../apps/api/store.ts";
import { pathToFileURL } from "node:url";

test("AI structured fields can be previewed, saved, edited and restored from an older backup", async () => {
  const generated = {
    zh: "有韧性的",
    pos: "adj. 形容词",
    example: "She is resilient.",
    translation: "她很坚韧。",
    usage: "用于描述人或事物的恢复能力。",
    en: "Able to recover.",
    phonetic: "",
  };
  const { createServer } = await import("node:http");
  let completionRequest: any;
  let completionCalls = 0;
  const upstream = createServer(async (req, res) => {
    completionCalls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    completionRequest = JSON.parse(body);
    assert.match(completionRequest.messages[1].content, /JSON/);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(generated) } }],
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-fields-"));
  const server = await launch(dir, {
    AI_API_KEY: "fixture",
    AI_BASE_URL: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
  });
  try {
    await request(server.url, "/api/settings", { ai: true }, "PUT");
    await request(server.url, "/api/vocabularies", { name: "fixture" });
    await request(server.url, "/api/words", {
      vocab: 1,
      word: { word: "resilient" },
    });
    const draft = await request(server.url, "/api/ai", {
      wordId: 1,
      kind: "word-fields",
    });
    assert.equal(draft.status, 200);
    assert.deepEqual(completionRequest.thinking, { type: "disabled" });
    assert.equal(completionRequest.max_completion_tokens, 1024);
    assert.deepEqual(draft.data.fields, generated);
    assert.equal((await request(server.url, "/api/next")).data.zh, "");
    assert.equal(
      (
        await request(server.url, "/api/words/1/ai-content", {
          word: "resilient",
          fields: draft.data.fields,
        })
      ).status,
      200,
    );
    const saved = (await request(server.url, "/api/next")).data;
    assert.equal(saved.zh, generated.zh);
    assert.equal(saved.usage, generated.usage);
    assert.equal(saved.reps, 0);
    const cached = await request(server.url, "/api/ai", {
      wordId: 1,
      kind: "word-fields",
    });
    assert.equal(cached.data.cached, true);
    assert.equal(completionCalls, 1);
    await request(
      server.url,
      "/api/words/1",
      { ...saved, usage: "用户修改的用法" },
      "PUT",
    );
    const edited = (await request(server.url, "/api/next")).data;
    assert.equal(edited.usage, "用户修改的用法");
    assert.ok(!JSON.parse(edited.ai_fields).includes("usage"));
    const snapshot = await (
      await fetch(server.url + "/api/backup")
    ).arrayBuffer();
    const legacy = path.join(dir, "legacy.sqlite");
    writeFileSync(legacy, new Uint8Array(snapshot));
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(legacy);
    db.exec(
      "DROP TABLE word_enrichments; DELETE FROM migrations WHERE name='004.sql'",
    );
    db.close();
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(readFileSync(legacy))]),
      "legacy.sqlite",
    );
    assert.equal((await request(server.url, "/api/restore", form)).status, 200);
    assert.equal(
      (await request(server.url, "/api/next")).data.zh,
      generated.zh,
    );
  } finally {
    await server.stop();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

async function launch(dir: string, extra: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href,
      path.join(root, "apps/api/server.ts"),
    ],
    {
      cwd: tmpdir(),
      env: {
        ...process.env,
        PORT: "0",
        DATA_DIR: dir,
        BACKUP_DIR: path.join(dir, "backups"),
        AI_API_KEY: "",
        ...extra,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (errors += d));
  let url = "";
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50));
    url = output.match(/http:\/\/127.0.0.1:\d+/)?.[0] || "";
    if (url) break;
    if (child.exitCode !== null) throw new Error(errors + output);
  }
  if (!url) {
    child.kill();
    throw new Error("Server did not start: " + errors);
  }
  return {
    child,
    url,
    stop: async () => {
      child.kill();
      await once(child, "exit");
    },
  };
}
test("AI: OpenAI-compatible local stub, explicit opt-in, cache, rate limit and persisted quota", async () => {
  const { createServer } = await import("node:http");
  let calls = 0;
  let upstreamError = false;
  let sent: any;
  const upstream = createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    let body = "";
    for await (const chunk of req) body += chunk;
    sent = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    if (upstreamError) {
      res.statusCode = 503;
      res.end("{}");
    } else
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "这是一条测试学习建议。" } }],
        }),
      );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address() as any;
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-ai-"));
  const env = {
    AI_API_KEY: "fixture-key",
    AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    AI_MODEL: "mimo-v2.6-flash",
  };
  let server = await launch(dir, env);
  try {
    assert.equal((await request(server.url, "/api/ai", {})).status, 400);
    assert.equal(calls, 0);
    await request(server.url, "/api/settings", { ai: true }, "PUT");
    const a = await request(server.url, "/api/ai", {});
    assert.equal(a.status, 200);
    assert.equal(a.data.cached, false);
    assert.equal(sent.model, "mimo-v2.6-flash");
    assert.ok(sent.messages[1].content.includes("真实统计"));
    assert.equal((await request(server.url, "/api/ai", {})).data.cached, true);
    assert.equal(calls, 1);
    await request(server.url, "/api/vocabularies", { name: "AI fixture" });
    await request(server.url, "/api/words", {
      vocab: 1,
      word: { word: "resilient", zh: "有韧性的" },
    });
    assert.equal(
      (await request(server.url, "/api/ai", { wordId: 1 })).status,
      400,
    );
    assert.equal(calls, 1);
    await server.stop();
    server = await launch(dir, env);
    upstreamError = true;
    assert.equal(
      (await request(server.url, "/api/ai", { wordId: 1 })).status,
      400,
    );
    assert.equal(calls, 2);
    assert.equal((await request(server.url, "/api/next")).status, 200);
    const s = new Store(dir);
    s.run(
      "INSERT INTO ai_usage(day,count) VALUES(?,30) ON CONFLICT(day) DO UPDATE SET count=30",
      s.day(),
    );
    s.close();
    await server.stop();
    server = await launch(dir, env);
    const capped = await request(server.url, "/api/ai", { wordId: 1 });
    assert.match(capped.data.error, /30/);
    assert.equal(calls, 2);
    assert.ok(
      !JSON.stringify(
        (await request(server.url, "/api/settings")).data,
      ).includes("fixture-key"),
    );
  } finally {
    await server.stop();
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
async function request(
  url: string,
  route: string,
  body?: any,
  method?: string,
) {
  const response = await fetch(url + route, {
    method: method || (body ? "POST" : "GET"),
    headers:
      body instanceof FormData
        ? undefined
        : body
          ? { "Content-Type": "application/json" }
          : undefined,
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
test("HTTP: 3000-word Excel, imports, two-tab reviews, offline core, restart, backup and guarded restore", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-http-"));
  let server = await launch(dir);
  try {
    assert.equal((await fetch(server.url)).status, 200);
    const html = await (await fetch(server.url)).text();
    assert.ok(html.includes("VocabFlow AI"));
    const assets = [
      ...html.matchAll(
        /(?:src|href)="([^"]+\/assets\/[^" ]+|\/assets\/[^" ]+)"/g,
      ),
    ].map((x) => x[1]);
    assert.ok(assets.length >= 2);
    for (const asset of assets)
      assert.equal((await fetch(server.url + asset)).status, 200);
    assert.equal(
      (await request(server.url, "/api/status")).data.aiConfigured,
      false,
    );
    const v = (
      await request(server.url, "/api/vocabularies", { name: "IELTS HTTP" })
    ).data;
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("IELTS");
    sheet.addRow(["word", "zh"]);
    for (let i = 0; i < 3000; i++) {
      let n = i;
      let suffix = "";
      do {
        suffix = String.fromCharCode(97 + (n % 26)) + suffix;
        n = Math.floor(n / 26) - 1;
      } while (n >= 0);
      sheet.addRow(["vocabulary " + suffix, "测试释义 " + i]);
    }
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file)]), "ielts.xlsx");
    const preview = await request(server.url, "/api/import/preview", form);
    assert.equal(preview.status, 200);
    assert.equal(preview.data.rows.length, 3000);
    const imported = await request(server.url, "/api/import", {
      vocab: v.id,
      filename: "ielts.xlsx",
      rows: preview.data.rows,
      mapping: preview.data.mapping,
    });
    assert.equal(imported.data.success, 3000);
    for (const [filename, content] of [
      ["tiny.csv", "word,zh\nhello,你好\nhello,重复\n123,无效\n,\n"],
      ["tiny.txt", "world\nhello"],
    ]) {
      const f = new FormData();
      f.append("file", new Blob([content]), filename);
      const p = (await request(server.url, "/api/import/preview", f)).data;
      const result = (
        await request(server.url, "/api/import", {
          vocab: v.id,
          filename,
          rows: p.rows,
          mapping: p.mapping,
        })
      ).data;
      assert.equal(result.success, 1);
      assert.ok(result.skipped >= 1);
    }
    const c = (await request(server.url, "/api/next")).data;
    const payload = {
      eventId: randomUUID(),
      wordId: c.id,
      version: c.version,
      rating: 3,
      seconds: 25,
      mode: "spelling",
      correct: false,
      epoch: c.epoch,
    };
    const responses = await Promise.all([
      request(server.url, "/api/review", payload),
      request(server.url, "/api/review", payload),
    ]);
    assert.ok(responses.every((r) => r.status === 200));
    const stale = await request(server.url, "/api/review", {
      ...payload,
      eventId: randomUUID(),
    });
    assert.equal(stale.status, 400);
    const stats = (await request(server.url, "/api/stats")).data;
    assert.equal(stats.today.answers, 1);
    assert.equal(stats.today.newWords, 1);
    assert.equal(stats.answerAccuracy, 0);
    assert.equal(stats.difficult, 1);
    assert.equal((await request(server.url, "/api/ai", {})).status, 400);
    assert.equal(
      (
        await fetch(server.url + "/api/settings", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://external.example",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(server.url, "/api/import", {
          vocab: v.id,
          filename: "bad.csv",
          rows: [["a"]],
          mapping: ["unknown"],
        })
      ).status,
      400,
    );
    const beforeWords = (await request(server.url, "/api/words")).data;
    const beforeSettings = (await request(server.url, "/api/settings")).data;
    const beforeReviews = await (
      await fetch(server.url + "/api/export?type=reviews")
    ).text();
    const snapshot = await (
      await fetch(server.url + "/api/backup")
    ).arrayBuffer();
    assert.ok(snapshot.byteLength > 10000);
    const invalid = new FormData();
    invalid.append("file", new Blob(["not sqlite"]), "bad.sqlite");
    assert.equal(
      (await request(server.url, "/api/restore", invalid)).status,
      400,
    );
    assert.deepEqual(
      (await request(server.url, "/api/words")).data,
      beforeWords,
    );
    await request(server.url, "/api/settings", { nickname: "Changed" }, "PUT");
    await request(server.url, "/api/vocabularies", { name: "Temporary" });
    const restore = new FormData();
    restore.append("file", new Blob([snapshot]), "full.sqlite");
    const restored = await request(server.url, "/api/restore", restore);
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(
      (await request(server.url, "/api/words")).data,
      beforeWords,
    );
    assert.deepEqual(
      (await request(server.url, "/api/settings")).data,
      beforeSettings,
    );
    assert.equal(
      await (await fetch(server.url + "/api/export?type=reviews")).text(),
      beforeReviews,
    );
    assert.equal(
      (await request(server.url, "/api/vocabularies")).data.length,
      1,
    );
    assert.ok(
      readdirSync(path.join(dir, "backups")).some((f) =>
        f.startsWith("before-restore-"),
      ),
    );
    assert.equal(
      (await request(server.url, "/api/review", payload)).status,
      400,
    );
    await server.stop();
    server = await launch(dir);
    assert.deepEqual(
      (await request(server.url, "/api/words")).data,
      beforeWords,
    );
    assert.equal(
      (await request(server.url, "/api/stats")).data.today.answers,
      1,
    );
    assert.equal(
      (await request(server.url, "/api/status")).data.dataPath,
      path.join(dir, "vocabflow.sqlite"),
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
