# Cloudflare Workers + D1 部署

本方案将 React 静态页面和 `/api/*` 部署到同一个 Cloudflare Worker，使用 D1 保存账号、词库、学习进度和个人 AI 配置。原有 Node/SQLite 部署仍可独立使用。

每位部署者需要自己的 Cloudflare 账号、D1 数据库和加密主密钥。仓库中的数据库 ID 是占位符，不关联任何现有站点；部署不会迁移其他站点的数据。

## 环境准备

安装 Node.js 24 和 npm，在项目根目录执行：

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

确认登录的是目标 Cloudflare 账号，且具有 Workers 和 D1 写入权限。

## 首次部署

1. 修改 `wrangler.jsonc` 的 `name`，作为自己的 Worker 名称，例如 `my-vocabulary`。默认 `vocabflow` 也可使用；Worker 名称位于各自账号下。
2. 创建自己的 D1 数据库：

```bash
npx wrangler d1 create vocabflow
```

3. 将返回的 `database_name` 和 `database_id` 填入 `wrangler.jsonc` 的 `d1_databases`。保留 `binding: "DB"` 和 `migrations_dir`。必须替换全零的占位 ID。
4. 初始化远程数据库：

```bash
npm run cf:migrate:remote
```

5. 生成独立的 32 字节随机加密密钥，并保存到自己的密码管理器或私密备份中：

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put AUTH_ENCRYPTION_KEY
```

在 Wrangler 的交互提示中粘贴刚生成的值。该密钥用于加密数据库中的个人 AI Key，不应提交仓库或写入构建变量。**只有全新站点才生成新密钥；已有站点必须保留原值，否则已有 AI Key 将无法解密。**

6. 构建、测试并发布，每条命令成功后再执行下一条：

```bash
npm run build
npm test
npx wrangler deploy
```

Wrangler 会输出自己的站点地址，通常为 `https://<worker-name>.<account-subdomain>.workers.dev`。发布上传 Worker 和 `dist/` 静态资源，不上传 `.env`、本地 SQLite 或私有导入文件。

## 上线验证与开始使用

访问 Wrangler 输出的地址，确认页面正常。检查公开会话接口：

```bash
curl -fsS https://<你的站点地址>/api/auth/session
```

未登录时应返回 `{"user":null}`。然后注册账号，导入含 `word`、`zh` 列的 CSV，在“个人 AI 服务”中填写自己的 Base URL、模型和 API Key，保存并启用 AI。

新站使用空数据库。原 Node/SQLite 的账号、密码、AI Key、学习进度和日志不会自动迁移；可在旧站导出词汇 CSV，再导入新站。

## 后续更新

使用相同的配置、数据库和加密主密钥：

```bash
npm ci
npm run build
npm test
npm run cf:migrate:remote
npx wrangler deploy
```

`--remote` 操作线上数据库，`--local` 操作本地数据库，两者互不相通。迁移失败时不要继续发布。普通代码更新不需要重新设置 Secret。

## 本机开发

```bash
npm ci
npm run build
npm run cf:local:init
npm run cf:dev
```

访问 Wrangler 输出的本地地址。初始化脚本仅在 `.dev.vars` 不存在时生成本地加密密钥，不会替换已有密钥。本地数据库保存在 `.wrangler/`，不影响线上数据。本地开发可以使用仓库中的占位数据库 ID。

## 将个人配置与仓库分开

维护上游贡献或多个独立站点时，可将配置复制到已被 Git 忽略的 `wrangler.personal.jsonc`，在该文件中填写自己的 Worker 名称和 D1 ID。不要将个人配置或密钥提交到上游。

所有线上操作都需要显式指定同一个配置，例如：

```bash
npx wrangler secret put AUTH_ENCRYPTION_KEY --config wrangler.personal.jsonc
npx wrangler d1 migrations apply DB --remote --config wrangler.personal.jsonc
npm run build
npm test
npx wrangler deploy --config wrangler.personal.jsonc
```

首次创建密钥之后，后续更新跳过 `secret put`。默认 `npm run cf:deploy` 和 `npm run cf:migrate:remote` 使用仓库的 `wrangler.jsonc`，不会自动选取个人配置。

## Git 自动部署（可选）

在 Cloudflare 控制台进入目标 Worker 的 Settings → Builds，连接自己的仓库并设置：

| 设置              | 值                                                 |
| ----------------- | -------------------------------------------------- |
| Production branch | 自己的生产分支，例如 `main`                        |
| Root directory    | `/`                                                |
| Build command     | `npm run build && npm test`                        |
| Deploy command    | `npm run cf:migrate:remote && npx wrangler deploy` |
| Node.js           | `24`（也可设置 `NODE_VERSION=24`）                 |

此方式要求构建检出的 `wrangler.jsonc` 已填写该站点自己的 D1 ID；被 Git 忽略的个人配置不会出现在云端构建环境中。不要在共享上游仓库写入某个部署者的数据库 ID。部署 Token 需具备 Workers 和 D1 写入权限。

运行时 `AUTH_ENCRYPTION_KEY` 通过 Worker Secret 管理，不要放进构建变量，也不要在每次构建时重新生成。不要省略开发依赖，构建和测试需要 TypeScript、tsx 和 Wrangler。

连接仓库后，检查首次构建记录中的分支、提交和发布结果；本机手动发布成功不代表 Git 自动部署已经配置成功。

## 数据与运维

- 所有学习数据按 `user_id` 隔离，服务端通过会话确定账号；D1 `batch()`、版本校验与复习事件幂等处理并发学习更新。
- 密码使用带随机盐的 scrypt。会话使用 HttpOnly、Secure、SameSite=Strict Cookie，写操作校验 CSRF。注册、登录和密码修改的限流仍然保留。
- 个人 AI Key 使用 AES-256-GCM 加密，不回显、不包含在词汇导出中。每个站点必须备份自己的加密主密钥。
- AI 不设置域名白名单、协议或端口限制，允许重定向；生成和连接测试不设置每日次数或请求间隔限制。实际连通性及服务商额度仍取决于运行平台和所选服务。
- AI 请求超时为 45 秒，响应最大 2 MiB。单次词库导入最多 3000 行，请求大小最多 4 MiB。
- 管理员完整备份可使用 D1 导出或 Time Travel；备份包含账号和学习信息，应私密保存。恢复 AI 配置还需要原加密主密钥。

管理员重置线上账号密码：

```bash
npm run cf:account -- reset-password 用户名
```

命令要求交互输入密码，不会创建不存在的账号。它默认使用 `wrangler.jsonc`。使用个人配置时：

```bash
npm run cf:account -- reset-password 用户名 --config wrangler.personal.jsonc
```

Workers 和 D1 的额度、平台限制与费用取决于账号套餐；外部 AI 费用由所选服务商收取。

## 验证范围

本地自动化测试覆盖真实 workerd/D1 的账号隔离、密钥加密、CSRF、导入导出、并发复习及会话撤销。AI 测试使用模拟服务，覆盖自定义地址、重定向设置、缓存，以及超过旧配额和连续请求的场景，不消耗真实 AI 额度。实际第三方 AI 的端到端连接需部署者使用自己的配置验证。
