import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Auth, type SQL } from "../apps/worker/auth.ts";
import { D1Store } from "../apps/worker/store.ts";
import { generateAI, providerURL } from "../apps/worker/ai.ts";
import { settingsSchema } from "../packages/shared/schema.ts";
import type { Env } from "../apps/worker/types.ts";

test("Cloudflare AI: personal encrypted credentials, redirects, cache without quotas, structured fields and unchanged memory state", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_initial.sql", "0002_card_identity.sql"])
    sqlite.exec(
      readFileSync(
        new URL("../database/d1-migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
  function prepare(sql: string) {
    let args: any[] = [];
    return {
      bind(...values: any[]) {
        args = values;
        return this;
      },
      async first() {
        return sqlite.prepare(sql).get(...args) || null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...args) };
      },
      async run() {
        const r = sqlite.prepare(sql).run(...args);
        return {
          success: true,
          meta: {
            changes: Number(r.changes),
            last_row_id: Number(r.lastInsertRowid),
          },
        };
      },
    };
  }
  const db = {
    prepare,
    async batch(statements: any[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as SQL;
  const secret = randomBytes(32).toString("base64"),
    auth = new Auth(db, secret),
    env = {
      AUTH_ENCRYPTION_KEY: secret,
    } as Env;
  const settings = JSON.stringify(settingsSchema.parse({ ai: true }));
  for (const id of [1, 2]) {
    sqlite
      .prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,?)")
      .run(id, "fixture_" + id, "not-used");
    sqlite
      .prepare("INSERT INTO spaces(user_id,epoch,settings) VALUES(?,?,?)")
      .run(id, crypto.randomUUID(), settings);
    sqlite
      .prepare("INSERT INTO vocabularies(id,user_id,name) VALUES(?,?,?)")
      .run(id, id, "test");
  }
  const initial = await new D1Store(db, 1).init();
  await initial.import(1, [{ word: "resilient", zh: "用户已有释义" }], "test");
  await initial.commit();
  const wordId = Number(
    sqlite.prepare("SELECT id FROM words WHERE user_id=1").get()!.id,
  );
  await auth.saveAI(1, {
    apiKey: "alice-private-key",
    baseUrl: "https://api.openai.com/v1",
    model: "alice-model",
  });
  await auth.saveAI(2, {
    apiKey: "bob-private-key",
    baseUrl: "https://api.openai.com/v1",
    model: "bob-model",
  });
  const fields = {
    zh: "有韧性",
    pos: "adj. 形容词",
    example: "She is resilient.",
    translation: "她很坚韧。",
    usage: "形容恢复能力强。",
    en: "Able to recover.",
    phonetic: "",
  };
  let requests = 0;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, options) => {
      requests++;
      assert.equal(String(input), "https://api.openai.com/v1/chat/completions");
      assert.equal(options!.redirect, "follow");
      assert.equal(
        (options!.headers as Record<string, string>).Authorization,
        "Bearer alice-private-key",
      );
      assert.equal(JSON.parse(String(options!.body)).model, "alice-model");
      return Response.json({
        choices: [{ message: { content: JSON.stringify(fields) } }],
      });
    };
    const before = sqlite
      .prepare("SELECT * FROM cards WHERE user_id=1 AND word_id=?")
      .get(wordId);
    const generate = () =>
      new D1Store(db, 1)
        .init()
        .then((store) =>
          generateAI(store, auth, env, { wordId, kind: "word-fields" }),
        );
    const first = await generate();
    assert.deepEqual(first.fields, fields);
    assert.equal(first.cached, false);
    assert.equal(requests, 1);
    assert.equal((await generate()).cached, true);
    assert.equal(requests, 1);
    assert.equal(
      sqlite
        .prepare("SELECT count(*) n FROM ai_generation_cache WHERE user_id=2")
        .get()!.n,
      0,
    );
    const save = await new D1Store(db, 1).init();
    const enriched = await save.enrich(wordId, "resilient", first.fields);
    await save.commit();
    assert.equal(enriched.zh, "用户已有释义");
    assert.equal(enriched.usage, fields.usage);
    assert.ok(JSON.parse(enriched.ai_fields).includes("usage"));
    assert.deepEqual(
      sqlite
        .prepare("SELECT * FROM cards WHERE user_id=1 AND word_id=?")
        .get(wordId),
      before,
    );
    // Saving enrichment keeps the word-only structured cache stable.
    assert.equal((await generate()).cached, true);
    sqlite.prepare("DELETE FROM ai_generation_cache WHERE user_id=1").run();
    // Even an exhausted legacy quota must not block immediate fresh requests.
    sqlite
      .prepare(
        "INSERT INTO ai_usage(user_id,day,count,last_at) VALUES(?,?,30,?)",
      )
      .run(1, initial.day(), Date.now());
    assert.equal((await generate()).cached, false);
    for (let i = 0; i < 31; i++) {
      sqlite.prepare("DELETE FROM ai_generation_cache WHERE user_id=1").run();
      assert.equal((await generate()).cached, false);
    }
    assert.equal(
      sqlite.prepare("SELECT count FROM ai_usage WHERE user_id=1").get()!.count,
      30,
    );
    assert.equal((await auth.config(2)).configured, true);
    assert.ok(
      !JSON.stringify(await auth.config(1)).includes("alice-private-key"),
    );
    assert.ok(
      !String(
        sqlite.prepare("SELECT ai_key FROM users WHERE id=1").get()!.ai_key,
      ).includes("alice-private-key"),
    );
    await auth.saveAI(1, {
      baseUrl: "https://api.openai.com/v1",
      model: "alice-model",
      clearKey: true,
    });
    assert.equal((await auth.config(1)).configured, false);
    for (const address of [
      "http://localhost:8080/v1",
      "https://custom.example:8443/v1",
      "http://169.254.169.254/v1",
    ])
      assert.equal(providerURL(address), address);
    assert.throws(() => providerURL("invalid"), /无效/);
  } finally {
    globalThis.fetch = original;
    sqlite.close();
  }
});
