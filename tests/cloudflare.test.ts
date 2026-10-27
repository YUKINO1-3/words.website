import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { root } from "../apps/api/store.ts";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "Cloudflare runtime + D1: isolated accounts, 1532-row CSV, concurrent reviews, encryption, sessions and CSV export",
  { timeout: 120000 },
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-cf-test-"));
    const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
    const config = path.join(dir, "wrangler.json");
    writeFileSync(
      config,
      JSON.stringify({
        name: "vocabflow-test",
        main: path.join(root, "apps/worker/index.ts"),
        compatibility_date: "2026-10-22",
        compatibility_flags: ["nodejs_compat"],
        assets: {
          directory: path.join(root, "dist"),
          binding: "ASSETS",
          not_found_handling: "single-page-application",
          run_worker_first: ["/api/*"],
        },
        d1_databases: [
          {
            binding: "DB",
            database_name: "test",
            database_id: "00000000-0000-0000-0000-000000000000",
            migrations_dir: path.join(root, "database/d1-migrations"),
          },
        ],
        vars: {
          AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        },
      }),
    );
    const env = {
      ...process.env,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
      WRANGLER_SEND_METRICS: "false",
    };
    const migration = spawnSync(
      process.execPath,
      [
        wrangler,
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--config",
        config,
        "--persist-to",
        dir,
      ],
      { env, encoding: "utf8", timeout: 30000 },
    );
    assert.equal(migration.status, 0, migration.stdout + migration.stderr);
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = (socket.address() as any).port;
    await new Promise<void>((r) => socket.close(() => r()));
    const server = spawn(
      process.execPath,
      [
        wrangler,
        "dev",
        "--local",
        "--config",
        config,
        "--persist-to",
        dir,
        "--port",
        String(port),
        "--show-interactive-dev-session=false",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    server.stdout.on("data", (x) => (logs += x));
    server.stderr.on("data", (x) => (logs += x));
    const url = `http://127.0.0.1:${port}`,
      password = "cloudflare-test-password-long";
    type Identity = { cookie: string; csrf: string };
    async function call(
      route: string,
      body?: unknown,
      method?: string,
      identity?: Identity,
      extra: Record<string, string> = {},
    ) {
      const headers: Record<string, string> = { ...extra };
      if (identity) {
        headers.Cookie = identity.cookie;
        headers["X-CSRF-Token"] = identity.csrf;
      }
      if (body !== undefined && !(body instanceof FormData))
        headers["Content-Type"] = "application/json";
      const response = await fetch(url + "/api" + route, {
        method: method || (body !== undefined ? "POST" : "GET"),
        headers,
        body:
          body === undefined
            ? undefined
            : body instanceof FormData
              ? body
              : JSON.stringify(body),
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: response.status, data, text, headers: response.headers };
    }
    try {
      for (let i = 0; i < 200 && !logs.includes("Ready on"); i++) {
        if (server.exitCode !== null) throw new Error(logs);
        await sleep(100);
      }
      assert.match(logs, /Ready on/);
      assert.equal((await call("/auth/session")).data.user, null);
      for (const route of [
        "/words",
        "/settings",
        "/stats",
        "/account/ai",
        "/export?type=vocabulary",
        "/backup",
      ])
        assert.equal((await call(route)).status, 401, route);
      const register = async (username: string) => {
        const r = await call("/auth/register", { username, password });
        assert.equal(r.status, 200, r.text);
        assert.match(r.headers.get("set-cookie")!, /HttpOnly/);
        return {
          cookie: r.headers.get("set-cookie")!.split(";")[0],
          csrf: r.data.csrfToken,
        };
      };
      const alice = await register("cf_alice"),
        bob = await register("cf_bob");
      assert.equal(
        (await call("/settings", { ai: true }, "PUT", { ...alice, csrf: "" }))
          .status,
        403,
      );
      assert.equal(
        (
          await call("/settings", undefined, "GET", alice, {
            origin: "https://evil.example",
          })
        ).status,
        403,
      );
      const vocabulary = await call(
        "/vocabularies",
        { name: "CSV migration" },
        "POST",
        alice,
      );
      assert.equal(vocabulary.status, 200, vocabulary.text);
      const vocab = vocabulary.data.id;
      const names = Array.from(
        { length: 1532 },
        (_, i) =>
          "word" +
          String.fromCharCode(
            97 + Math.floor(i / 676),
            97 + (Math.floor(i / 26) % 26),
            97 + (i % 26),
          ),
      );
      const form = new FormData();
      form.append(
        "file",
        new Blob([
          "\uFEFFword,zh\r\n" + names.map((w) => `${w},中文释义`).join("\r\n"),
        ]),
        "migration.csv",
      );
      const preview = await call("/import/preview", form, "POST", alice);
      assert.equal(preview.status, 200, preview.text);
      assert.equal(preview.data.rows.length, 1532);
      assert.deepEqual(preview.data.mapping, ["word", "zh"]);
      const excel = new FormData();
      excel.append(
        "file",
        new Blob([
          new Uint8Array(
            readFileSync(
              path.join(root, "apps/web/public/examples/vocabulary.xlsx"),
            ),
          ),
        ]),
        "sample.xlsx",
      );
      const excelPreview = await call("/import/preview", excel, "POST", alice);
      assert.equal(excelPreview.status, 200, excelPreview.text);
      assert.ok(excelPreview.data.rows.length > 0);

      const imported = await call(
        "/import",
        { vocab, filename: "migration.csv", ...preview.data },
        "POST",
        alice,
      );
      assert.equal(imported.status, 200, imported.text);
      assert.equal(imported.data.success, 1532);
      assert.equal(
        (await call("/words", undefined, "GET", alice)).data.length,
        1532,
      );
      assert.deepEqual(
        (await call("/words?userId=1", undefined, "GET", bob)).data,
        [],
      );
      assert.equal(
        (
          await call(
            "/import",
            {
              vocab,
              filename: "attack",
              rows: [["stolen", "偷取"]],
              mapping: ["word", "zh"],
            },
            "POST",
            bob,
          )
        ).status,
        400,
      );
      const csv = await call(
        "/export?type=vocabulary",
        undefined,
        "GET",
        alice,
      );
      assert.equal(csv.status, 200);
      assert.ok(csv.text.startsWith('"word","zh"\r\n'));
      assert.equal(csv.text.split("\r\n").length, 1533);
      assert.ok(!csv.text.includes("user_id"));
      assert.equal(
        (await call("/export?type=vocabulary", undefined, "GET", bob)).text,
        '"word","zh"',
      );
      const next = await call("/next", undefined, "GET", alice);
      assert.equal(next.status, 200, next.text);
      const first = {
        eventId: randomUUID(),
        wordId: next.data.id,
        version: next.data.version,
        rating: 3,
        seconds: 12,
        mode: "card",
        epoch: next.data.epoch,
      };
      const duplicate = await Promise.all([
        call("/review", first, "POST", alice),
        call("/review", first, "POST", alice),
      ]);
      duplicate.forEach((r) => assert.equal(r.status, 200, r.text));
      assert.deepEqual(duplicate[0].data, duplicate[1].data);
      const next2 = await call("/next", undefined, "GET", alice);
      const review2 = {
        ...first,
        wordId: next2.data.id,
        version: next2.data.version,
        eventId: randomUUID(),
      };
      const conflict = await Promise.all([
        call("/review", review2, "POST", alice),
        call("/review", { ...review2, eventId: randomUUID() }, "POST", alice),
      ]);
      assert.deepEqual(conflict.map((r) => r.status).sort(), [200, 409]);
      const stats = await call("/stats", undefined, "GET", alice);
      assert.equal(stats.status, 200, stats.text);
      assert.equal(stats.data.today.answers, 2);
      assert.equal(stats.data.plan.newDone, 2);
      assert.equal(stats.data.today.seconds, 24);
      assert.equal(
        (await call("/words/" + next.data.id, undefined, "DELETE", bob)).status,
        404,
      );
      const last = (await call("/words", undefined, "GET", alice)).data.at(-1);
      assert.equal(
        (await call("/words/" + last.id, undefined, "DELETE", alice)).status,
        200,
      );
      assert.equal(
        (
          await call(
            "/words",
            { vocab, word: { word: "replacement", zh: "替代" } },
            "POST",
            alice,
          )
        ).status,
        200,
      );
      const replaced = (
        await call("/words", undefined, "GET", alice)
      ).data.find((w: any) => w.word === "replacement");
      assert.equal(replaced.id, last.id, "exercise SQLite numeric ID reuse");
      assert.notEqual(replaced.card_epoch, last.card_epoch);
      assert.equal(
        (
          await call(
            "/review",
            {
              ...first,
              eventId: randomUUID(),
              wordId: last.id,
              version: last.version,
              epoch: last.card_epoch,
            },
            "POST",
            alice,
          )
        ).status,
        409,
      );
      assert.equal(
        (await call("/stats", undefined, "GET", alice)).data.plan.newDone,
        2,
      );
      const saved = await call(
        "/account/ai",
        {
          baseUrl: "https://api.openai.com/v1",
          model: "test-model",
          apiKey: "private-fixture-ai-key",
        },
        "PUT",
        alice,
      );
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.data.configured, true);
      const stored = spawnSync(
        process.execPath,
        [
          wrangler,
          "d1",
          "execute",
          "DB",
          "--local",
          "--config",
          config,
          "--persist-to",
          dir,
          "--json",
          "--command",
          "SELECT password_hash,ai_key FROM users WHERE username='cf_alice'",
        ],
        { env, encoding: "utf8", timeout: 30000 },
      );
      assert.equal(stored.status, 0, stored.stderr);
      const encrypted = JSON.parse(stored.stdout)[0].results[0];
      assert.ok(encrypted.password_hash.startsWith("scrypt-v1$"));
      assert.ok(encrypted.ai_key.length > 40);
      assert.ok(!stored.stdout.includes("private-fixture-ai-key"));
      assert.ok(!stored.stdout.includes(password));

      assert.ok(!saved.text.includes("private-fixture"));
      assert.equal(
        (await call("/account/ai", undefined, "GET", bob)).data.configured,
        false,
      );
      for (const address of [
        "https://169.254.169.254",
        "https://localhost",
        "https://attacker.example",
        "http://api.openai.com",
        "https://api.openai.com.evil.example",
      ])
        assert.equal(
          (
            await call(
              "/account/ai",
              { baseUrl: address, model: "test-model", apiKey: "fixture" },
              "PUT",
              alice,
            )
          ).status,
          200,
          address,
        );
      assert.equal(
        (await call("/backup", undefined, "GET", alice)).status,
        404,
      );
      assert.equal(
        (
          await call(
            "/auth/password",
            {
              currentPassword: "wrong-password-long",
              password: "replacement-password-long",
            },
            "POST",
            alice,
          )
        ).status,
        401,
      );
      const changed = await call(
        "/auth/password",
        { currentPassword: password, password: "replacement-password-long" },
        "POST",
        alice,
      );
      assert.equal(changed.status, 200, changed.text);
      assert.equal((await call("/words", undefined, "GET", alice)).status, 401);
      const logged = await call("/auth/login", {
        username: "CF_ALICE",
        password: "replacement-password-long",
      });
      assert.equal(logged.status, 200, logged.text);
      const identity = {
        cookie: logged.headers.get("set-cookie")!.split(";")[0],
        csrf: logged.data.csrfToken,
      };
      assert.equal(
        (await call("/auth/logout", {}, "POST", identity)).status,
        200,
      );
      assert.equal(
        (await call("/words", undefined, "GET", identity)).status,
        401,
      );
    } finally {
      const exited = once(server, "exit");
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        server.kill();
      }
      await exited;
      await rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  },
);
