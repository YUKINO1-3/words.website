import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  LayoutDashboard,
  Library,
  LogOut,
  Upload,
  ChartNoAxesCombined,
  Settings,
  Flame,
  Sparkles,
  ArrowUpRight,
  ArrowRight,
  Plus,
  Search,
  Volume2,
  Check,
  ChevronLeft,
  Sun,
  Moon,
  Download,
  ShieldCheck,
  Target,
  Clock,
  Leaf,
  X,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import "./style.css";
import { api } from "./api.ts";
import { AuthGate } from "./Auth.tsx";
import { createEventId } from "./event-id.ts";
type Any = Record<string, any>;
const modes = [
  ["card", "单词卡片"],
  ["choice", "英译中选择"],
  ["spelling", "中译英拼写"],
  ["listening", "听音辨词"],
  ["difficult", "错词专项"],
];
const fieldNames: Any = {
  word: "英文单词",
  zh: "中文释义",
  en: "英文释义",
  phonetic: "音标",
  pos: "词性",
  example: "英文例句",
  translation: "中文例句翻译",
  tags: "标签",
  notes: "个人备注",
};
function App({
  username,
  onLogout,
  onPasswordChanged,
}: {
  username: string;
  onLogout: () => Promise<void>;
  onPasswordChanged: (data: any) => void;
}) {
  const [page, setPage] = useState("home"),
    [stats, setStats] = useState<Any>(),
    [settings, setSettings] = useState<Any>(),
    [vocabs, setVocabs] = useState<Any[]>([]),
    [words, setWords] = useState<Any[]>([]),
    [status, setStatus] = useState<Any>({}),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [vocab, setVocab] = useState(0),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState(""),
    [editor, setEditor] = useState<Any | null>(null),
    [preview, setPreview] = useState<Any>(),
    [filename, setFilename] = useState(""),
    [mapping, setMapping] = useState<string[]>([]),
    [target, setTarget] = useState(0),
    [logs, setLogs] = useState<Any[]>([]),
    [importResult, setImportResult] = useState<Any>(),
    [card, setCard] = useState<Any | null>(null),
    [revealed, setRevealed] = useState(false),
    [mode, setMode] = useState("card"),
    [answer, setAnswer] = useState(""),
    [correct, setCorrect] = useState<boolean | null>(null),
    [options, setOptions] = useState<string[]>([]),
    [ai, setAi] = useState(""),
    [aiDraft, setAiDraft] = useState<Any | null>(null),
    [practice, setPractice] = useState(false),
    [provider, setProvider] = useState<Any>({
      baseUrl: "",
      model: "",
      configured: false,
    }),
    [providerKey, setProviderKey] = useState(""),
    [passwordForm, setPasswordForm] = useState({
      current: "",
      next: "",
      confirm: "",
    });
  const started = useRef(Date.now()),
    active = useRef(0),
    lastTick = useRef(Date.now()),
    eventId = useRef(createEventId()),
    pendingRating = useRef<number | null>(null);
  async function refresh() {
    const [s, v, se, st, aiConfig] = await Promise.all([
      api("/stats"),
      api("/vocabularies"),
      api("/settings"),
      api("/status"),
      api("/account/ai"),
    ]);
    setStats(s);
    setVocabs(v);
    setSettings(se);
    setStatus(st);
    setProvider(aiConfig);
    document.documentElement.dataset.theme = se.theme;
    return se;
  }
  async function loadWords() {
    setWords(
      await api(
        `/words?vocab=${vocab}&q=${encodeURIComponent(query)}&filter=${filter}`,
      ),
    );
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    loadWords().catch((e) => setError(e.message));
  }, [vocab, query, filter, page]);
  useEffect(() => {
    const reset = () => {
      lastTick.current = Date.now();
    };
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    const interval = setInterval(() => {
      if (
        page === "study" &&
        !document.hidden &&
        Date.now() - lastTick.current < 60000
      )
        active.current++;
    }, 1000);
    return () => {
      clearInterval(interval);
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, [page]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 5000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function go(p: string) {
    setPage(p);
    setError("");
    setAi("");
  }
  function speak(word: string) {
    const synth = window.speechSynthesis;
    if (!synth) {
      setError("当前浏览器不支持发音");
      return;
    }
    const voices = synth.getVoices().filter((v) => v.lang.startsWith("en"));
    if (!voices.length) {
      setError("没有可用的英语语音，请安装系统英语语音包；其他模式仍可使用");
      return;
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(word);
    u.voice = voices.find((v) => v.localService) || voices[0];
    u.lang = "en-US";
    u.rate = 0.85;
    u.onerror = () => setError("发音不可用，请检查系统语音设置");
    synth.speak(u);
  }
  async function nextCard(selectedMode = mode, extra = practice) {
    let c;
    if (extra) {
      const list = await api("/words?filter=difficult");
      c = list[Math.floor(Math.random() * list.length)] || null;
    } else c = await api(`/next?vocab=${vocab}`);
    setCard(c);
    setRevealed(false);
    setCorrect(null);
    setAnswer("");
    setAi("");
    eventId.current = createEventId();
    pendingRating.current = null;
    active.current = 0;
    started.current = Date.now();
    lastTick.current = Date.now();
    if (c && selectedMode === "choice") {
      const pool = await api("/words");
      const distractors = [
        ...new Set(
          pool
            .filter((w: Any) => w.zh && w.zh !== c.zh)
            .map((w: Any) => String(w.zh)),
        ),
      ]
        .sort(() => Math.random() - 0.5)
        .slice(0, 3);
      setOptions(
        c.zh && distractors.length === 3
          ? [c.zh, ...distractors].sort(() => Math.random() - 0.5)
          : [],
      );
    }
  }
  async function begin(selected = settings?.mode || "card") {
    setMode(selected);
    const extra = selected === "difficult";
    setPractice(extra);
    setPage("study");
    await nextCard(selected, extra);
  }
  async function rate(rating: number) {
    if (!card) return;
    if (practice) {
      await nextCard();
      return;
    }
    if (pendingRating.current !== null && pendingRating.current !== rating)
      throw new Error("上一评价结果尚未确认，请重试同一评价或重新加载卡片");
    pendingRating.current = rating;
    await api("/review", {
      eventId: eventId.current,
      wordId: card.id,
      version: card.version,
      rating,
      seconds: Math.min(active.current, 120),
      mode,
      correct,
      epoch: card.epoch,
    });
    await refresh();
    await nextCard();
  }
  async function askAI(wordId?: number) {
    const result = await api("/ai", { wordId });
    setAi(`AI 生成${result.cached ? " · 已缓存" : ""}\n\n${result.content}`);
  }
  async function generateFields(word: Any) {
    const result = await api("/ai", { wordId: word.id, kind: "word-fields" });
    setAiDraft({
      id: word.id,
      word: word.word,
      fields: result.fields,
      cached: result.cached,
      elapsedMs: result.elapsedMs,
    });
  }
  async function saveGeneratedFields() {
    if (!aiDraft) return;
    const updated = await api(`/words/${aiDraft.id}/ai-content`, {
      word: aiDraft.word,
      fields: aiDraft.fields,
    });
    if (card?.id === updated.id) setCard({ ...card, ...updated });
    setAiDraft(null);
    await loadWords();
    await refresh();
    setNotice("AI 资料已保存到单词，已有内容已保留");
  }
  function checkAnswer(value: string) {
    setAnswer(value);
    setCorrect(
      mode === "choice"
        ? value === card?.zh
        : value.trim().toLowerCase() === card?.word.trim().toLowerCase(),
    );
    setRevealed(true);
  }
  const nav = [
    ["home", "学习主页", LayoutDashboard],
    ["library", "我的词库", Library],
    ["import", "导入单词", Upload],
    ["plan", "今日计划", Target],
    ["difficult", "错词本", Flame],
    ["stats", "学习统计", ChartNoAxesCombined],
    ["ai", "AI 学习助手", Sparkles],
  ] as const;
  if (!settings || !stats)
    return (
      <div className="loading">
        <Leaf size={36} />
        <h2>VocabFlow AI</h2>
        <p>{error || "正在打开你的学习空间…"}</p>
        {error && <button onClick={() => location.reload()}>重试</button>}
      </div>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" onClick={() => go("home")}>
          <span className="brand-icon">
            <BookOpen size={23} />
          </span>
          <span>
            VocabFlow<span className="ai-badge">AI</span>
          </span>
        </a>
        <div className="workspace">{username} 的学习空间</div>
        <nav>
          {nav.map(([key, label, Icon]) => (
            <button
              key={key}
              className={page === key ? "nav active" : "nav"}
              onClick={() => {
                if (key === "difficult") setFilter("difficult");
                else setFilter("");
                go(key);
              }}
            >
              <Icon size={19} />
              {label}
              {key === "ai" && <span className="new-tag">可选</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav logout-button"
            aria-label="退出登录"
            title="退出登录"
            disabled={busy}
            onClick={() => action(onLogout)}
          >
            <LogOut size={19} />
            退出登录
          </button>
          <div className="local-note">
            <ShieldCheck size={18} />
            <div>
              只属于你的学习空间<small>账号隔离 · 私人空间</small>
            </div>
          </div>
          <button
            className={page === "settings" ? "nav active" : "nav"}
            onClick={() => go("settings")}
          >
            <Settings size={19} />
            设置与导出
          </button>
          <div className="profile">
            <span>{settings.nickname?.slice(0, 1) || "V"}</span>
            <div>
              {settings.nickname || "我的学习空间"}
              <small>每天进步一点点</small>
            </div>
            <button
              className="icon-button"
              title="切换主题"
              onClick={() =>
                action(async () => {
                  await api(
                    "/settings",
                    {
                      ...settings,
                      theme: settings.theme === "dark" ? "light" : "dark",
                    },
                    "PUT",
                  );
                  await refresh();
                })
              }
            >
              {settings.theme === "dark" ? (
                <Sun size={17} />
              ) : (
                <Moon size={17} />
              )}
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            我的学习空间 <span className="muted">/</span>{" "}
            <b>
              {page === "study"
                ? "专注学习"
                : page === "settings"
                  ? "设置与导出"
                  : nav.find((x) => x[0] === page)?.[1]}
            </b>
          </span>
          <div className="top-right">
            <span className="local-dot" />
            {status.storage === "d1" ? "云端同步" : "本机运行"}
            <span className="divider" />
            <Flame size={16} />
            {stats.streak} 天连续学习
          </div>
        </header>
        <div className="content">
          {error && (
            <div role="alert" className="alert error">
              {error}
              <button onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              {notice}
            </div>
          )}
          {page === "home" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">A LITTLE EVERY DAY, A LONG WAY.</div>
                  <h1>
                    {settings.nickname ? `${settings.nickname}，` : ""}
                    让每个单词，留下来<span className="green">。</span>
                  </h1>
                  <p>不必一次记住所有，只需今天再向前一步。</p>
                </div>
                <div className="date-label">
                  {new Intl.DateTimeFormat("zh-CN", {
                    dateStyle: "long",
                    timeZone: settings.timezone,
                  }).format(new Date())}
                  <small>{settings.timezone}</small>
                </div>
              </div>
              <div className="home-grid">
                <section className="hero">
                  <div className="hero-kicker">
                    <span className="tiny-dot" /> YOUR DAILY FLOW
                  </div>
                  <h2>
                    今天，和英语
                    <br />
                    再熟悉一点。
                  </h2>
                  <p>
                    智能安排复习，让记忆走得更远。
                    <br />
                    你的下一次进步，从一个单词开始。
                  </p>
                  <button
                    className="cream-button"
                    disabled={busy}
                    onClick={() => action(() => begin())}
                  >
                    开始今日学习 <ArrowRight size={19} />
                  </button>
                  <div className="hero-footer">
                    <ShieldCheck size={15} />由 FSRS 记忆算法安排 · 目标保持率{" "}
                    {Math.round(settings.retention * 100)}%
                  </div>
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="floating-word">
                    <span>remember</span>
                    <small>/rɪˈmembə(r)/</small>
                    <i>让记忆生根</i>
                    <Leaf size={28} />
                  </div>
                </section>
                <section className="panel today-panel">
                  <div className="section-head">
                    <h3>今日进度</h3>
                    <span className="pill">
                      {stats.completion === 100 ? "已完成" : "进行中"}
                    </span>
                  </div>
                  <div
                    className="progress-ring"
                    style={{
                      background: `conic-gradient(var(--green) ${stats.completion}%,var(--line) 0)`,
                    }}
                  >
                    <div>
                      <strong>
                        {stats.completion}
                        <span>%</span>
                      </strong>
                      <small>计划完成</small>
                    </div>
                  </div>
                  <div className="daily-detail">
                    <span>
                      <i className="dot green-bg" />
                      新词{" "}
                      <b>
                        {stats.today.newWords}
                        <em> / {stats.plan.goal}</em>
                      </b>
                    </span>
                    <span>
                      <i className="dot orange-bg" />
                      到期复习{" "}
                      <b>
                        {stats.plan.due}
                        <em> 待完成</em>
                      </b>
                    </span>
                  </div>
                  <div className="time-foot">
                    <Clock size={15} />
                    已专注 {Math.round(stats.today.seconds / 60)} 分钟
                    <span>目标 {settings.minutes} 分钟</span>
                  </div>
                </section>
              </div>
              <div className="metric-grid">
                {[
                  [
                    BookOpen,
                    "今日新词",
                    stats.today.newWords,
                    "个单词首次相识",
                    "mint",
                  ],
                  [
                    Check,
                    "旧词复习",
                    stats.today.reviews,
                    "次正式复习作答",
                    "sand",
                  ],
                  [
                    Clock,
                    "学习时长",
                    `${Math.round(stats.today.seconds / 60)} min`,
                    "只记录有效学习时间",
                    "lilac",
                  ],
                  [
                    Target,
                    "最近答题正确率",
                    stats.answerAccuracy == null
                      ? "—"
                      : `${Math.round(stats.answerAccuracy)}%`,
                    "最近 100 次选择或拼写作答",
                    "blue",
                  ],
                ].map(([Icon, label, value, sub, color]: any) => (
                  <div className="metric panel" key={label}>
                    <span className={`metric-icon ${color}`}>
                      <Icon size={21} />
                    </span>
                    <div>
                      <span>{label}</span>
                      <strong>{value}</strong>
                      <small>{sub}</small>
                    </div>
                  </div>
                ))}
              </div>
              <div className="section-head space-top">
                <div>
                  <h2>
                    我的词库{" "}
                    <span className="count-badge">{vocabs.length}</span>
                  </h2>
                  <p>把想学的词，慢慢变成会用的词。</p>
                </div>
                <button className="text-button" onClick={() => go("library")}>
                  查看全部 <ArrowUpRight size={16} />
                </button>
              </div>
              <div className="vocab-grid">
                {vocabs.slice(0, 3).map((v, i) => (
                  <VocabCard
                    key={v.id}
                    v={v}
                    i={i}
                    onClick={() => {
                      setVocab(v.id);
                      go("library");
                    }}
                  />
                ))}
                <button className="add-vocab" onClick={() => go("import")}>
                  <span>
                    <Plus size={23} />
                  </span>
                  <b>
                    {vocabs.length ? "导入更多单词" : "开始建立你的第一本词库"}
                  </b>
                  <small>支持 Excel、CSV、TXT</small>
                </button>
              </div>
              <div className="insight">
                <span className="insight-icon">
                  <Sparkles size={22} />
                </span>
                <div>
                  <b>把节奏交给记忆科学</b>
                  <p>
                    {stats.plan.due
                      ? `你有 ${stats.plan.due} 个到期单词。先复习，再学习新词；今天建议新增 ${stats.plan.recommended} 个。`
                      : "今天的复习队列很轻松。导入词库后，从一小组新词开始吧。"}{" "}
                    时间目标是建议，你可以按自己的节奏继续。
                  </p>
                </div>
                <span className="pill">本地学习建议</span>
              </div>
            </>
          )}
          {(page === "library" || page === "difficult") && (
            <>
              <Heading
                title={page === "difficult" ? "把困难，变成进步" : "我的词库"}
                sub="同一个单词跨词库共享学习进度，不重复统计。"
              />
              <div className="toolbar">
                <select
                  value={vocab}
                  onChange={(e) => setVocab(Number(e.target.value))}
                >
                  <option value={0}>全部词库</option>
                  {vocabs.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <label className="search">
                  <Search size={17} />
                  <input
                    placeholder="搜索英文或中文释义"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="">全部单词</option>
                  <option value="new">未学</option>
                  <option value="due">待复习</option>
                  <option value="difficult">困难词</option>
                </select>
                <button
                  className="primary"
                  onClick={() =>
                    action(async () => {
                      const name = prompt("新词库名称");
                      if (name) {
                        await api("/vocabularies", { name });
                        await refresh();
                        setNotice("词库已创建");
                      }
                    })
                  }
                >
                  <Plus size={16} />
                  新建词库
                </button>
              </div>
              <div className="vocab-grid compact">
                {vocabs.map((v, i) => (
                  <div key={v.id}>
                    <VocabCard v={v} i={i} onClick={() => setVocab(v.id)} />
                    <div className="card-actions">
                      <button
                        onClick={() =>
                          action(async () => {
                            const name = prompt("重命名词库", v.name);
                            if (name) {
                              await api(
                                `/vocabularies/${v.id}`,
                                { name },
                                "PUT",
                              );
                              await refresh();
                            }
                          })
                        }
                      >
                        重命名
                      </button>
                      <button
                        onClick={() =>
                          action(async () => {
                            if (
                              confirm(
                                "删除此词库及其关联关系？单词、共享记忆状态和学习日志会保留在“全部词库”中。",
                              )
                            ) {
                              await api(
                                `/vocabularies/${v.id}`,
                                undefined,
                                "DELETE",
                              );
                              setVocab(0);
                              await refresh();
                              await loadWords();
                            }
                          })
                        }
                      >
                        删除词库
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="section-head space-top">
                <h3>
                  {page === "difficult" ? "遗忘过的单词" : "单词列表"}{" "}
                  <span className="muted">{words.length} 个</span>
                </h3>
                <div className="button-row">
                  <a
                    className="button secondary"
                    href={`/api/export?vocab=${vocab}`}
                  >
                    导出 CSV
                  </a>
                  <button
                    className="secondary"
                    onClick={() => {
                      if (!vocab) {
                        setError("请先选择目标词库");
                        return;
                      }
                      setEditor({
                        word: "",
                        zh: "",
                        en: "",
                        phonetic: "",
                        pos: "",
                        example: "",
                        translation: "",
                        tags: "",
                        notes: "",
                      });
                    }}
                  >
                    添加单词
                  </button>
                  {page === "difficult" && (
                    <button
                      className="primary"
                      onClick={() => action(() => begin("difficult"))}
                    >
                      额外练习
                    </button>
                  )}
                </div>
              </div>
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>单词</th>
                      <th>中文释义</th>
                      <th>标签</th>
                      <th>学习状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {words.slice(0, 500).map((w) => (
                      <tr key={w.id}>
                        <td>
                          <b>{w.word}</b>
                          <small>{w.phonetic}</small>
                        </td>
                        <td>{w.zh || <span className="muted">待补充</span>}</td>
                        <td>
                          <span className="tag">{w.tags || "—"}</span>
                        </td>
                        <td>
                          {w.reps
                            ? `已复习 ${w.reps} 次 · 遗忘 ${w.lapses} 次`
                            : "未学习"}
                        </td>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => setEditor(w)}
                          >
                            编辑
                          </button>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => action(() => generateFields(w))}
                          >
                            AI 补全
                          </button>
                          <button
                            className="text-button danger"
                            onClick={() =>
                              action(async () => {
                                if (
                                  confirm(
                                    `永久删除 ${w.word}？将删除所有词库关联、FSRS 状态和此词的复习日志，统计也会变化。`,
                                  )
                                ) {
                                  await api(
                                    `/words/${w.id}`,
                                    undefined,
                                    "DELETE",
                                  );
                                  await loadWords();
                                  await refresh();
                                }
                              })
                            }
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!words.length && (
                  <Empty
                    title="这里还没有单词"
                    text="导入你的词表，或选择另一个词库。"
                    onClick={() => go("import")}
                    label="导入单词"
                  />
                )}
                {words.length > 500 && (
                  <p className="muted padding">
                    显示前 500 个结果，请搜索缩小范围；导出包含全部结果。
                  </p>
                )}
              </div>
            </>
          )}
          {page === "import" && (
            <>
              <Heading
                title="为下一次进步，准备词汇"
                sub="Excel、CSV 或 TXT · UTF-8 编码 · 单次最多 20,000 行 / 20 MB"
              />
              <section className="panel padding">
                <div className="section-head">
                  <h3>01 / 选择文件</h3>
                  <a
                    href="/examples/vocabulary.csv"
                    download
                    className="text-button"
                  >
                    <Download size={16} />
                    下载 CSV 示例
                  </a>
                </div>
                <label className="dropzone">
                  <Upload size={32} />
                  <strong>选择你的单词文件</strong>
                  <span>支持只有英文单词的一列文件，缺失释义可稍后补充</span>
                  <input
                    type="file"
                    accept=".xlsx,.csv,.txt"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        action(async () => {
                          const form = new FormData();
                          form.append("file", file);
                          const p = await api("/import/preview", form);
                          setPreview(p);
                          setMapping(p.mapping);
                          setFilename(file.name);
                          setImportResult(undefined);
                          if (!target && vocabs[0]) setTarget(vocabs[0].id);
                        });
                    }}
                  />
                </label>
                {preview && (
                  <>
                    <h3 className="space-top">02 / 匹配字段与目标词库</h3>
                    <p>
                      {filename} · {preview.rows.length} 行，预览前 8
                      行。空行和无效单词会记录原因。
                    </p>
                    <div className="toolbar">
                      <select
                        value={target}
                        onChange={(e) => setTarget(Number(e.target.value))}
                      >
                        <option value={0}>选择目标词库</option>
                        {vocabs.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="secondary"
                        onClick={() =>
                          action(async () => {
                            const name = prompt("新词库名称");
                            if (name) {
                              const v = await api("/vocabularies", { name });
                              setTarget(v.id);
                              await refresh();
                            }
                          })
                        }
                      >
                        新建目标词库
                      </button>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {preview.headers.map((h: string, i: number) => (
                              <th key={i}>
                                {h}
                                <select
                                  aria-label={`第 ${i + 1} 列字段`}
                                  value={mapping[i] || ""}
                                  onChange={(e) =>
                                    setMapping(
                                      mapping.map((m, j) =>
                                        j === i ? e.target.value : m,
                                      ),
                                    )
                                  }
                                >
                                  <option value="">忽略此列</option>
                                  {Object.entries(fieldNames).map(([k, v]) => (
                                    <option key={k} value={k}>
                                      {String(v)}
                                    </option>
                                  ))}
                                </select>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {preview.rows
                            .slice(0, 8)
                            .map((r: string[], i: number) => (
                              <tr key={i}>
                                {preview.headers.map((_: string, j: number) => (
                                  <td key={j}>{r[j]}</td>
                                ))}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="info">
                      已有同名词会关联到目标词库，保留原有内容和记忆状态；同一词库内重复行跳过。不会自动调用
                      AI。
                    </p>
                    {!mapping.includes("word") && (
                      <p role="alert" className="info">
                        请将包含英文单词的一列匹配为“英文单词”，再确认导入。
                      </p>
                    )}
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        !target ||
                        !mapping.includes("word") ||
                        new Set(mapping.filter(Boolean)).size !==
                          mapping.filter(Boolean).length
                      }
                      onClick={() =>
                        action(async () => {
                          const r = await api("/import", {
                            vocab: target,
                            filename,
                            rows: preview.rows,
                            mapping,
                          });
                          setImportResult(r);
                          setPreview(undefined);
                          await refresh();
                          setNotice("导入完成");
                        })
                      }
                    >
                      {busy
                        ? "正在保存，请稍候…"
                        : `确认导入 ${preview.rows.length} 行`}{" "}
                      <ArrowRight size={17} />
                    </button>
                  </>
                )}
                {importResult && (
                  <div className="result">
                    <h3>导入完成</h3>
                    <p>
                      成功关联 {importResult.success} · 重复跳过{" "}
                      {importResult.skipped} · 无效 {importResult.failed}
                    </p>
                    <details>
                      <summary>查看无效行原因</summary>
                      {importResult.errors.map((e: Any) => (
                        <p key={e.row}>
                          数据行 {e.row}：{e.reason}
                        </p>
                      ))}
                    </details>
                  </div>
                )}
              </section>
              <section className="panel padding space-top">
                <div className="section-head">
                  <h3>导入记录</h3>
                  <button
                    className="secondary"
                    onClick={() =>
                      action(async () => setLogs(await api("/import/logs")))
                    }
                  >
                    加载记录
                  </button>
                </div>
                {logs.map((l) => (
                  <p key={l.id}>
                    {l.at.slice(0, 10)} · {l.filename} · 成功{" "}
                    {JSON.parse(l.json).success} / 跳过{" "}
                    {JSON.parse(l.json).skipped} / 无效{" "}
                    {JSON.parse(l.json).failed}
                  </p>
                ))}
                <p className="muted">
                  字段支持
                  word、zh、en、phonetic、pos、example、translation、tags、notes，或对应中文表头。TXT
                  每行一个单词，或以制表符分列。Excel 读取第一个工作表。
                </p>
              </section>
            </>
          )}
          {page === "plan" && (
            <>
              <Heading
                title="今天的学习，心中有数"
                sub="先巩固，再向前。时间是软目标，你可以主动继续。"
              />
              <div className="metric-grid">
                <Stat
                  title="新词已完成"
                  value={`${stats.plan.newDone} / ${stats.plan.goal}`}
                />
                <Stat title="待复习" value={stats.plan.due} />
                <Stat title="今日新词硬上限" value={stats.plan.cap} />
                <Stat title="建议新增" value={stats.plan.recommended} />
              </div>
              <section className="panel padding space-top">
                <h2>你的学习节奏</h2>
                <p>
                  首次学习日最多 80 个新词；此后每天最多 200
                  个。多个词库共享总上限，重复复习不占用新词额度。
                </p>
                <p>
                  顺序：重新学习的遗忘词 → 已逾期复习 → 当天到期复习 →
                  新词。队列根据当前状态实时更新，未完成的到期卡片继续保留。
                </p>
                <p>
                  预算预留 10% 缓冲；初始按新词 45 秒、旧词 20
                  秒估计，再根据实际有效学习速度调整。目标 {settings.minutes}{" "}
                  分钟。
                </p>
                <div className="button-row">
                  {modes.map(([k, n]) => (
                    <button
                      key={k}
                      className="secondary"
                      onClick={() => action(() => begin(k))}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
          {page === "study" && (
            <>
              <div className="section-head">
                <button className="text-button" onClick={() => go("home")}>
                  <ChevronLeft size={18} />
                  返回主页
                </button>
                <div className="button-row">
                  <select
                    value={mode}
                    onChange={(e) => action(() => begin(e.target.value))}
                  >
                    {modes.map(([k, n]) => (
                      <option key={k} value={k}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span className="pill">
                    {practice
                      ? "额外练习 · 不修改 FSRS"
                      : "正式学习 · 自评后写入 FSRS"}
                  </span>
                </div>
              </div>
              {!card ? (
                <div className="panel study-card">
                  <Leaf size={42} />
                  <h2>这段学习，先告一段落</h2>
                  <p>
                    当前没有可学习单词，或已达到今日新词上限。到期的卡片会自动回来。
                  </p>
                  <button
                    className="primary"
                    onClick={() => action(() => nextCard())}
                  >
                    刷新队列
                  </button>
                </div>
              ) : (
                <>
                  <section className="panel study-card">
                    <div className="study-meta">
                      <span>
                        {practice
                          ? "困难词额外练习"
                          : card.reps
                            ? "到期复习"
                            : "第一次认识"}{" "}
                        · {card.pos || "WORD"}
                      </span>
                      <span>
                        今日新词 {stats.plan.newDone} / {stats.plan.cap}
                      </span>
                    </div>
                    {mode === "spelling" ? (
                      <>
                        <p className="card-prompt">根据释义拼写英文</p>
                        <h2 className="meaning">
                          {card.zh ||
                            "此词暂无中文释义，请切换卡片模式或先编辑"}
                        </h2>
                      </>
                    ) : mode === "listening" ? (
                      <>
                        <p className="card-prompt">听一听，写出这个单词</p>
                        <button
                          className="audio-large"
                          aria-label="播放单词"
                          onClick={() => speak(card.word)}
                        >
                          <Volume2 size={34} />
                        </button>
                      </>
                    ) : (
                      <>
                        <h2 className="english-word">{card.word}</h2>
                        <div className="phonetic">
                          {card.phonetic || "音标待补充"}
                          <button
                            title="发音"
                            className="icon-button"
                            onClick={() => speak(card.word)}
                          >
                            <Volume2 size={20} />
                          </button>
                        </div>
                      </>
                    )}
                    {mode === "choice" &&
                      !revealed &&
                      (options.length === 4 ? (
                        <div className="choices">
                          {options.map((o) => (
                            <button
                              key={o}
                              disabled={busy}
                              className="secondary"
                              onClick={() => checkAnswer(o)}
                            >
                              {o}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="info">
                          需要本词中文释义及至少三个不同的中文干扰项。请补充词库或切换卡片模式。
                        </p>
                      ))}
                    {["spelling", "listening"].includes(mode) && !revealed && (
                      <form
                        className="answer-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          checkAnswer(answer);
                        }}
                      >
                        <input
                          aria-label="英文答案"
                          autoComplete="off"
                          autoFocus
                          value={answer}
                          onChange={(e) => setAnswer(e.target.value)}
                          placeholder="输入英文单词…"
                        />
                        <button
                          className="primary"
                          disabled={mode === "spelling" && !card.zh}
                        >
                          检查答案
                        </button>
                      </form>
                    )}
                    {!revealed && (
                      <button
                        className="secondary show-answer"
                        onClick={() => setRevealed(true)}
                      >
                        显示答案
                      </button>
                    )}
                    {revealed && (
                      <div className="answer-content">
                        {correct !== null && (
                          <div
                            className={
                              correct ? "feedback good" : "feedback wrong"
                            }
                          >
                            {correct ? "回答正确" : "还差一点，再记一次"} ·
                            你的答案：{answer}
                          </div>
                        )}
                        {["spelling", "listening"].includes(mode) && (
                          <h2 className="english-word">{card.word}</h2>
                        )}
                        <h3>{card.zh || "暂无中文释义"}</h3>
                        {card.ai_fields && card.ai_fields !== "[]" && (
                          <p className="muted">
                            部分资料由 AI 生成，请结合语境核对。
                          </p>
                        )}
                        {card.pos && <p>词性：{card.pos}</p>}
                        {card.en && <p>{card.en}</p>}
                        {card.example && (
                          <blockquote>
                            {card.example}
                            <small>{card.translation}</small>
                          </blockquote>
                        )}
                        {card.notes && (
                          <p className="note">我的笔记：{card.notes}</p>
                        )}
                        {card.usage && (
                          <blockquote>
                            <strong>如何使用</strong>
                            <p style={{ whiteSpace: "pre-wrap" }}>
                              {card.usage}
                            </p>
                          </blockquote>
                        )}
                        <div className="button-row center">
                          <button
                            className="text-button"
                            onClick={() => setEditor(card)}
                          >
                            编辑单词
                          </button>
                          <button
                            disabled={busy}
                            className="text-button"
                            onClick={() => action(() => askAI(card.id))}
                          >
                            <Sparkles size={15} />
                            AI 深度解释
                          </button>
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() => action(() => generateFields(card))}
                          >
                            <Sparkles size={15} />
                            AI 补全资料
                          </button>
                        </div>
                      </div>
                    )}
                  </section>
                  {revealed && (
                    <div className="rating-area">
                      <p>
                        {practice
                          ? "本次为额外练习，不产生正式复习记录。"
                          : "答题只提供反馈；以下自评只提交一次正式复习。请按真实记忆选择。"}
                      </p>
                      <div className="rating-buttons">
                        {practice ? (
                          <button
                            className="primary"
                            onClick={() => action(() => nextCard())}
                          >
                            下一个困难词
                          </button>
                        ) : (
                          [
                            ["Again", "忘记了"],
                            ["Hard", "困难"],
                            ["Good", "记得"],
                            ["Easy", "简单"],
                          ].map(([en, zh], i) => (
                            <button
                              key={en}
                              className={`rating rating-${i}`}
                              disabled={busy}
                              onClick={() => action(() => rate(i + 1))}
                            >
                              <b>{en}</b>
                              <span>{zh}</span>
                            </button>
                          ))
                        )}
                      </div>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => action(() => nextCard())}
                      >
                        重新加载当前队列
                      </button>
                    </div>
                  )}
                  {ai && <pre className="panel ai-response">{ai}</pre>}
                </>
              )}
            </>
          )}
          {page === "stats" && (
            <>
              <Heading
                title="每一点努力，都有迹可循"
                sub="所有统计来自你的真实学习记录。答题正确率按选择、拼写和听音答案统计；卡片自评单独记录。"
              />
              <div className="metric-grid">
                <Stat title="总单词数（去重）" value={stats.counts.total} />
                <Stat title="已开始学习" value={stats.counts.learned} />
                <Stat title="待复习" value={stats.plan.due} />
                <Stat title="困难单词" value={stats.difficult} />
              </div>
              <div className="two-col space-top">
                <section className="panel padding">
                  <h3>学习日历</h3>
                  <p>
                    连续 {stats.streak} 天 · 累计 {stats.calendar.length}{" "}
                    个学习日
                  </p>
                  <div className="calendar">
                    {Array.from({ length: 84 }, (_, i) => {
                      const d = new Date(stats.plan.day + "T12:00:00Z");
                      d.setUTCDate(d.getUTCDate() - (83 - i));
                      const day = d.toISOString().slice(0, 10),
                        c =
                          stats.calendar.find((x: Any) => x.day === day)
                            ?.count || 0;
                      return (
                        <span
                          key={day}
                          title={`${day}：${c} 次复习`}
                          style={{
                            background: c ? "var(--green)" : undefined,
                            opacity: c ? Math.min(1, 0.4 + c / 30) : 1,
                          }}
                        />
                      );
                    })}
                  </div>
                  <p className="muted">最近 84 天 · 深色表示更多正式作答</p>
                </section>
                <section className="panel padding">
                  <h3>今日学习记录</h3>
                  <p>首次学习：{stats.today.newWords} 个不同新词</p>
                  <p>旧词复习：{stats.today.reviews} 次</p>
                  <p>正式作答合计：{stats.today.answers} 次</p>
                  <p>学习过的不同单词：{stats.today.distinctWords} 个</p>
                  <p>有效时长：{stats.today.seconds} 秒</p>
                  <a className="text-button" href="/api/export?type=reviews">
                    导出复习记录 CSV <Download size={15} />
                  </a>
                </section>
              </div>
              <section className="panel padding space-top">
                <h3>未来复习预测</h3>
                <p className="muted">
                  按当前 FSRS 到期日期（UTC）汇总，后续自评会改变预测。
                </p>
                {stats.forecast.length ? (
                  stats.forecast.map((f: Any) => (
                    <div className="forecast" key={f.day}>
                      <span>{f.day}</span>
                      <div>
                        <i
                          style={{
                            width: `${Math.min(100, (f.count / Math.max(...stats.forecast.map((x: Any) => x.count))) * 100)}%`,
                          }}
                        />
                      </div>
                      <b>{f.count} 词</b>
                    </div>
                  ))
                ) : (
                  <p>完成首次学习后，这里将出现复习预测。</p>
                )}
              </section>
            </>
          )}
          {page === "ai" && (
            <>
              <Heading
                title="让理解，比记住多一步"
                sub="AI 是可选学习工具；记忆安排始终由 FSRS 决定。"
              />
              <section className="panel padding">
                <div className="insight-icon">
                  <Sparkles size={28} />
                </div>
                <h2>根据你的实际学习情况，给一点建议。</h2>
                <p>
                  将发送今日学习摘要与最多 15 个困难词到你配置的外部 AI
                  服务。不会自动批量补全词库。
                </p>
                <p>
                  AI 状态：{settings.ai ? "已启用" : "已关闭"} · 服务端密钥
                  {status.aiConfigured ? "已配置" : "未配置"}
                </p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => action(() => askAI())}
                >
                  {busy ? "正在思考…" : "生成今日学习建议"}
                  <Sparkles size={16} />
                </button>
              </section>
              {ai && <pre className="panel ai-response">{ai}</pre>}
            </>
          )}
          {page === "settings" && (
            <>
              <Heading
                title="按你的节奏，安心学习"
                sub={
                  status.storage === "d1"
                    ? "设置、词库与学习状态按账号保存在云端 D1 数据库。"
                    : "设置、词库与学习状态保存在本机 SQLite 数据库。"
                }
              />
              <form
                className="panel padding settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  action(async () => {
                    const saved = await api(
                      "/account/ai",
                      {
                        baseUrl: provider.baseUrl,
                        model: provider.model,
                        ...(providerKey ? { apiKey: providerKey } : {}),
                      },
                      "PUT",
                    );
                    setProvider(saved);
                    setProviderKey("");
                    await refresh();
                    setNotice("个人 AI 配置已保存");
                  });
                }}
              >
                <h2>个人 AI 服务</h2>
                <p>
                  填写你自己的 OpenAI
                  兼容服务。密钥加密保存，不会显示已保存的密钥。
                </p>

                <Field label="Base URL">
                  <input
                    required
                    type="url"
                    placeholder="https://api.example.com/v1"
                    value={provider.baseUrl}
                    onChange={(e) =>
                      setProvider({ ...provider, baseUrl: e.target.value })
                    }
                  />
                </Field>
                <Field label="模型名称">
                  <input
                    required
                    value={provider.model}
                    onChange={(e) =>
                      setProvider({ ...provider, model: e.target.value })
                    }
                  />
                </Field>
                <Field
                  label={
                    provider.configured
                      ? "新 API Key（留空保留现有密钥）"
                      : "API Key"
                  }
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={providerKey}
                    onChange={(e) => setProviderKey(e.target.value)}
                  />
                </Field>
                <p role="status">
                  密钥：{provider.configured ? "已配置" : "未配置"}
                  。保存配置后，还需在下方开启 AI 功能。
                </p>
                <div className="button-row">
                  <button className="primary" disabled={busy}>
                    保存 AI 配置
                  </button>
                  {provider.configured && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        if (confirm("清除这个账号保存的 AI 密钥？"))
                          action(async () => {
                            setProvider(
                              await api(
                                "/account/ai",
                                {
                                  baseUrl: provider.baseUrl,
                                  model: provider.model,
                                  clearKey: true,
                                },
                                "PUT",
                              ),
                            );
                            setProviderKey("");
                            await refresh();
                          });
                      }}
                    >
                      清除密钥
                    </button>
                  )}
                </div>
              </form>
              <form
                className="panel padding settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  action(async () => {
                    if (passwordForm.next !== passwordForm.confirm)
                      throw new Error("两次新密码不一致");
                    const result = await api("/auth/password", {
                      currentPassword: passwordForm.current,
                      password: passwordForm.next,
                    });
                    onPasswordChanged(result);
                    setPasswordForm({ current: "", next: "", confirm: "" });
                    setNotice("密码已更新，其他设备已退出登录");
                  });
                }}
              >
                <h2>修改密码</h2>
                <Field label="当前密码">
                  <input
                    required
                    type="password"
                    autoComplete="current-password"
                    value={passwordForm.current}
                    onChange={(e) =>
                      setPasswordForm({
                        ...passwordForm,
                        current: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="新密码（至少 12 个字符）">
                  <input
                    required
                    minLength={12}
                    maxLength={128}
                    type="password"
                    autoComplete="new-password"
                    value={passwordForm.next}
                    onChange={(e) =>
                      setPasswordForm({ ...passwordForm, next: e.target.value })
                    }
                  />
                </Field>
                <Field label="确认新密码">
                  <input
                    required
                    minLength={12}
                    type="password"
                    autoComplete="new-password"
                    value={passwordForm.confirm}
                    onChange={(e) =>
                      setPasswordForm({
                        ...passwordForm,
                        confirm: e.target.value,
                      })
                    }
                  />
                </Field>
                <button className="primary" disabled={busy}>
                  更新密码
                </button>
              </form>
              <form
                className="panel padding settings-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  action(async () => {
                    await api("/settings", settings, "PUT");
                    await refresh();
                    setNotice("设置已保存");
                  });
                }}
              >
                <h3>个人学习偏好</h3>
                <div className="form-grid">
                  <Field label="昵称（可选）">
                    <input
                      value={settings.nickname}
                      onChange={(e) =>
                        setSettings({ ...settings, nickname: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="每日新词目标（1–200）">
                    <input
                      type="number"
                      min="1"
                      max="200"
                      value={settings.newGoal}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          newGoal: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="每日时间目标（分钟）">
                    <input
                      type="number"
                      min="1"
                      max="600"
                      value={settings.minutes}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          minutes: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="学习时区（开始学习后固定）">
                    <input
                      disabled={!!settings.firstDay}
                      value={settings.timezone}
                      onChange={(e) =>
                        setSettings({ ...settings, timezone: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="FSRS 目标记忆保持率（0.70–0.97）">
                    <input
                      type="number"
                      min=".7"
                      max=".97"
                      step=".01"
                      value={settings.retention}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          retention: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <Field label="默认学习模式">
                    <select
                      value={settings.mode}
                      onChange={(e) =>
                        setSettings({ ...settings, mode: e.target.value })
                      }
                    >
                      {modes.map(([k, n]) => (
                        <option key={k} value={k}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="界面主题">
                    <select
                      value={settings.theme}
                      onChange={(e) =>
                        setSettings({ ...settings, theme: e.target.value })
                      }
                    >
                      <option value="light">浅色</option>
                      <option value="dark">深色</option>
                    </select>
                  </Field>
                  <Field label="AI 功能">
                    <select
                      value={String(settings.ai)}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ai: e.target.value === "true",
                        })
                      }
                    >
                      <option value="false">关闭</option>
                      <option value="true">主动触发时调用</option>
                    </select>
                  </Field>
                </div>
                <p className="info">
                  AI 开启后，仅在点击生成时向外部服务发送当前单词或学习摘要。API
                  Key 在此账号的个人 AI 设置中配置；保存后立即生效。
                </p>
                <button className="primary" disabled={busy}>
                  保存设置
                </button>
              </form>
              <section className="panel padding space-top">
                <h3>单词与释义导出</h3>
                <p>
                  下载当前账号的全部单词和中文释义，CSV 文件仅包含 word、zh
                  两列。
                </p>
                <div className="button-row">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        const blob = await api(
                          "/export?type=vocabulary",
                          undefined,
                          "GET",
                          60_000,
                          true,
                        );
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = "vocabflow-vocabulary.csv";
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      })
                    }
                  >
                    <Download size={17} />
                    下载词汇 CSV
                  </button>
                </div>
                <p className="muted">
                  可通过“导入词库”重新导入此 CSV。文件不包含账号信息、AI
                  配置、学习记录或记忆进度。
                </p>
              </section>
            </>
          )}
          <footer>
            <Leaf size={14} />
            VocabFlow AI <span>让词汇成为你的语言。</span>
            <span className="footer-right">LEARN AT YOUR PACE</span>
          </footer>
        </div>
      </main>
      <Dialog.Root
        open={!!aiDraft}
        onOpenChange={(open) => {
          if (!open) setAiDraft(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal">
            <Dialog.Title>AI 补全：{aiDraft?.word}</Dialog.Title>
            <Dialog.Description>
              以下资料由 AI 生成
              {aiDraft?.cached
                ? "（本地缓存）"
                : aiDraft?.elapsedMs
                  ? `（生成耗时 ${(aiDraft.elapsedMs / 1000).toFixed(1)} 秒）`
                  : ""}
              ，可以修改后保存。仅填补空白内容，保留已有释义与笔记。
            </Dialog.Description>
            {error && (
              <div role="alert" className="alert error">
                {error}
              </div>
            )}
            {aiDraft && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  action(saveGeneratedFields);
                }}
              >
                <div className="form-grid">
                  {Object.entries({
                    ...fieldNames,
                    usage: "如何使用（中文说明）",
                  })
                    .filter(([key]) => key in aiDraft.fields)
                    .map(([key, label]) => (
                      <Field key={key} label={String(label)}>
                        <textarea
                          required={[
                            "zh",
                            "pos",
                            "example",
                            "translation",
                            "usage",
                          ].includes(key)}
                          value={aiDraft.fields[key]}
                          onChange={(event) =>
                            setAiDraft({
                              ...aiDraft,
                              fields: {
                                ...aiDraft.fields,
                                [key]: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                    ))}
                </div>
                <div className="button-row space-top">
                  <button className="primary" disabled={busy}>
                    保存空缺资料
                  </button>
                  <Dialog.Close className="secondary" type="button">
                    取消
                  </Dialog.Close>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal">
            <Dialog.Title>{editor?.id ? "编辑单词" : "添加单词"}</Dialog.Title>
            <Dialog.Description>
              内容由你保存。AI 生成解释单独标识，不会自动覆盖词库。
            </Dialog.Description>
            {error && (
              <div role="alert" className="alert error">
                {error}
              </div>
            )}
            {editor && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  action(async () => {
                    if (editor.id)
                      await api(`/words/${editor.id}`, editor, "PUT");
                    else await api("/words", { vocab, word: editor });
                    if (card?.id === editor.id) setCard({ ...card, ...editor });
                    setEditor(null);
                    await loadWords();
                    await refresh();
                    setNotice("单词已保存");
                  });
                }}
              >
                <div className="form-grid">
                  {Object.entries({
                    ...fieldNames,
                    usage: "如何使用（中文说明）",
                  }).map(([k, v]) => (
                    <Field key={k} label={String(v)}>
                      {["example", "translation", "notes", "usage"].includes(
                        k,
                      ) ? (
                        <textarea
                          value={editor[k] || ""}
                          onChange={(e) =>
                            setEditor({ ...editor, [k]: e.target.value })
                          }
                        />
                      ) : (
                        <input
                          required={k === "word"}
                          value={editor[k] || ""}
                          onChange={(e) =>
                            setEditor({ ...editor, [k]: e.target.value })
                          }
                        />
                      )}
                    </Field>
                  ))}
                </div>
                <div className="button-row space-top">
                  <button disabled={busy} className="primary">
                    保存单词
                  </button>
                  <Dialog.Close className="secondary" type="button">
                    取消
                  </Dialog.Close>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {busy && (
        <div className="busy-indicator" role="status">
          正在处理…
        </div>
      )}
    </div>
  );
}
function Heading({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">YOUR VOCABULARY JOURNEY</div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
    </div>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Stat({ title, value }: { title: string; value: any }) {
  return (
    <div className="panel stat">
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Empty({
  title,
  text,
  onClick,
  label,
}: {
  title: string;
  text: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <div className="empty">
      <BookOpen size={32} />
      <h3>{title}</h3>
      <p>{text}</p>
      <button className="primary" onClick={onClick}>
        {label}
      </button>
    </div>
  );
}
function VocabCard({
  v,
  i,
  onClick,
}: {
  v: Any;
  i: number;
  onClick: () => void;
}) {
  return (
    <button className="panel vocab-card" onClick={onClick}>
      <div className="section-head">
        <span className={`book-icon ${["mint", "sand", "lilac"][i % 3]}`}>
          <BookOpen size={22} />
        </span>
        <ArrowUpRight size={17} className="muted" />
      </div>
      <h3>{v.name}</h3>
      <p>
        {v.total} 个单词{" "}
        <span>
          · 已学 {v.learned || 0} · 未学 {v.total - (v.learned || 0)}
        </span>
      </p>
      <div className="progress-line">
        <i
          style={{
            width: `${v.total ? ((v.learned || 0) / v.total) * 100 : 0}%`,
          }}
        />
      </div>
      <div className="vocab-foot">
        <span>
          已学 {v.total ? Math.round(((v.learned || 0) / v.total) * 100) : 0}% ·
          掌握 {v.mastered || 0}
        </span>
        <span>{v.due || 0} 待复习</span>
      </div>
    </button>
  );
}
createRoot(document.getElementById("root")!).render(
  <AuthGate>{(props) => <App {...props} />}</AuthGate>,
);
