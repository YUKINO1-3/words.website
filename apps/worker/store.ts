import { createEmptyCard, fsrs, type Card, type Grade } from "ts-fsrs";
import {
  settingsSchema,
  wordSchema,
  type Word,
} from "../../packages/shared/schema.ts";
import { enrichmentSchema } from "../api/enrichment.ts";
import { HttpError, type Row } from "./types.ts";
import type { SQL } from "./auth.ts";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
export class D1Store {
  pending: D1PreparedStatement[] = [];
  space!: Row;
  settings!: ReturnType<typeof settingsSchema.parse>;
  constructor(
    readonly db: SQL,
    readonly uid: number,
  ) {}
  stmt(sql: string, ...args: any[]) {
    return this.db.prepare(sql).bind(...args);
  }
  async one(sql: string, ...args: any[]): Promise<Row | undefined> {
    return (await this.stmt(sql, ...args).first<Row>()) || undefined;
  }
  async all(sql: string, ...args: any[]): Promise<Row[]> {
    return (await this.stmt(sql, ...args).all<Row>()).results;
  }
  queue(sql: string, ...args: any[]) {
    this.pending.push(this.stmt(sql, ...args));
  }
  async init() {
    this.space = (await this.one(
      "SELECT * FROM spaces WHERE user_id=?",
      this.uid,
    ))!;
    if (!this.space) throw new HttpError("学习空间不存在", 404);
    this.settings = settingsSchema.parse(JSON.parse(this.space.settings));
    return this;
  }
  async commit() {
    if (!this.pending.length) return;
    await this.db.batch([
      this.stmt(
        "INSERT INTO write_guards(user_id,expected_version) VALUES(?,?)",
        this.uid,
        this.space.version,
      ),
      ...this.pending,
      this.stmt("DELETE FROM write_guards WHERE user_id=?", this.uid),
    ]);
  }
  saveSettings(value: unknown) {
    const old = this.settings;
    const s = settingsSchema.parse({
      ...old,
      ...(value as Row),
      firstDay: old.firstDay,
      lastDay: old.lastDay,
      lastAt: old.lastAt,
    });
    if (old.firstDay && old.timezone !== s.timezone)
      throw new HttpError("开始学习后学习时区已固定，以防重复发放新词");
    this.settings = s;
    this.queue(
      "UPDATE spaces SET settings=? WHERE user_id=?",
      JSON.stringify(s),
      this.uid,
    );
    return s;
  }
  day(now = new Date()) {
    const s = this.settings,
      day = new Intl.DateTimeFormat("en-CA", {
        timeZone: s.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    return s.lastDay && day < s.lastDay ? s.lastDay : day;
  }
  async plan(now = new Date()) {
    const s = this.settings,
      day = this.day(now),
      saved = await this.one(
        "SELECT * FROM daily_plans WHERE user_id=? AND day=?",
        this.uid,
        day,
      );
    const n = saved?.new_done || 0,
      cap = !s.firstDay || s.firstDay === day ? 80 : 200;
    const due = (await this.one(
      "SELECT count(*) n FROM cards WHERE user_id=? AND reps>0 AND due<=?",
      this.uid,
      now.toISOString(),
    ))!.n;
    const speeds = await this.all(
      "SELECT is_new,avg(seconds) sec FROM review_logs WHERE user_id=? AND seconds>0 GROUP BY is_new",
      this.uid,
    );
    const seconds = (await this.one(
      "SELECT coalesce(sum(seconds),0) seconds FROM study_sessions WHERE user_id=? AND day=?",
      this.uid,
      day,
    ))!.seconds;
    const speed = (isNew: number, def: number) =>
      Math.max(5, speeds.find((x) => x.is_new === isNew)?.sec || def);
    const recommended = Math.max(
      0,
      Math.min(
        s.newGoal - n,
        cap - n,
        Math.floor(
          (s.minutes * 60 * 0.9 - seconds - due * speed(0, 20)) / speed(1, 45),
        ),
      ),
    );
    const goal = Math.min(s.newGoal, cap),
      reviewGoal = Math.max(saved?.review_goal || 0, due);
    this.queue(
      "INSERT INTO daily_plans(user_id,day,new_goal,review_goal) VALUES(?,?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET new_goal=excluded.new_goal,review_goal=max(daily_plans.review_goal,excluded.review_goal)",
      this.uid,
      day,
      goal,
      due,
    );
    return {
      day,
      cap,
      newDone: n,
      due,
      recommended,
      goal,
      saved: {
        ...saved,
        day,
        new_goal: goal,
        review_goal: reviewGoal,
        new_done: n,
      },
    };
  }
  async words(vocab = 0, q = "", filter = "") {
    const filters: Record<string, string> = {
      new: "AND c.reps=0",
      due: "AND c.reps>0 AND c.due<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
      difficult:
        "AND (c.lapses>0 OR EXISTS(SELECT 1 FROM review_logs r WHERE r.user_id=w.user_id AND r.word_id=w.id AND (r.rating=1 OR r.answer_correct=0)))",
    };
    return this.all(
      `SELECT w.*,c.json card,c.version,c.reps,c.lapses,c.due,c.state,c.epoch card_epoch FROM words w JOIN cards c ON c.user_id=w.user_id AND c.word_id=w.id WHERE w.user_id=? AND (?=0 OR EXISTS(SELECT 1 FROM vocabulary_words v WHERE v.user_id=w.user_id AND v.word_id=w.id AND v.vocabulary_id=?)) AND (w.word LIKE ? OR w.zh LIKE ?) ${filters[filter] || ""} ORDER BY w.id`,
      this.uid,
      vocab,
      vocab,
      `%${q}%`,
      `%${q}%`,
    );
  }
  vocabularies() {
    return this.all(
      "SELECT v.*,count(w.word_id) total,coalesce(sum(c.reps>0),0) learned,coalesce(sum(c.reps>0 AND c.due<=?),0) due,coalesce(sum(c.reps>=5 AND c.lapses=0),0) mastered FROM vocabularies v LEFT JOIN vocabulary_words w ON w.user_id=v.user_id AND w.vocabulary_id=v.id LEFT JOIN cards c ON c.user_id=w.user_id AND c.word_id=w.word_id WHERE v.user_id=? GROUP BY v.id",
      new Date().toISOString(),
      this.uid,
    );
  }
  async import(vocab: number, rows: unknown[], filename: string) {
    if (rows.length > 3000)
      throw new HttpError("Cloudflare 版单次最多导入 3000 行，请拆分文件");
    if (
      !(await this.one(
        "SELECT id FROM vocabularies WHERE user_id=? AND id=?",
        this.uid,
        vocab,
      ))
    )
      throw new HttpError("目标词库不存在");
    const linked = new Set(
      (
        await this.all(
          "SELECT w.word FROM words w JOIN vocabulary_words v ON v.user_id=w.user_id AND v.word_id=w.id WHERE v.user_id=? AND v.vocabulary_id=?",
          this.uid,
          vocab,
        )
      ).map((w) => w.word.toLowerCase()),
    );
    const unique = new Map<string, Word>(),
      errors: { row: number; reason: string }[] = [];
    let skipped = 0;
    rows.forEach((raw, i) => {
      const parsed = wordSchema.safeParse(raw);
      if (!parsed.success) {
        errors.push({
          row: i + 1,
          reason: parsed.error.issues.map((x) => x.message).join("; "),
        });
        return;
      }
      const w = parsed.data,
        k = w.word.toLowerCase();
      if (linked.has(k)) {
        skipped++;
        return;
      }
      linked.add(k);
      unique.set(k, w);
    });
    const chunks: Word[][] = [];
    let chunk: Word[] = [],
      bytes = 0;
    for (const w of unique.values()) {
      const size = Buffer.byteLength(JSON.stringify(w));
      if (chunk.length >= 500 || bytes + size > 500000) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(w);
      bytes += size;
    }
    if (chunk.length) chunks.push(chunk);
    if (chunks.length > 10) throw new HttpError("文件内容过大，请拆分后导入");
    const card = createEmptyCard();
    for (const values of chunks) {
      const json = JSON.stringify(values);
      this.queue(
        `INSERT INTO words(user_id,word,zh,en,phonetic,pos,example,translation,tags,notes) SELECT ?,json_extract(value,'$.word'),json_extract(value,'$.zh'),json_extract(value,'$.en'),json_extract(value,'$.phonetic'),json_extract(value,'$.pos'),json_extract(value,'$.example'),json_extract(value,'$.translation'),json_extract(value,'$.tags'),json_extract(value,'$.notes') FROM json_each(?) WHERE true ON CONFLICT(user_id,word) DO NOTHING`,
        this.uid,
        json,
      );
      this.queue(
        "INSERT INTO cards(user_id,word_id,json,due,epoch) SELECT ?,id,?,?,? FROM words WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM cards c WHERE c.user_id=words.user_id AND c.word_id=words.id)",
        this.uid,
        JSON.stringify(card),
        card.due.toISOString(),
        crypto.randomUUID(),
        this.uid,
      );
      this.queue(
        "INSERT INTO vocabulary_words(user_id,vocabulary_id,word_id) SELECT ?,?,w.id FROM json_each(?) j JOIN words w ON w.user_id=? AND w.word=json_extract(j.value,'$.word') COLLATE NOCASE WHERE true ON CONFLICT DO NOTHING",
        this.uid,
        vocab,
        json,
        this.uid,
      );
    }
    const result = {
      success: unique.size,
      skipped,
      failed: errors.length,
      errors,
    };
    this.queue(
      "INSERT INTO import_logs(user_id,at,filename,json) VALUES(?,?,?,?)",
      this.uid,
      new Date().toISOString(),
      filename,
      JSON.stringify(result),
    );
    return result;
  }
  async next(vocab = 0, now = new Date()) {
    const p = await this.plan(now),
      words = await this.words(vocab);
    const due = words
      .filter((w) => w.reps > 0 && w.due <= now.toISOString())
      .sort(
        (a, b) =>
          (a.state === 3 ? 0 : 1) - (b.state === 3 ? 0 : 1) ||
          a.due.localeCompare(b.due),
      );
    const word =
      due[0] || (p.newDone < p.cap ? words.find((w) => !w.reps) : null) || null;
    return word ? { ...word, epoch: word.card_epoch } : null;
  }
  async review(
    input: {
      eventId: string;
      wordId: number;
      version: number;
      rating: Grade;
      seconds: number;
      mode: string;
      correct?: boolean | null;
      epoch: string;
    },
    now = new Date(),
  ) {
    if (input.mode === "difficult")
      throw new HttpError("错词专项属于额外练习，不提交正式复习");
    const prior = await this.one(
      "SELECT result,word_id,rating FROM review_logs WHERE user_id=? AND event_id=?",
      this.uid,
      input.eventId,
    );
    if (prior) {
      if (prior.word_id !== input.wordId || prior.rating !== input.rating)
        throw new HttpError("事件 ID 已被其他提交使用", 409);
      return JSON.parse(prior.result);
    }
    const row = await this.one(
      "SELECT * FROM cards WHERE user_id=? AND word_id=?",
      this.uid,
      input.wordId,
    );
    if (!row) throw new HttpError("单词不存在", 404);
    if (input.epoch !== row.epoch)
      throw new HttpError("卡片已被替换，请重新加载", 409);
    if (row.version !== input.version)
      throw new HttpError("卡片已在其他标签页更新，请重新加载", 409);
    const s = this.settings;
    if (s.lastAt && now.getTime() < Date.parse(s.lastAt))
      throw new HttpError("检测到时间回拨，请校正系统时间后学习");
    const p = await this.plan(now);
    if (!row.reps && p.newDone >= p.cap)
      throw new HttpError("今日新词已达上限，仍可继续复习");
    if (row.reps && row.due > now.toISOString())
      throw new HttpError("此卡片尚未到期；额外练习不提交正式复习");
    const card = JSON.parse(row.json) as Card;
    card.due = new Date(card.due);
    if (card.last_review) card.last_review = new Date(card.last_review);
    const result = fsrs({ request_retention: s.retention }).next(
        card,
        now,
        input.rating,
      ),
      version = row.version + 1;
    this.queue(
      "UPDATE cards SET json=?,version=?,due=?,reps=?,lapses=?,state=? WHERE user_id=? AND word_id=?",
      JSON.stringify(result.card),
      version,
      result.card.due.toISOString(),
      result.card.reps,
      result.card.lapses,
      result.card.state,
      this.uid,
      input.wordId,
    );
    if (!row.reps)
      this.queue(
        "UPDATE daily_plans SET new_done=new_done+1 WHERE user_id=? AND day=?",
        this.uid,
        p.day,
      );
    const out = { ...result, version },
      secs = Math.max(0, Math.min(120, Math.round(input.seconds)));
    this.queue(
      "INSERT INTO review_logs(user_id,event_id,word_id,day,at,rating,is_new,seconds,mode,log,result,answer_correct) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      this.uid,
      input.eventId,
      input.wordId,
      p.day,
      now.toISOString(),
      input.rating,
      row.reps === 0 ? 1 : 0,
      secs,
      input.mode,
      JSON.stringify(result.log),
      JSON.stringify(out),
      input.correct == null ? null : Number(input.correct),
    );
    this.queue(
      "INSERT INTO study_sessions(user_id,id,day,seconds) VALUES(?,?,?,?)",
      this.uid,
      input.eventId,
      p.day,
      secs,
    );
    this.queue(
      "UPDATE spaces SET settings=? WHERE user_id=?",
      JSON.stringify({
        ...s,
        firstDay: s.firstDay || p.day,
        lastDay: p.day,
        lastAt: now.toISOString(),
      }),
      this.uid,
    );
    return out;
  }
  async stats() {
    const p = await this.plan();
    const today = (await this.one(
      "SELECT count(*) answers,count(DISTINCT word_id) distinctWords,coalesce(sum(is_new),0) newWords,coalesce(sum(CASE WHEN is_new=0 THEN 1 ELSE 0 END),0) reviews,coalesce(sum(seconds),0) seconds FROM review_logs WHERE user_id=? AND day=?",
      this.uid,
      p.day,
    ))!;
    const counts = await this.one(
      "SELECT count(*) total,coalesce(sum(reps>0),0) learned FROM cards WHERE user_id=?",
      this.uid,
    );
    const accuracy =
      (await this.one(
        "SELECT avg(rating>1)*100 accuracy FROM (SELECT rating FROM review_logs WHERE user_id=? ORDER BY at DESC LIMIT 100)",
        this.uid,
      ))!.accuracy || 0;
    const answerAccuracy = (await this.one(
      "SELECT avg(answer_correct)*100 accuracy FROM (SELECT answer_correct FROM review_logs WHERE user_id=? AND answer_correct IS NOT NULL ORDER BY at DESC LIMIT 100)",
      this.uid,
    ))!.accuracy;
    const calendar = await this.all(
      "SELECT day,count(*) count FROM review_logs WHERE user_id=? GROUP BY day ORDER BY day",
      this.uid,
    );
    const days = new Set(calendar.map((x) => x.day)),
      d = new Date(p.day + "T12:00:00Z");
    let streak = 0;
    if (!days.has(p.day)) d.setUTCDate(d.getUTCDate() - 1);
    while (days.has(d.toISOString().slice(0, 10))) {
      streak++;
      d.setUTCDate(d.getUTCDate() - 1);
    }
    const forecast = await this.all(
      "SELECT substr(due,1,10) day,count(*) count FROM cards WHERE user_id=? AND reps>0 AND due>? GROUP BY substr(due,1,10) ORDER BY day LIMIT 14",
      this.uid,
      new Date().toISOString(),
    );
    return {
      plan: p,
      today,
      counts,
      difficult: (await this.words(0, "", "difficult")).length,
      accuracy,
      answerAccuracy,
      calendar,
      streak,
      forecast,
      completion: Math.min(
        100,
        Math.round(
          ((today.newWords + today.reviews) /
            Math.max(1, p.saved.new_goal + p.saved.review_goal)) *
            100,
        ),
      ),
    };
  }
  async editWord(id: number, input: unknown) {
    const w = wordSchema.parse(input),
      usage = (input as Row).usage;
    const old = await this.one(
      "SELECT * FROM words WHERE user_id=? AND id=?",
      this.uid,
      id,
    );
    if (!old) throw new HttpError("单词不存在", 404);
    if (
      usage !== undefined &&
      (typeof usage !== "string" || usage.length > 4000)
    )
      throw new HttpError("用法过长");
    const kept = JSON.parse(old.ai_fields).filter((key: string) =>
      key === "usage"
        ? usage === undefined || usage === old.usage
        : (w as Row)[key] === old[key],
    );
    this.queue(
      "UPDATE words SET word=?,zh=?,en=?,phonetic=?,pos=?,example=?,translation=?,tags=?,notes=?,usage=?,ai_fields=? WHERE user_id=? AND id=?",
      ...Object.values(w),
      usage ?? old.usage,
      JSON.stringify(kept),
      this.uid,
      id,
    );
    return { ok: true };
  }
  async enrich(id: number, word: string, input: unknown) {
    const fields = enrichmentSchema.parse(input),
      current = await this.one(
        "SELECT * FROM words WHERE user_id=? AND id=?",
        this.uid,
        id,
      );
    if (!current || current.word !== word)
      throw new HttpError("单词已修改或删除，请重新生成", 409);
    const generated = new Set<string>(JSON.parse(current.ai_fields));
    for (const [key, value] of Object.entries(fields))
      if (!String(current[key] || "").trim() && value) {
        current[key] = value;
        generated.add(key);
      }
    current.ai_fields = JSON.stringify([...generated]);
    this.queue(
      "UPDATE words SET zh=?,pos=?,example=?,translation=?,en=?,phonetic=?,usage=?,ai_fields=? WHERE user_id=? AND id=?",
      current.zh,
      current.pos,
      current.example,
      current.translation,
      current.en,
      current.phonetic,
      current.usage,
      current.ai_fields,
      this.uid,
      id,
    );
    return current;
  }
}
