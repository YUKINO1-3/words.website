import dotenv from "dotenv";
import express from "express";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { z } from "zod";
import {
  Accounts,
  usernameSchema,
  passwordSchema,
  type Session,
} from "./auth.ts";
import { createWorkspace } from "./workspace.ts";
import { validateBaseUrl } from "./provider.ts";
import { root } from "./store.ts";
import { fileURLToPath } from "node:url";

dotenv.config({ path: path.join(root, ".env"), quiet: true });
export function createApplication(
  dataDir = path.resolve(root, process.env.DATA_DIR || "data"),
  backupDir = path.resolve(root, process.env.BACKUP_DIR || "backups"),
) {
  const trustedProxies = (process.env.TRUST_PROXY || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  if (trustedProxies.some((ip) => !isIP(ip)))
    throw new Error("TRUST_PROXY 只能填写逗号分隔的可信代理 IP 地址");
  const accounts = new Accounts(dataDir);
  const app = express();
  const port = Number(process.env.PORT || 3000);
  const secureCookie = process.env.AUTH_COOKIE_SECURE !== "false";
  const cookieName = secureCookie
    ? "__Host-vocabflow-session"
    : "vocabflow-session";
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "strict" as const,
    path: "/",
  };
  const workspaces = new Map<number, ReturnType<typeof createWorkspace>>();
  app.disable("x-powered-by");
  if (trustedProxies.length) app.set("trust proxy", trustedProxies);
  app.use("/api/auth", express.json({ limit: "16kb" }));
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    ...(process.env.PUBLIC_HOST
      ? [`http://${process.env.PUBLIC_HOST}:${port}`]
      : []),
    ...(process.env.PUBLIC_ORIGIN
      ? [new URL(process.env.PUBLIC_ORIGIN).origin]
      : []),
  ]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).hostname));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Vary", "Cookie");
    if (!hosts.has(req.hostname))
      return res.status(403).json({ error: "不允许的主机名" });
    if (req.headers.origin && !origins.has(req.headers.origin))
      return res.status(403).json({ error: "不允许的来源" });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.status(403).json({ error: "不允许跨站请求" });
    next();
  });
  function readSession(req: express.Request) {
    const tokens = (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .filter((v) => v.startsWith(cookieName + "="));
    if (tokens.length !== 1) return;
    return accounts.session(tokens[0].slice(cookieName.length + 1));
  }
  function requireSession(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    const session = readSession(req);
    if (!session)
      return res
        .status(401)
        .json({ error: "请先登录", code: "SESSION_REQUIRED" });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers["x-csrf-token"] !== session.csrf
    )
      return res.status(403).json({ error: "会话校验失败，请刷新页面" });
    res.locals.session = session;
    next();
  }
  function startSession(
    res: express.Response,
    user: Parameters<Accounts["issue"]>[0],
  ) {
    const issued = accounts.issue(user);
    res.cookie(cookieName, issued.token, {
      ...cookieOptions,
      maxAge: issued.expiresAt - Date.now(),
    });
    return {
      user: { id: user.id, username: user.username },
      csrfToken: issued.csrf,
      expiresAt: issued.expiresAt,
    };
  }
  const credentials = z.object({
    username: usernameSchema,
    password: passwordSchema,
  });
  app.get("/api/auth/session", (req, res) => {
    const session = readSession(req);
    res.json(
      session
        ? {
            user: { id: session.user.id, username: session.user.username },
            csrfToken: session.csrf,
            expiresAt: session.expiresAt,
          }
        : { user: null },
    );
  });
  app.post("/api/auth/register", async (req, res) => {
    accounts.throttle("register-ip:" + (req.ip || req.socket.remoteAddress), 5);
    const input = credentials.parse(req.body);
    const user = await accounts.register(input.username, input.password);
    res.status(201).json(startSession(res, user));
  });
  app.post("/api/auth/login", async (req, res) => {
    accounts.throttle("login-ip:" + (req.ip || req.socket.remoteAddress), 20);
    const input = credentials.parse(req.body);
    accounts.throttle("login-name:" + input.username, 10);
    const user = await accounts.login(input.username, input.password);
    accounts.db
      .prepare("DELETE FROM auth_attempts WHERE bucket=?")
      .run("login-name:" + input.username);
    const previous = readSession(req);
    if (previous) accounts.logout(previous);
    res.json(startSession(res, user));
  });
  app.post("/api/auth/logout", requireSession, (_, res) => {
    accounts.logout(res.locals.session);
    res.clearCookie(cookieName, cookieOptions);
    res.json({ ok: true });
  });
  app.post("/api/auth/password", requireSession, async (req, res) => {
    const input = z
      .object({ currentPassword: passwordSchema, password: passwordSchema })
      .parse(req.body);
    const session = res.locals.session as Session;
    accounts.throttle("password:" + session.user.id, 10);
    await accounts.changePassword(
      session.user.id,
      input.currentPassword,
      input.password,
    );
    res.json(startSession(res, session.user));
  });
  app.use("/api", requireSession, express.json({ limit: "12mb" }));
  app.get("/api/account/ai", (_, res) =>
    res.json(accounts.publicAI(res.locals.session.user.id)),
  );
  app.put("/api/account/ai", (req, res) => {
    const input = z
      .object({
        baseUrl: z.string().trim().min(1).max(1000),
        model: z.string().trim().min(1).max(200),
        apiKey: z.string().trim().min(1).max(8192).optional(),
        clearKey: z.boolean().optional(),
      })
      .parse(req.body);
    const url = validateBaseUrl(input.baseUrl);
    input.baseUrl = url.href.replace(/\/$/, "");
    res.json(accounts.saveAI(res.locals.session.user.id, input));
  });
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const user = (res.locals.session as Session).user;
    let workspace = workspaces.get(user.id);
    if (!workspace) {
      const userData = user.legacy
        ? dataDir
        : path.join(dataDir, "users", String(user.id));
      const userBackups = user.legacy
        ? backupDir
        : path.join(backupDir, "users", String(user.id));
      mkdirSync(userData, { recursive: true, mode: 0o700 });
      chmodSync(userData, 0o700);
      workspace = createWorkspace({
        dataDir: userData,
        backupDir: userBackups,
        getAiConfig: () => accounts.aiConfig(user.id),
      });
      workspaces.set(user.id, workspace);
    }
    workspace.router(req, res, next);
  });
  app.use(express.static(path.join(root, "dist")));
  app.use("/api", (_, res) => res.status(404).json({ error: "接口不存在" }));
  app.get("/{*path}", (_, res) => {
    if (existsSync(path.join(root, "dist/index.html")))
      res.sendFile(path.join(root, "dist/index.html"));
    else res.status(404).send("请运行 npm run dev 或先 npm run build");
  });
  app.use(
    (
      err: any,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(
        new Date().toISOString(),
        req.method,
        req.path,
        err instanceof z.ZodError
          ? "validation"
          : err.code || err.name || "Error",
      );
      res.status(err.status || 400).json({
        error:
          err instanceof z.ZodError
            ? err.issues.map((x: any) => x.message).join("；")
            : err.message || "操作失败",
      });
    },
  );
  function close() {
    for (const workspace of workspaces.values()) workspace.close();
    accounts.close();
  }
  return { app, close, dataDir };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { app, close, dataDir } = createApplication();
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(
    port,
    process.env.LISTEN_HOST || "127.0.0.1",
    () => {
      const address = server.address();
      console.log(
        `VocabFlow AI http://127.0.0.1:${typeof address === "object" && address ? address.port : port}\n数据: ${dataDir}`,
      );
    },
  );
  server.on("error", (e: any) => {
    console.error(
      e.code === "EADDRINUSE"
        ? `端口 ${port} 已占用。请关闭自己的旧实例，或修改 .env 的 PORT；不会终止其他进程。`
        : e.message,
    );
    process.exitCode = 1;
    close();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () =>
      server.close(() => {
        close();
        process.exit(0);
      }),
    );
}
