import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Download,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { api } from "../api.ts";
import {
  addWordbook,
  loadWordbook,
  parseCatalog,
  fetchWordbookText,
  type Wordbook,
} from "./catalog.ts";
import "./wordbooks.css";
export function OfficialWordbooks({
  onAdded,
}: {
  onAdded: (vocab: number, message: string) => Promise<void>;
}) {
  const [books, setBooks] = useState<Wordbook[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [active, setActive] = useState(""),
    [progress, setProgress] = useState("");
  const [preview, setPreview] = useState<{
    id: string;
    rows: string[][];
  } | null>(null);
  const scope = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const cache = useRef(new Map<string, string[][]>());
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    fetchWordbookText("/wordbooks/catalog.json", controller.signal, 128 * 1024)
      .then((text) => parseCatalog(JSON.parse(text)))
      .then((books) => {
        if (!controller.signal.aborted) setBooks(books);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      scope.current = null;
    };
  }, []);
  async function rows(book: Wordbook, signal: AbortSignal) {
    let result = cache.current.get(book.id);
    if (!result) {
      result = await loadWordbook(book, signal);
      cache.current.set(book.id, result);
    }
    return result;
  }
  async function run(book: Wordbook, importing: boolean) {
    const signal = scope.current?.signal;
    if (!signal || signal.aborted || operation.current) return;
    operation.current = true;
    setActive(book.id);
    setError("");
    setProgress(importing ? "正在准备词库…" : "正在读取词条…");
    try {
      const data = await rows(book, signal);
      if (signal.aborted) return;
      if (!importing) {
        setPreview({ id: book.id, rows: data.slice(0, 10) });
        return;
      }
      const result = await addWordbook({
        book,
        rows: data,
        request: api,
        signal,
        onProgress: (done, total) =>
          setProgress(`已处理 ${done} / ${total} 词`),
      });
      if (!signal.aborted)
        await onAdded(
          result.vocabulary.id,
          `已添加「${book.title}」：关联 ${result.success} 词，跳过 ${result.skipped} 个重复词条。`,
        );
    } catch (e: any) {
      if (!signal.aborted)
        setError(`${e.message}。已添加的内容会保留，可以再次添加补齐。`);
    } finally {
      operation.current = false;
      if (!signal.aborted) {
        setActive("");
        setProgress("");
      }
    }
  }
  return (
    <section
      className="official-wordbooks"
      aria-labelledby="official-wordbooks-title"
    >
      <div className="section-head">
        <div>
          <h2 id="official-wordbooks-title">应用内置词库</h2>
          <p>为雅思和学术英语准备，从基础到进阶，选一套加入学习。</p>
        </div>
        <span className="pill">免上传 · 不调用 AI</span>
      </div>
      <p className="muted wordbooks-note">
        词表由项目根据开源数据整理；已有同名单词会保留原释义与学习进度，重复添加可继续补齐。
      </p>
      {loading && <p role="status">正在加载内置词库…</p>}
      {error && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      {!loading && !books.length && (
        <button className="secondary" onClick={() => location.reload()}>
          重新加载词库
        </button>
      )}
      <div className="wordbooks-grid">
        {books.map((book) => (
          <article className="panel wordbook-card" key={book.id}>
            <div className="wordbook-label">
              <BookOpen size={19} />
              <span>{book.count.toLocaleString()} 词</span>
            </div>
            <h3>{book.title}</h3>
            <p>{book.description}</p>
            <div className="wordbook-samples">
              {book.sample.slice(0, 5).map((word) => (
                <span key={word}>{word}</span>
              ))}
            </div>
            <div className="wordbook-source">
              <a href={book.sourceUrl} target="_blank" rel="noreferrer">
                {book.sourceName}
                <ExternalLink size={12} />
              </a>
              <a href={book.licenseUrl} target="_blank" rel="noreferrer">
                {book.license}
              </a>
            </div>
            <div className="button-row">
              <button
                className="primary"
                disabled={!!active}
                onClick={() => run(book, true)}
              >
                <Download size={16} />
                {active === book.id ? "处理中…" : "添加到我的词库"}
              </button>
              <button
                className="text-button"
                disabled={!!active}
                aria-expanded={preview?.id === book.id}
                onClick={() =>
                  preview?.id === book.id ? setPreview(null) : run(book, false)
                }
              >
                {preview?.id === book.id ? (
                  <ChevronUp size={15} />
                ) : (
                  <ChevronDown size={15} />
                )}
                预览
              </button>
            </div>
            {preview?.id === book.id && (
              <dl className="wordbook-preview">
                {preview.rows.map(([word, zh]) => (
                  <div key={word}>
                    <dt>{word}</dt>
                    <dd>{zh}</dd>
                  </div>
                ))}
              </dl>
            )}
          </article>
        ))}
      </div>
      {active && (
        <p className="info" role="status" aria-live="polite">
          {progress}。请停留在此页完成添加；离开页面会停止后续批次。
        </p>
      )}
      <p className="wordbooks-license">
        <a href="/wordbooks/NOTICE.txt" target="_blank" rel="noreferrer">
          数据来源与许可说明
        </a>
      </p>
    </section>
  );
}
