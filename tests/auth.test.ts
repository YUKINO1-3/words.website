import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Accounts } from "../apps/api/auth.ts";
import { createApplication } from "../apps/api/server.ts";
import { Store } from "../apps/api/store.ts";
import { isPublicAddress, validateBaseUrl } from "../apps/api/provider.ts";
import { invoke } from "./helpers/in-process.ts";
const password = "correct horse battery staple";

test("accounts hash passwords, encrypt provider keys, persist/revoke sessions and fail closed on missing master key", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-accounts-"));
  let accounts = new Accounts(dir);
  try {
    const alice = await accounts.register("Alice_1", password);
    assert.equal(alice.username, "alice_1");
    const row = accounts.db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(alice.id)!;
    assert.match(String(row.password_hash), /^scrypt\$/);
    assert.ok(!String(row.password_hash).includes(password));
    await assert.rejects(accounts.register("ALICE_1", password), /已被使用/);
    await assert.rejects(accounts.register("bad name", password));
    await assert.rejects(accounts.register("weak", "short"));
    await assert.rejects(
      accounts.login("alice_1", "wrong password long enough"),
      /不正确/,
    );
    const issued = accounts.issue(alice);
    assert.equal(accounts.session(issued.token)?.user.id, alice.id);
    accounts.saveAI(alice.id, {
      apiKey: "private-key-for-alice",
      baseUrl: "https://api.example.com/v1",
      model: "alice-model",
    });
    assert.ok(
      !String(
        accounts.db.prepare("SELECT ai_key FROM users WHERE id=?").get(alice.id)
          ?.ai_key,
      ).includes("private-key"),
    );
    assert.ok(
      !JSON.stringify(accounts.publicAI(alice.id)).includes("private-key"),
    );
    accounts.close();
    accounts = new Accounts(dir);
    assert.equal(accounts.aiConfig(alice.id).apiKey, "private-key-for-alice");
    assert.ok(accounts.session(issued.token));
    await accounts.changePassword(
      alice.id,
      password,
      "a different strong password",
    );
    assert.equal(accounts.session(issued.token), undefined);
    await assert.rejects(accounts.login("alice_1", password));
    await accounts.login("alice_1", "a different strong password");
    const expired = accounts.issue(alice);
    accounts.db.prepare("UPDATE sessions SET expires_at=0").run();
    assert.equal(accounts.session(expired.token), undefined);
    accounts.close();
    unlinkSync(path.join(dir, "auth-encryption.key"));
    assert.throws(() => new Accounts(dir), /缺少 auth-encryption.key/);
    assert.ok(!existsSync(path.join(dir, "auth-encryption.key")));
  } finally {
    try {
      accounts.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Express routes enforce authentication, CSRF, tenant isolation, provider secrecy and logout", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-auth-http-"));
  process.env.AUTH_COOKIE_SECURE = "false";
  const application = createApplication(dir, path.join(dir, "backups"));
  try {
    const anonymous = await invoke(application.app, "/api/status");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.error, "请先登录");
    assert.deepEqual(
      (await invoke(application.app, "/api/auth/session")).data,
      { user: null },
    );
    for (const route of [
      "/api/backup",
      "/api/export",
      "/api/words",
      "/api/account/ai",
    ])
      assert.equal((await invoke(application.app, route)).status, 401);
    const a = await invoke(application.app, "/api/auth/register", {
      body: { username: "alice", password },
    });
    assert.equal(a.status, 201, a.raw);
    assert.match(a.headers["set-cookie"], /HttpOnly/);
    assert.match(a.headers["set-cookie"], /SameSite=Strict/);
    assert.ok(!a.headers["set-cookie"].includes("Secure"));
    const aHeaders = {
      cookie: a.headers["set-cookie"].split(";")[0],
      "x-csrf-token": a.data.csrfToken,
    };
    const b = await invoke(application.app, "/api/auth/register", {
      body: { username: "bob", password },
    });
    assert.equal(b.status, 201, b.raw);
    const bHeaders = {
      cookie: b.headers["set-cookie"].split(";")[0],
      "x-csrf-token": b.data.csrfToken,
    };
    const aCall = (route: string, body?: unknown, method?: string) =>
      invoke(application.app, route, { body, method, headers: aHeaders });
    const bCall = (route: string, body?: unknown, method?: string) =>
      invoke(application.app, route, { body, method, headers: bHeaders });
    assert.equal(
      (
        await invoke(application.app, "/api/vocabularies", {
          body: { name: "denied" },
          headers: { cookie: aHeaders.cookie },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await invoke(application.app, "/api/settings", {
          body: { ai: true },
          method: "PUT",
          headers: { ...aHeaders, origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const vocab = await aCall("/api/vocabularies", { name: "Alice private" });
    assert.equal(vocab.status, 200, vocab.raw);
    await aCall("/api/words", {
      vocab: vocab.data.id,
      word: { word: "resilient", zh: "有韧性" },
    });
    assert.equal((await aCall("/api/words")).data.length, 1);
    const vocabularyExport = await aCall("/api/export?type=vocabulary");
    assert.equal(vocabularyExport.status, 200);
    assert.match(vocabularyExport.headers["content-type"], /text\/csv/);
    assert.match(
      vocabularyExport.headers["content-disposition"],
      /vocabflow-vocabulary\.csv/,
    );
    assert.equal(
      vocabularyExport.raw,
      '\uFEFF"word","zh"\r\n"resilient","有韧性"',
    );
    const emptyExport = await bCall(
      "/api/export?type=vocabulary&userId=" + a.data.user.id,
    );
    assert.equal(emptyExport.raw, '\uFEFF"word","zh"');

    assert.deepEqual(
      (await bCall("/api/words?userId=" + a.data.user.id)).data,
      [],
    );
    assert.deepEqual((await bCall("/api/vocabularies")).data, []);
    await bCall("/api/words/1", { word: "stolen" }, "PUT");
    assert.equal((await aCall("/api/words")).data[0].word, "resilient");
    const saved = await aCall(
      "/api/account/ai",
      {
        baseUrl: "https://api.example.com/v1",
        model: "private-model",
        apiKey: "secret-alice-provider",
      },
      "PUT",
    );
    assert.equal(saved.status, 200, saved.raw);
    assert.equal(saved.data.configured, true);
    assert.ok(!saved.raw.includes("secret-alice-provider"));
    assert.equal((await bCall("/api/account/ai")).data.configured, false);
    assert.equal((await aCall("/api/status")).data.aiConfigured, true);
    assert.equal((await bCall("/api/status")).data.aiConfigured, false);
    assert.equal(
      (
        await bCall(
          "/api/account/ai",
          { baseUrl: "http://169.254.169.254", model: "bad", apiKey: "bad" },
          "PUT",
        )
      ).status,
      400,
    );
    const configDb = new Accounts(dir);
    assert.equal(
      configDb.aiConfig(a.data.user.id).apiKey,
      "secret-alice-provider",
    );
    assert.equal(configDb.aiConfig(b.data.user.id).apiKey, "");
    configDb.close();
    // Restore an Alice learning backup into Bob's space: never touches Alice or either account's credentials.
    const snapshot = await aCall("/api/backup");
    assert.equal(snapshot.status, 200, snapshot.raw.slice(0, 100));
    const boundary = "vocabflow-test-boundary";
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="learning.sqlite"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      snapshot.buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const restored = await invoke(application.app, "/api/restore", {
      body: multipart,
      headers: {
        ...bHeaders,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    assert.equal(restored.status, 200, restored.raw);
    assert.equal((await bCall("/api/words")).data[0].word, "resilient");
    assert.equal((await bCall("/api/account/ai")).data.configured, false);
    await bCall("/api/words/1", undefined, "DELETE");
    assert.equal((await aCall("/api/words")).data[0].word, "resilient");
    assert.deepEqual((await bCall("/api/words")).data, []);
    await aCall("/api/auth/logout", {});
    assert.equal((await aCall("/api/words")).status, 401);
    assert.equal((await bCall("/api/status")).status, 200);
  } finally {
    application.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy space belongs only to CLI-selected user and learning backups exclude account credentials", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-legacy-"));
  const old = new Store(dir);
  old.run("INSERT INTO vocabularies(name) VALUES(?)", "existing");
  old.import(1, [{ word: "legacy", zh: "既有词" }], "fixture");
  old.close();
  const accounts = new Accounts(dir);
  const owner = await accounts.register("owner", password);
  const visitor = await accounts.register("visitor", password);
  assert.equal(owner.legacy, 0);
  assert.equal(visitor.legacy, 0);
  accounts.claimLegacy("owner");
  assert.throws(() => accounts.claimLegacy("visitor"), /已经归属/);
  accounts.close();
  process.env.AUTH_COOKIE_SECURE = "false";
  const application = createApplication(dir, path.join(dir, "backups"));
  try {
    const login = async (username: string) => {
      const r = await invoke(application.app, "/api/auth/login", {
        body: { username, password },
      });
      assert.equal(r.status, 200, r.raw);
      return {
        cookie: r.headers["set-cookie"].split(";")[0],
        "x-csrf-token": r.data.csrfToken,
      };
    };
    const ownerHeaders = await login("owner"),
      visitorHeaders = await login("visitor");
    assert.equal(
      (await invoke(application.app, "/api/words", { headers: ownerHeaders }))
        .data[0].word,
      "legacy",
    );
    assert.deepEqual(
      (await invoke(application.app, "/api/words", { headers: visitorHeaders }))
        .data,
      [],
    );
    const snapshot = path.join(dir, "learning.sqlite");
    const store = new Store(dir);
    await store.backup(snapshot);
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) n FROM words").get()?.n, 1);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name IN ('users','sessions')",
        )
        .get()?.n,
      0,
    );
    db.close();
    assert.ok(readFileSync(path.join(dir, "auth.sqlite")).length > 0);
  } finally {
    application.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SSRF checks block private/metadata IPv4, IPv6, mapped addresses and insecure or credential-bearing URLs", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.2.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "2002:7f00:1::",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  for (const url of [
    "http://example.com/v1",
    "https://user:pass@example.com",
    "https://example.com:444",
    "https://metadata.google.internal",
    "https://127.0.0.1",
    "https://example.com?key=secret",
    "https://example.com/#test",
  ])
    assert.throws(() => validateBaseUrl(url), url);
});

test("secure cookies, password-change revocation and login/register throttles use real routes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-cookie-"));
  process.env.AUTH_COOKIE_SECURE = "true";
  const application = createApplication(dir, path.join(dir, "backups"));
  try {
    const created = await invoke(application.app, "/api/auth/register", {
      body: { username: "cookie_user", password },
    });
    assert.equal(created.status, 201);
    assert.match(created.headers["set-cookie"], /^__Host-vocabflow-session=/);
    assert.match(created.headers["set-cookie"], /; Secure/);
    const oldHeaders = {
      cookie: created.headers["set-cookie"].split(";")[0],
      "x-csrf-token": created.data.csrfToken,
    };
    const login = await invoke(application.app, "/api/auth/login", {
      body: { username: "cookie_user", password },
    });
    const secondHeaders = {
      cookie: login.headers["set-cookie"].split(";")[0],
      "x-csrf-token": login.data.csrfToken,
    };
    const changed = await invoke(application.app, "/api/auth/password", {
      method: "POST",
      body: {
        currentPassword: password,
        password: "new sufficiently long password",
      },
      headers: secondHeaders,
    });
    assert.equal(changed.status, 200, changed.raw);
    assert.equal(
      (await invoke(application.app, "/api/words", { headers: oldHeaders }))
        .status,
      401,
    );
    assert.equal(
      (await invoke(application.app, "/api/words", { headers: secondHeaders }))
        .status,
      401,
    );
    for (let i = 0; i < 10; i++)
      await invoke(application.app, "/api/auth/login", {
        body: {
          username: "cookie_user",
          password: "invalid but long password",
        },
      });
    assert.equal(
      (
        await invoke(application.app, "/api/auth/login", {
          body: {
            username: "cookie_user",
            password: "new sufficiently long password",
          },
        })
      ).status,
      429,
    );
    for (let i = 0; i < 4; i++)
      await invoke(application.app, "/api/auth/register", {
        body: { username: "bad", password: "short" },
      });
    assert.equal(
      (
        await invoke(application.app, "/api/auth/register", {
          body: { username: "extra", password },
        })
      ).status,
      429,
    );
  } finally {
    application.close();
    delete process.env.AUTH_COOKIE_SECURE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit trusted proxies keep client limits separate and ignore untrusted forwarding", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-proxy-"));
  process.env.TRUST_PROXY = "127.0.0.1,::1";
  const application = createApplication(dir, path.join(dir, "backups"));
  try {
    const attempt = (client: string, remoteAddress = "127.0.0.1") =>
      invoke(application.app, "/api/auth/register", {
        body: { username: "invalid", password: "short" },
        headers: { "x-forwarded-for": client },
        remoteAddress,
      });
    for (let i = 0; i < 5; i++)
      assert.equal((await attempt("203.0.113.1")).status, 400);
    assert.equal((await attempt("203.0.113.1")).status, 429);
    assert.equal((await attempt("203.0.113.2")).status, 400);
    for (let i = 0; i < 5; i++)
      assert.equal(
        (await attempt(`198.51.100.${i + 1}`, "203.0.113.3")).status,
        400,
      );
    assert.equal((await attempt("198.51.100.99", "203.0.113.3")).status, 429);
    const expired = await invoke(application.app, "/api/auth/logout", {
      method: "POST",
    });
    assert.equal(expired.status, 401);
    assert.equal(expired.data.code, "SESSION_REQUIRED");
  } finally {
    application.close();
    delete process.env.TRUST_PROXY;
    rmSync(dir, { recursive: true, force: true });
  }
});
