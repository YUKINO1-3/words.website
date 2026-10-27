import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (!existsSync(".dev.vars")) {
  writeFileSync(
    ".dev.vars",
    `AUTH_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log("已生成仅供本地 Workers 开发的加密密钥（.dev.vars，已忽略）。");
} else console.log("保留现有 .dev.vars，不更换加密密钥。");
