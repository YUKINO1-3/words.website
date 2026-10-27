import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("需要 Node.js 24 LTS 或更高版本：https://nodejs.org/");
  process.exit(1);
}
const command = process.argv[2] || "start";
const npm = (args) => {
  const r = spawnSync(
    process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32"
      ? ["/d", "/s", "/c", `npm ${args.join(" ")}`]
      : args,
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (r.status !== 0) process.exit(r.status || 1);
};
if (command === "install") {
  if (!existsSync(".env")) copyFileSync(".env.example", ".env");
  npm(["ci"]);
  npm(["run", "build"]);
  console.log("安装完成。以后双击“启动网站.bat”即可。");
} else if (command === "configure") {
  if (!existsSync(".env")) copyFileSync(".env.example", ".env");
  console.log(
    "配置文件已准备好。本地 HTTP 测试请设置 AUTH_COOKIE_SECURE=false；个人 AI 密钥在登录后的网页设置中填写。",
  );
  if (process.platform === "win32")
    spawn("notepad.exe", [path.join(root, ".env")], { stdio: "ignore" });
  else console.log(path.join(root, ".env"));
} else {
  if (!existsSync("node_modules")) {
    console.error("请先运行首次安装脚本。");
    process.exit(1);
  }
  if (!existsSync("dist/index.html")) npm(["run", "build"]);
  const env = readFileSync(
    existsSync(".env") ? ".env" : ".env.example",
    "utf8",
  );
  const port = process.env.PORT || env.match(/^PORT=(\d+)/m)?.[1] || "3000";
  const url = `http://127.0.0.1:${port}`;
  try {
    const { createServer } = await import("node:net");
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(Number(port), "127.0.0.1", () => probe.close(resolve));
    });
  } catch {
    console.error(
      `端口 ${port} 已被占用，请关闭自己的旧实例或修改 .env 的 PORT。未终止任何进程。`,
    );
    process.exit(1);
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/server.ts"],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => process.exit(code || 0));
  let opened = false;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const response = await fetch(url + "/api/auth/session");
      if (response.ok) {
        if (process.platform === "win32")
          spawn("cmd.exe", ["/c", "start", "", url], {
            windowsHide: true,
            stdio: "ignore",
          });
        else spawn("open", [url], { stdio: "ignore" });
        opened = true;
        break;
      }
    } catch {}
  }
  if (!opened) console.error("服务未就绪，请查看上方错误信息。");
  console.log("关闭网站服务：在此窗口按 Ctrl+C。");
  process.on("SIGINT", () => child.kill("SIGINT"));
}
