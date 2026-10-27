import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  usernameSchema,
  passwordSchema,
  passwordHash,
} from "../apps/worker/auth.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, name, ...options] = process.argv.slice(2);
try {
  if (command !== "reset-password" || !name)
    throw new Error(
      "用法：npm run cf:account -- reset-password 用户名（操作远程 D1）",
    );
  if (
    options.length &&
    (options.length !== 2 || options[0] !== "--config" || !options[1])
  )
    throw new Error("可选配置参数：--config wrangler.personal.jsonc");
  const username = usernameSchema.parse(name);
  if (!process.stdin.isTTY) throw new Error("请在交互终端运行，密码输入不显示");
  const output = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    rl = createInterface({ input: process.stdin, output, terminal: true });
  let password: string, confirm: string;
  try {
    process.stderr.write("远程 D1：输入新密码（至少 12 个字符）：");
    password = await rl.question("");
    process.stderr.write("\n再次输入：");
    confirm = await rl.question("");
    process.stderr.write("\n");
  } finally {
    rl.close();
  }
  if (password !== confirm) throw new Error("两次密码不一致");
  const hash = await passwordHash(passwordSchema.parse(password));
  const dir = mkdtempSync(path.join(tmpdir(), "vocabflow-reset-")),
    file = path.join(dir, "reset.sql");
  try {
    writeFileSync(
      file,
      `UPDATE users SET password_hash='${hash}',credential_version=credential_version+1 WHERE username='${username}';\nDELETE FROM sessions WHERE user_id IN(SELECT id FROM users WHERE username='${username}');\nSELECT username,credential_version FROM users WHERE username='${username}';`,
      { mode: 0o600 },
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/wrangler/bin/wrangler.js"),
        "d1",
        "execute",
        "DB",
        "--remote",
        "--file",
        file,
        ...options,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.status !== 0)
      throw new Error("远程重置失败，请检查 Wrangler 授权和 D1 配置");
    console.log(
      "请确认上述查询返回目标账号；若没有返回行，用户名不存在。旧凭据版本的会话即刻无效。",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
