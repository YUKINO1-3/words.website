import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { z } from "zod";
import { settingsSchema } from "../../packages/shared/schema.ts";
import type { D1Database } from "@cloudflare/workers-types";
import { HttpError, type Row } from "./types.ts";
export type SQL = Pick<D1Database, "prepare" | "batch">;
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
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [, salt, hex] = encoded.split("$");
  const actual = await derive(password, salt || "0".repeat(32));
  const expected = Buffer.from(hex || "00".repeat(64), "hex");
  return (
    encoded.startsWith("scrypt-v1$") &&
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}
export class Auth {
  constructor(
    readonly db: SQL,
    readonly secret: string,
  ) {}
  async throttle(bucket: string, limit: number) {
    const now = Date.now();
    await this.db
      .prepare("DELETE FROM auth_attempts WHERE until_at<=?")
      .bind(now)
      .run();
    const row = await this.db
      .prepare(
        "INSERT INTO auth_attempts(bucket,count,until_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count",
      )
      .bind(bucket, now + 900000)
      .first<Row>();
    if (Number(row?.count) > limit)
      throw new HttpError("尝试过于频繁，请 15 分钟后重试", 429);
  }
  async register(username: string, password: string) {
    const user = {
      id: parseInt(randomBytes(6).toString("hex"), 16),
      username: usernameSchema.parse(username),
      credential_version: 0,
    };
    const hash = await passwordHash(passwordSchema.parse(password));
    try {
      await this.db.batch([
        this.db
          .prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,?)")
          .bind(user.id, user.username, hash),
        this.db
          .prepare("INSERT INTO spaces(user_id,epoch,settings) VALUES(?,?,?)")
          .bind(
            user.id,
            crypto.randomUUID(),
            JSON.stringify(settingsSchema.parse({})),
          ),
      ]);
    } catch (e) {
      if (
        await this.db
          .prepare("SELECT id FROM users WHERE username=?")
          .bind(user.username)
          .first()
      )
        throw new HttpError("用户名已被使用", 409);
      throw e;
    }
    return user;
  }
  async login(username: string, password: string) {
    const row = await this.db
      .prepare(
        "SELECT id,username,password_hash,credential_version FROM users WHERE username=?",
      )
      .bind(usernameSchema.parse(username))
      .first<Row>();
    const ok = await verifyPassword(
      passwordSchema.parse(password),
      row?.password_hash || "",
    );
    if (!ok || !row) throw new HttpError("用户名或密码不正确", 401);
    return row;
  }
  async issue(user: Row) {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url"),
      expiresAt = Date.now() + 7 * 86400000;
    const results = await this.db.batch([
      this.db
        .prepare("DELETE FROM sessions WHERE expires_at<=?")
        .bind(Date.now()),
      this.db
        .prepare(
          "DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 9)",
        )
        .bind(user.id),
      this.db
        .prepare(
          "INSERT INTO sessions(token_hash,user_id,csrf,expires_at,credential_version) SELECT ?,id,?,?,credential_version FROM users WHERE id=? AND credential_version=?",
        )
        .bind(digest(token), csrf, expiresAt, user.id, user.credential_version),
    ]);
    if (!results[2].meta.changes)
      throw new HttpError("凭据已更新，请重新登录", 401, "SESSION_REQUIRED");
    return {
      token,
      user: { id: user.id, username: user.username },
      csrfToken: csrf,
      expiresAt,
    };
  }
  async session(token: string) {
    if (!token || token.length > 100) return null;
    return this.db
      .prepare(
        "SELECT u.id,u.username,u.credential_version,s.csrf,s.expires_at,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id AND u.credential_version=s.credential_version WHERE s.token_hash=? AND s.expires_at>?",
      )
      .bind(digest(token), Date.now())
      .first<Row>();
  }
  async logout(session: Row) {
    await this.db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(session.token_hash)
      .run();
  }
  async changePassword(session: Row, current: string, password: string) {
    const row = await this.db
      .prepare("SELECT password_hash,credential_version FROM users WHERE id=?")
      .bind(session.id)
      .first<Row>();
    if (
      !row ||
      !(await verifyPassword(passwordSchema.parse(current), row.password_hash))
    )
      throw new HttpError("当前密码不正确", 401);
    const hash = await passwordHash(passwordSchema.parse(password));
    const changed = await this.db
      .prepare(
        "UPDATE users SET password_hash=?,credential_version=credential_version+1 WHERE id=? AND credential_version=? RETURNING id,username,credential_version",
      )
      .bind(hash, session.id, row.credential_version)
      .first<Row>();
    if (!changed)
      throw new HttpError("密码已被更新，请重新登录", 401, "SESSION_REQUIRED");
    await this.db
      .prepare("DELETE FROM sessions WHERE user_id=? AND credential_version<?")
      .bind(session.id, changed.credential_version)
      .run();
    return this.issue(changed);
  }
  key() {
    const key = Buffer.from(this.secret || "", "base64");
    if (key.length !== 32)
      throw new HttpError("管理员尚未配置账号加密密钥", 503);
    return key;
  }
  encrypt(id: number, value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    cipher.setAAD(Buffer.from(String(id)));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((x) => x.toString("base64"))
      .join(".");
  }
  decrypt(id: number, value: string) {
    if (!value) return "";
    const [iv, tag, bytes] = value
      .split(".")
      .map((x) => Buffer.from(x, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key(), iv);
    decipher.setAAD(Buffer.from(String(id)));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes), decipher.final()]).toString(
      "utf8",
    );
  }
  async config(id: number, withKey = false) {
    const row = await this.db
      .prepare("SELECT ai_key,ai_url,ai_model FROM users WHERE id=?")
      .bind(id)
      .first<Row>();
    return {
      configured: !!row?.ai_key,
      baseUrl: row?.ai_url || "",
      model: row?.ai_model || "",
      ...(withKey ? { apiKey: this.decrypt(id, row?.ai_key || "") } : {}),
    };
  }
  async saveAI(
    id: number,
    input: {
      baseUrl: string;
      model: string;
      apiKey?: string;
      clearKey?: boolean;
    },
  ) {
    const key = input.clearKey
      ? ""
      : input.apiKey
        ? this.encrypt(id, input.apiKey)
        : null;
    await this.db
      .prepare(
        "UPDATE users SET ai_url=?,ai_model=?,ai_key=coalesce(?,ai_key) WHERE id=?",
      )
      .bind(input.baseUrl, input.model, key, id)
      .run();
    return this.config(id);
  }
}
