import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AIConfig } from "./provider.ts";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9_]+$/, "用户名仅允许字母、数字和下划线");
export const passwordSchema = z
  .string()
  .min(12, "密码至少 12 个字符")
  .max(128)
  .refine((v) => Buffer.byteLength(v) <= 256, "密码过长");
export type Account = { id: number; username: string; legacy: number };
export type Session = {
  user: Account;
  csrf: string;
  expiresAt: number;
  tokenHash: string;
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const duration = 7 * 86400_000;
let hashing = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (hashing >= 2)
    throw Object.assign(new Error("服务繁忙，请稍后重试"), { status: 429 });
  hashing++;
  try {
    return await new Promise((resolve, reject) =>
      scrypt(
        password,
        salt,
        64,
        { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    hashing--;
  }
}
async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
async function verify(password: string, encoded: string) {
  const [, salt, hex] = encoded.split("$");
  const key = await derive(
    password,
    salt || "00000000000000000000000000000000",
  );
  const expected = Buffer.from(hex || "00".repeat(64), "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export class Accounts {
  db: DatabaseSync;
  private key: Buffer;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyFile = path.join(dir, "auth-encryption.key");
    try {
      this.key = readFileSync(keyFile);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      if (existsSync(path.join(dir, "auth.sqlite")))
        throw new Error(
          "缺少 auth-encryption.key，请从管理员备份恢复，不要生成替代密钥",
        );
      const key = randomBytes(32);
      try {
        writeFileSync(keyFile, key, { flag: "wx", mode: 0o600 });
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
      }
      this.key = readFileSync(keyFile);
    }
    if (this.key.length !== 32)
      throw new Error("账号加密文件无效，请恢复原始 auth-encryption.key");
    const file = path.join(dir, "auth.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0, ai_key TEXT NOT NULL DEFAULT '', ai_url TEXT NOT NULL DEFAULT '', ai_model TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS single_legacy_owner ON users(legacy) WHERE legacy=1;
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempts(bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);`);
  }
  user(id: number): Account | undefined {
    return this.db
      .prepare("SELECT id,username,legacy FROM users WHERE id=?")
      .get(id) as Account | undefined;
  }
  throttle(bucket: string, limit: number) {
    const now = Date.now();
    this.db.prepare("DELETE FROM auth_attempts WHERE until_at<=?").run(now);
    const row = this.db
      .prepare("SELECT count FROM auth_attempts WHERE bucket=?")
      .get(bucket);
    if (Number(row?.count || 0) >= limit)
      throw Object.assign(new Error("尝试过于频繁，请 15 分钟后重试"), {
        status: 429,
      });
    this.db
      .prepare(
        "INSERT INTO auth_attempts VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1",
      )
      .run(bucket, now + 15 * 60_000);
  }
  async register(username: string, password: string) {
    username = usernameSchema.parse(username);
    passwordSchema.parse(password);
    const encoded = await hashPassword(password);
    try {
      const result = this.db
        .prepare("INSERT INTO users(username,password_hash) VALUES(?,?)")
        .run(username, encoded);
      return this.user(Number(result.lastInsertRowid))!;
    } catch (e: any) {
      if (
        e.code?.startsWith("ERR_SQLITE") &&
        this.db.prepare("SELECT 1 FROM users WHERE username=?").get(username)
      )
        throw Object.assign(new Error("用户名已被使用"), { status: 409 });
      throw e;
    }
  }
  async login(username: string, password: string) {
    username = usernameSchema.parse(username);
    passwordSchema.parse(password);
    const row = this.db
      .prepare("SELECT * FROM users WHERE username=?")
      .get(username) as any;
    const ok = await verify(password, row?.password_hash || "");
    if (
      !ok ||
      !row ||
      this.db.prepare("SELECT password_hash FROM users WHERE id=?").get(row.id)
        ?.password_hash !== row.password_hash
    )
      throw Object.assign(new Error("用户名或密码不正确"), { status: 401 });
    return this.user(row.id)!;
  }
  issue(user: Account) {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url"),
      expiresAt = Date.now() + duration;
    this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(digest(token), user.id, csrf, expiresAt);
    this.db
      .prepare(
        "DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 10)",
      )
      .run(user.id, user.id);
    return { token, csrf, expiresAt, user };
  }
  session(token: string): Session | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?")
      .get(digest(token), Date.now()) as any;
    const user = row && this.user(row.user_id);
    return user
      ? {
          user,
          csrf: row.csrf,
          expiresAt: row.expires_at,
          tokenHash: row.token_hash,
        }
      : undefined;
  }
  logout(session: Session) {
    this.db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(session.tokenHash);
  }
  async changePassword(userId: number, oldPassword: string, password: string) {
    passwordSchema.parse(password);
    const row = this.db
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(userId) as any;
    if (!row || !(await verify(oldPassword, row.password_hash)))
      throw Object.assign(new Error("当前密码不正确"), { status: 401 });
    const encoded = await hashPassword(password);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db
        .prepare(
          "UPDATE users SET password_hash=? WHERE id=? AND password_hash=?",
        )
        .run(encoded, userId, row.password_hash);
      if (r.changes !== 1) throw new Error("密码已发生变化，请重新登录");
      this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async resetPassword(username: string, password: string) {
    passwordSchema.parse(password);
    const row = this.db
      .prepare("SELECT id FROM users WHERE username=?")
      .get(usernameSchema.parse(username));
    if (!row) throw new Error("账号不存在");
    const encoded = await hashPassword(password);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE users SET password_hash=? WHERE id=?")
        .run(encoded, row.id);
      this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(row.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  claimLegacy(username: string) {
    const row = this.db
      .prepare("SELECT id FROM users WHERE username=?")
      .get(usernameSchema.parse(username));
    if (!row) throw new Error("先创建或注册指定账号");
    if (
      this.db
        .prepare("SELECT id FROM users WHERE legacy=1 AND id<>?")
        .get(row.id)
    )
      throw new Error("既有空间已经归属其他账号");
    this.db.prepare("UPDATE users SET legacy=1 WHERE id=?").run(row.id);
    this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(row.id);
  }
  aiConfig(userId: number): AIConfig {
    const row = this.db
      .prepare("SELECT ai_key,ai_url,ai_model FROM users WHERE id=?")
      .get(userId) as any;
    let apiKey = "";
    if (row?.ai_key) {
      const [iv, tag, data] = row.ai_key
        .split(".")
        .map((s: string) => Buffer.from(s, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(Buffer.from(String(userId)));
      decipher.setAuthTag(tag);
      apiKey = Buffer.concat([
        decipher.update(data),
        decipher.final(),
      ]).toString();
    }
    return { apiKey, baseUrl: row?.ai_url || "", model: row?.ai_model || "" };
  }
  publicAI(userId: number) {
    const c = this.aiConfig(userId);
    return { configured: !!c.apiKey, baseUrl: c.baseUrl, model: c.model };
  }
  saveAI(
    userId: number,
    input: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      clearKey?: boolean;
    },
  ) {
    let encrypted = String(
      this.db.prepare("SELECT ai_key FROM users WHERE id=?").get(userId)
        ?.ai_key || "",
    );
    if (input.clearKey) encrypted = "";
    else if (input.apiKey) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(Buffer.from(String(userId)));
      const bytes = Buffer.concat([
        cipher.update(input.apiKey, "utf8"),
        cipher.final(),
      ]);
      encrypted = [iv, cipher.getAuthTag(), bytes]
        .map((b) => b.toString("base64url"))
        .join(".");
    }
    this.db
      .prepare("UPDATE users SET ai_key=?,ai_url=?,ai_model=? WHERE id=?")
      .run(encrypted, input.baseUrl, input.model, userId);
    return this.publicAI(userId);
  }
  close() {
    this.db.close();
  }
}
