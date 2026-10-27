import dotenv from "dotenv";
import path from "node:path";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { Accounts } from "../apps/api/auth.ts";
import { root } from "../apps/api/store.ts";
dotenv.config({ path: path.join(root, ".env"), quiet: true });
const [command, username] = process.argv.slice(2);
if (
  !["create", "reset-password", "claim-legacy"].includes(command) ||
  !username
) {
  console.error(
    "用法：npm run account -- create|reset-password|claim-legacy 用户名",
  );
  process.exit(1);
}
const accounts = new Accounts(
  path.resolve(root, process.env.DATA_DIR || "data"),
);
try {
  if (command === "claim-legacy") {
    accounts.claimLegacy(username);
    console.log(
      "既有空间已归属指定账号。请重启服务，再重新登录。不要在账号已有个人数据时认领，否则原个人空间会暂时不可见。",
    );
  } else {
    if (!process.stdin.isTTY)
      throw new Error("请在交互终端运行，密码不会作为命令行参数读取");
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const rl = createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    let password: string, confirm: string;
    try {
      process.stderr.write("新密码（至少 12 个字符，输入不显示）：");
      password = await rl.question("");
      process.stderr.write("\n再次输入：");
      confirm = await rl.question("");
      process.stderr.write("\n");
    } finally {
      rl.close();
    }
    if (password !== confirm) throw new Error("两次密码不一致");
    if (command === "create") await accounts.register(username, password);
    else await accounts.resetPassword(username, password);
    console.log(
      command === "create" ? "账号已创建。" : "密码已重置，旧会话已撤销。",
    );
  }
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  accounts.close();
}
