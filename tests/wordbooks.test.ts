import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Store, root } from "../apps/api/store.ts";
import { wordSchema } from "../packages/shared/schema.ts";
import {
  addWordbook,
  parseCatalog,
  parseWordbook,
  loadWordbook,
  type RequestAPI,
} from "../apps/web/src/wordbooks/catalog.ts";
const publicDir = path.join(root, "apps/web/public");
const catalog = parseCatalog(
  JSON.parse(
    readFileSync(path.join(publicDir, "wordbooks/catalog.json"), "utf8"),
  ),
);
const readRows = (index: number) =>
  parseWordbook(
    JSON.parse(readFileSync(path.join(publicDir, catalog[index].file), "utf8")),
    catalog[index],
  );
test("bundled IELTS, NAWL and NGSL are complete, checksummed, unique bilingual wordbooks with attribution", () => {
  assert.deepEqual(
    catalog.map((b) => b.count),
    [5040, 957, 2809],
  );
  for (const book of catalog) {
    const data = readFileSync(path.join(publicDir, book.file));
    assert.equal(createHash("sha256").update(data).digest("hex"), book.sha256);
    const rows = parseWordbook(JSON.parse(data.toString()), book);
    for (const [word, zh] of rows) {
      assert.ok(wordSchema.safeParse({ word, zh }).success, word);
      assert.match(zh, /[\u4e00-\u9fff]/);
      assert.ok(!zh.includes("\\n"), "normalize escaped newlines");
    }
    assert.ok(book.sample.every((word) => rows.some((row) => row[0] === word)));
  }
  assert.match(
    readFileSync(path.join(publicDir, "wordbooks/NOTICE.txt"), "utf8"),
    /Browne, C., Culligan, B., and Phillips, J./,
  );
  assert.match(
    readFileSync(
      path.join(publicDir, "wordbooks/licenses/ECDICT-MIT.txt"),
      "utf8",
    ),
    /Copyright \(c\) 2025 Linwei/,
  );
  assert.match(
    readFileSync(
      path.join(publicDir, "wordbooks/licenses/CC-BY-SA-4.0.txt"),
      "utf8",
    ),
    /Attribution-ShareAlike 4.0/,
  );
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-wordbooks-")),
    store = new Store(dir);
  let calls = 0;
  const request: RequestAPI = async (url, body) => {
    if (url === "/vocabularies" && !body) return store.vocabularies();
    if (url === "/vocabularies")
      return {
        id: Number(
          store.run(
            "INSERT INTO vocabularies(name) VALUES(?)",
            (body as any).name,
          ).lastInsertRowid,
        ),
      };
    if (url === "/import") {
      calls++;
      const input = body as any;
      assert.ok(input.rows.length <= 1000);
      assert.deepEqual(input.mapping, ["word", "zh"]);
      return store.import(
        input.vocab,
        input.rows.map(([word, zh]: string[]) => ({ word, zh })),
        input.filename,
      );
    }
    throw new Error("Unexpected request " + url);
  };
  return {
    store,
    request,
    calls: () => calls,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("one-click import batches 5040 words, preserves existing meanings/FSRS, and repeated imports reuse the library", async () => {
  const f = fixture();
  try {
    const personal = Number(
      f.store.run("INSERT INTO vocabularies(name) VALUES(?)", "My CSV")
        .lastInsertRowid,
    );
    f.store.import(personal, [{ word: "ability", zh: "我的能力释义" }], "mine");
    const ability = f.store.words(personal)[0];
    f.store.review({
      eventId: randomUUID(),
      wordId: ability.id,
      version: ability.version,
      rating: 3,
      seconds: 20,
      mode: "card",
    });
    const before = f.store.one(
      "SELECT * FROM cards WHERE word_id=?",
      ability.id,
    );
    const progress: number[] = [];
    const options = {
      book: catalog[0],
      rows: readRows(0),
      request: f.request,
      signal: new AbortController().signal,
      onProgress: (done: number) => progress.push(done),
    };
    const first = await addWordbook(options);
    assert.equal(first.success, 5040);
    assert.equal(first.skipped, 0);
    assert.equal(f.calls(), 6);
    assert.equal(progress.at(-1), 5040);
    assert.equal(f.store.words(first.vocabulary.id).length, 5040);
    assert.equal(
      f.store.one("SELECT zh FROM words WHERE id=?", ability.id).zh,
      "我的能力释义",
    );
    assert.deepEqual(
      f.store.one("SELECT * FROM cards WHERE word_id=?", ability.id),
      before,
    );
    const repeated = await addWordbook(options);
    assert.equal(repeated.vocabulary.id, first.vocabulary.id);
    assert.equal(repeated.success, 0);
    assert.equal(repeated.skipped, 5040);
    assert.equal(f.store.vocabularies().length, 2);
  } finally {
    f.close();
  }
});
test("leaving the page/account stops later batches; retry reuses partial data instead of duplicating it", async () => {
  const f = fixture(),
    controller = new AbortController();
  try {
    const request: RequestAPI = async (...args) => {
      const result = await f.request(...args);
      if (args[0] === "/import") controller.abort();
      return result;
    };
    await assert.rejects(
      addWordbook({
        book: catalog[0],
        rows: readRows(0),
        request,
        signal: controller.signal,
        onProgress: () => {},
      }),
      { name: "AbortError" },
    );
    assert.equal(f.calls(), 1);
    assert.equal(f.store.words().length, 1000);
    const retried = await addWordbook({
      book: catalog[0],
      rows: readRows(0),
      request: f.request,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    assert.equal(retried.success, 4040);
    assert.equal(retried.skipped, 1000);
    assert.equal(f.store.vocabularies().length, 1);
  } finally {
    f.close();
  }
});
test("malformed catalog or data is refused; the downloaded content must match its checksum", async () => {
  assert.throws(() =>
    parseCatalog([{ ...catalog[0], file: "/../../private.json" }]),
  );
  assert.throws(() => parseCatalog([catalog[0], catalog[0]]));
  assert.throws(() =>
    parseWordbook([["invalid123", "释义"]], { ...catalog[0], count: 1 }),
  );
  assert.throws(() =>
    parseWordbook([["hello", ""]], { ...catalog[0], count: 1 }),
  );
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("[[]]");
    await assert.rejects(
      loadWordbook(catalog[0], new AbortController().signal),
      /校验失败/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
