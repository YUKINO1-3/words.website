import { z } from "zod";
import type { Env, Row } from "./types.ts";
import { HttpError } from "./types.ts";
import { Auth, usernameSchema, passwordSchema } from "./auth.ts";
import { D1Store } from "./store.ts";
import { providerURL, generateAI, testAIConnection } from "./ai.ts";
import { readImport, fields } from "../api/importer.ts";
import { enrichmentSchema } from "../api/enrichment.ts";
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
const positive = (v: unknown) => z.coerce.number().int().positive().parse(v);
async function body(request: Request, max = 4 * 1024 * 1024) {
  if (Number(request.headers.get("content-length")) > max)
    throw new HttpError("请求过大，请拆分文件", 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) throw new HttpError("请求过大，请拆分文件", 413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
function cookieName(url: URL) {
  return url.protocol === "https:"
    ? "__Host-vocabflow-session"
    : "vocabflow-session";
}
function token(request: Request, name: string) {
  const parts = (request.headers.get("cookie") || "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(name + "="));
  return parts.length === 1 ? parts[0].slice(name.length + 1) : "";
}
function attachSession(data: Awaited<ReturnType<Auth["issue"]>>, url: URL) {
  const { token, ...result } = data,
    r = json(result);
  r.headers.set(
    "Set-Cookie",
    `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${url.protocol === "https:" ? "; Secure" : ""}`,
  );
  return r;
}
function csv(rows: Row[], columns: string[]) {
  return (
    "\uFEFF" +
    [columns, ...rows.map((w) => columns.map((k) => w[k]))]
      .map((row) =>
        row
          .map(
            (v) =>
              '"' +
              String(v ?? "")
                .replace(/^[=+@\-]/, "'$&")
                .replaceAll('"', '""') +
              '"',
          )
          .join(","),
      )
      .join("\r\n")
  );
}
async function api(request: Request, env: Env) {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new HttpError("请使用 HTTPS", 403);
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== url.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new HttpError("不允许跨站请求", 403);
  const db = env.DB.withSession("first-primary"),
    auth = new Auth(db, env.AUTH_ENCRYPTION_KEY);
  const session = await auth.session(token(request, cookieName(url)));
  if (path === "/api/auth/session" && method === "GET")
    return json(
      session
        ? {
            user: { id: session.id, username: session.username },
            csrfToken: session.csrf,
            expiresAt: session.expires_at,
          }
        : { user: null },
    );
  if (
    ["/api/auth/register", "/api/auth/login"].includes(path) &&
    method === "POST"
  ) {
    auth.key();
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    await auth.throttle(
      (path.endsWith("register") ? "register:" : "login:") + ip,
      path.endsWith("register") ? 5 : 20,
    );
    let credentials: unknown;
    const raw = await body(request, 16384);
    try {
      credentials = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new HttpError("请求必须是有效 JSON");
    }
    const input = z
      .object({ username: usernameSchema, password: passwordSchema })
      .parse(credentials);
    if (path.endsWith("register"))
      return attachSession(
        await auth.issue(await auth.register(input.username, input.password)),
        url,
      );
    await auth.throttle("login-name:" + input.username, 10);
    const user = await auth.login(input.username, input.password);
    if (session) await auth.logout(session);
    return attachSession(await auth.issue(user), url);
  }
  if (!session)
    return json({ error: "请先登录", code: "SESSION_REQUIRED" }, 401);
  if (
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    request.headers.get("X-CSRF-Token") !== session.csrf
  )
    throw new HttpError("会话校验失败，请刷新页面", 403);
  if (path === "/api/auth/logout" && method === "POST") {
    await auth.logout(session);
    const r = json({ ok: true });
    r.headers.set(
      "Set-Cookie",
      `${cookieName(url)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`,
    );
    return r;
  }
  const isPreview = path === "/api/import/preview";
  let input: Row = {};
  if (!["GET", "HEAD"].includes(method) && !isPreview) {
    try {
      const text = new TextDecoder().decode(
        await body(
          request,
          path.startsWith("/api/auth/") ? 16384 : 4 * 1024 * 1024,
        ),
      );
      input = text ? JSON.parse(text) : {};
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new HttpError("请求必须是 JSON 对象");
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError("请求必须是有效 JSON");
    }
  }
  if (path === "/api/auth/password" && method === "POST") {
    await auth.throttle("password:" + session.id, 10);
    const p = z
      .object({ currentPassword: passwordSchema, password: passwordSchema })
      .parse(input);
    return attachSession(
      await auth.changePassword(session, p.currentPassword, p.password),
      url,
    );
  }
  if (path === "/api/account/ai/test" && method === "POST") {
    const inputConfig = z
      .object({
        baseUrl: z.string().trim().min(1).max(1000),
        model: z.string().trim().min(1).max(200),
        apiKey: z.string().trim().max(4000).optional(),
      })
      .parse(input);
    return json(await testAIConnection(auth, env, session.id, inputConfig));
  }
  if (path === "/api/account/ai") {
    if (method === "GET") return json(await auth.config(session.id));
    if (method === "PUT") {
      const p = z
        .object({
          baseUrl: z.string().max(1000),
          model: z.string().trim().min(1).max(200),
          apiKey: z.string().trim().max(4000).optional(),
          clearKey: z.boolean().optional(),
        })
        .parse(input);
      p.baseUrl = providerURL(p.baseUrl);
      return json(await auth.saveAI(session.id, p));
    }
  }
  if (isPreview && method === "POST") {
    const bytes = await body(request),
      form = await new Response(bytes, {
        headers: { "Content-Type": request.headers.get("content-type") || "" },
      }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string")
      throw new HttpError("请选择词库文件");
    const preview = await readImport(
      Buffer.from(await file.arrayBuffer()),
      file.name,
    );
    if (preview.rows.length > 3000)
      throw new HttpError("Cloudflare 版单次最多导入 3000 行，请拆分文件");
    return json(preview);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const store = await new D1Store(db, session.id).init();
    try {
      if (path === "/api/ai" && method === "POST")
        return json(
          await generateAI(
            store,
            auth,
            env,
            z
              .object({
                wordId: z.number().int().positive().optional(),
                kind: z.string().max(50).optional(),
              })
              .parse(input),
          ),
        );
      let result: unknown;
      if (path === "/api/status" && method === "GET")
        result = {
          storage: "d1",
          aiConfigured: (await auth.config(session.id)).configured,
        };
      else if (path === "/api/settings" && method === "GET")
        result = store.settings;
      else if (path === "/api/settings" && method === "PUT")
        result = store.saveSettings(input);
      else if (path === "/api/stats" && method === "GET")
        result = await store.stats();
      else if (path === "/api/vocabularies" && method === "GET")
        result = await store.vocabularies();
      else if (path === "/api/vocabularies" && method === "POST") {
        const name = z.string().trim().min(1).max(100).parse(input.name),
          id = parseInt(
            crypto.randomUUID().replaceAll("-", "").slice(0, 12),
            16,
          );
        store.queue(
          "INSERT INTO vocabularies(id,user_id,name) VALUES(?,?,?)",
          id,
          session.id,
          name,
        );
        result = { id };
      } else if (
        /^\/api\/vocabularies\/\d+$/.test(path) &&
        ["PUT", "DELETE"].includes(method)
      ) {
        const id = positive(path.split("/").pop());
        if (
          !(await store.one(
            "SELECT id FROM vocabularies WHERE user_id=? AND id=?",
            session.id,
            id,
          ))
        )
          throw new HttpError("词库不存在", 404);
        if (method === "PUT")
          store.queue(
            "UPDATE vocabularies SET name=? WHERE user_id=? AND id=?",
            z.string().trim().min(1).max(100).parse(input.name),
            session.id,
            id,
          );
        else
          store.queue(
            "DELETE FROM vocabularies WHERE user_id=? AND id=?",
            session.id,
            id,
          );
        result = { ok: true };
      } else if (path === "/api/words" && method === "GET")
        result = await store.words(
          Number(url.searchParams.get("vocab")) || 0,
          url.searchParams.get("q") || "",
          url.searchParams.get("filter") || "",
        );
      else if (path === "/api/words" && method === "POST")
        result = await store.import(
          positive(input.vocab),
          [input.word],
          "手动添加",
        );
      else if (
        /^\/api\/words\/\d+$/.test(path) &&
        ["PUT", "DELETE"].includes(method)
      ) {
        const id = positive(path.split("/").pop());
        if (method === "PUT") result = await store.editWord(id, input);
        else {
          if (
            !(await store.one(
              "SELECT id FROM words WHERE user_id=? AND id=?",
              session.id,
              id,
            ))
          )
            throw new HttpError("单词不存在", 404);
          store.queue(
            "DELETE FROM words WHERE user_id=? AND id=?",
            session.id,
            id,
          );
          result = { ok: true };
        }
      } else if (
        /^\/api\/words\/\d+\/ai-content$/.test(path) &&
        method === "POST"
      ) {
        const p = z
          .object({ word: z.string(), fields: enrichmentSchema })
          .parse(input);
        result = await store.enrich(
          positive(path.split("/")[3]),
          p.word,
          p.fields,
        );
      } else if (path === "/api/import" && method === "POST") {
        const p = z
          .object({
            vocab: z.number().int().positive(),
            filename: z.string().max(200),
            rows: z.array(z.array(z.string().max(4000)).max(30)).max(3000),
            mapping: z
              .array(z.string().refine((v) => v === "" || fields.includes(v)))
              .max(30),
          })
          .parse(input);
        const selected = p.mapping.filter(Boolean);
        if (
          new Set(selected).size !== selected.length ||
          !selected.includes("word")
        )
          throw new HttpError("字段不能重复，且必须匹配英文单词");
        result = await store.import(
          p.vocab,
          p.rows.map((row) =>
            Object.fromEntries(
              p.mapping.flatMap((f, i) => (f ? [[f, row[i] || ""]] : [])),
            ),
          ),
          p.filename,
        );
      } else if (path === "/api/import/logs" && method === "GET")
        result = await store.all(
          "SELECT id,at,filename,json FROM import_logs WHERE user_id=? ORDER BY id DESC LIMIT 50",
          session.id,
        );
      else if (path === "/api/next" && method === "GET")
        result = await store.next(Number(url.searchParams.get("vocab")) || 0);
      else if (path === "/api/review" && method === "POST")
        result = await store.review(
          z
            .object({
              eventId: z.string().uuid(),
              wordId: z.number().int().positive(),
              version: z.number().int().nonnegative(),
              rating: z
                .number()
                .int()
                .min(1)
                .max(4)
                .transform((v) => v as 1 | 2 | 3 | 4),
              seconds: z.number().finite().min(0).max(3600),
              mode: z.enum([
                "card",
                "choice",
                "spelling",
                "listening",
                "difficult",
              ]),
              correct: z.boolean().nullable().optional(),
              epoch: z.string().uuid(),
            })
            .parse(input),
        );
      else if (path === "/api/export" && method === "GET") {
        const reviews = url.searchParams.get("type") === "reviews",
          simple = url.searchParams.get("type") === "vocabulary";
        const columns = reviews
          ? [
              "event_id",
              "word_id",
              "day",
              "at",
              "rating",
              "is_new",
              "seconds",
              "mode",
              "answer_correct",
              "log",
            ]
          : simple
            ? ["word", "zh"]
            : fields;
        const rows = reviews
          ? await store.all(
              "SELECT * FROM review_logs WHERE user_id=? ORDER BY at",
              session.id,
            )
          : await store.words(
              simple ? 0 : Number(url.searchParams.get("vocab")) || 0,
            );
        return new Response(csv(rows, columns), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${simple ? "vocabflow-vocabulary.csv" : "vocabflow.csv"}"`,
            "Cache-Control": "no-store",
            Vary: "Cookie",
          },
        });
      } else throw new HttpError("接口不存在", 404);
      await store.commit();
      return json(result);
    } catch (e) {
      if (String((e as Error).message).includes("workspace_conflict")) {
        if (attempt < 2) continue;
        throw new HttpError("其他页面正在更新，请重试", 409);
      }
      throw e;
    }
  }
  throw new HttpError("请重试", 409);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api/"))
      return env.ASSETS.fetch(request as any) as any;
    try {
      return await api(request, env);
    } catch (e) {
      if (e instanceof HttpError)
        return json(
          { error: e.message, ...(e.code ? { code: e.code } : {}) },
          e.status,
        );
      if (e instanceof z.ZodError)
        return json({ error: e.issues.map((i) => i.message).join("；") }, 400);
      const message = String((e as Error).message);
      if (message.includes("UNIQUE constraint"))
        return json({ error: "名称已存在，请换一个名称" }, 409);
      // Never log SQL parameters, passwords, provider responses, or credentials.
      console.error(
        "Worker request failed",
        request.method,
        new URL(request.url).pathname,
      );
      return json(
        {
          error:
            "请求失败，请稍后重试；若持续发生，请管理员检查 D1 迁移和密钥配置",
        },
        500,
      );
    }
  },
};
