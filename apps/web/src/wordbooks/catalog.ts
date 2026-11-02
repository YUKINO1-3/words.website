export type Wordbook = {
  id: string;
  title: string;
  description: string;
  count: number;
  version: string;
  sha256: string;
  file: string;
  sourceName: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  sample: string[];
};
export type Vocabulary = { id: number; name: string };
export type ImportSummary = {
  success: number;
  skipped: number;
  failed: number;
};
export type RequestAPI = (
  url: string,
  body?: unknown,
  method?: string,
) => Promise<any>;
const wordPattern = /^[a-zA-Z][a-zA-Z '’.-]*$/;
function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("已停止添加词库", "AbortError");
}
export function parseCatalog(value: unknown): Wordbook[] {
  if (!Array.isArray(value) || value.length > 30)
    throw new Error("内置词库目录格式错误");
  const seen = new Set<string>();
  return value.map((book: Wordbook) => {
    if (
      !book ||
      typeof book.id !== "string" ||
      !/^[a-z0-9-]+$/.test(book.id) ||
      seen.has(book.id) ||
      typeof book.title !== "string" ||
      !book.title ||
      book.title.length > 100 ||
      typeof book.description !== "string" ||
      book.description.length > 500 ||
      !Number.isInteger(book.count) ||
      book.count < 1 ||
      book.count > 20000 ||
      !/^[a-f0-9]{64}$/.test(book.sha256) ||
      book.file !== `/wordbooks/${book.id}.${book.sha256.slice(0, 12)}.json` ||
      typeof book.version !== "string" ||
      typeof book.sourceName !== "string" ||
      typeof book.license !== "string" ||
      !/^https:\/\//.test(book.sourceUrl) ||
      !/^https:\/\//.test(book.licenseUrl) ||
      !Array.isArray(book.sample) ||
      book.sample.some((word) => typeof word !== "string" || word.length > 160)
    )
      throw new Error("内置词库目录格式错误，请刷新后重试");
    seen.add(book.id);
    return book;
  });
}
export function parseWordbook(value: unknown, book: Wordbook): string[][] {
  if (!Array.isArray(value) || value.length !== book.count)
    throw new Error("词库条数不匹配，请刷新后重试");
  const seen = new Set<string>();
  return value.map((row) => {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== "string" ||
      typeof row[1] !== "string" ||
      row[0].length > 160 ||
      !wordPattern.test(row[0]) ||
      !row[1].trim() ||
      row[1].length > 4000 ||
      seen.has(row[0].toLowerCase())
    )
      throw new Error("词库包含无效或重复词条，请联系维护者");
    seen.add(row[0].toLowerCase());
    return row;
  });
}
export async function fetchWordbookText(
  url: string,
  signal: AbortSignal,
  maxLength: number,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 30_000);
  try {
    abortIfNeeded(signal);
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("词库下载失败，请稍后重试");
    const text = await response.text();
    if (text.length > maxLength) throw new Error("词库文件过大");
    abortIfNeeded(signal);
    return text;
  } catch (error) {
    abortIfNeeded(signal);
    if (controller.signal.aborted) throw new Error("词库下载超时，请稍后重试");
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
export async function loadWordbook(
  book: Wordbook,
  signal: AbortSignal,
): Promise<string[][]> {
  const text = await fetchWordbookText(book.file, signal, 4 * 1024 * 1024);
  abortIfNeeded(signal);
  if (globalThis.crypto?.subtle) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text),
    );
    const actual = Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (actual !== book.sha256)
      throw new Error("词库文件校验失败，请刷新后重试");
  }
  return parseWordbook(JSON.parse(text), book);
}
export async function addWordbook(options: {
  book: Wordbook;
  rows: string[][];
  request: RequestAPI;
  signal: AbortSignal;
  onProgress: (done: number, total: number) => void;
}) {
  const { book, request, signal, onProgress } = options;
  const rows = parseWordbook(options.rows, book);
  const call: RequestAPI = async (...args) => {
    abortIfNeeded(signal);
    const result = await request(...args);
    abortIfNeeded(signal);
    return result;
  };
  const vocabularies: Vocabulary[] = await call("/vocabularies");
  let target = vocabularies.find((v) => v.name === book.title);
  if (!target) {
    try {
      target = {
        ...(await call("/vocabularies", { name: book.title })),
        name: book.title,
      };
    } catch (error) {
      abortIfNeeded(signal);
      // Another tab may have created the same library. Reuse it only if it now exists.
      target = ((await call("/vocabularies")) as Vocabulary[]).find(
        (v) => v.name === book.title,
      );
      if (!target) throw error;
    }
  }
  if (!target || !Number.isSafeInteger(target.id) || target.id < 1)
    throw new Error("目标词库无效");
  const total: ImportSummary = { success: 0, skipped: 0, failed: 0 };
  onProgress(0, rows.length);
  for (let offset = 0; offset < rows.length; offset += 1000) {
    const chunk = rows.slice(offset, offset + 1000);
    const result = await call("/import", {
      vocab: target.id,
      filename: `内置词库 ${book.id} ${book.version}`,
      mapping: ["word", "zh"],
      rows: chunk,
    });
    if (
      !result ||
      !["success", "skipped", "failed"].every(
        (key) => Number.isInteger(result[key]) && result[key] >= 0,
      ) ||
      result.success + result.skipped + result.failed !== chunk.length
    )
      throw new Error("导入结果异常，已添加的内容保留；请重新添加以补齐");
    total.success += result.success;
    total.skipped += result.skipped;
    total.failed += result.failed;
    onProgress(Math.min(offset + chunk.length, rows.length), rows.length);
    if (result.failed)
      throw new Error("部分词条未能添加，已有内容保留，请联系维护者");
  }
  return { vocabulary: target, ...total };
}
