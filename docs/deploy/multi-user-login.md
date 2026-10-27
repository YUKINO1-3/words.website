# 多用户登录系统：升级与运维

适用于从 `7e312a2` 单人版升级的 Google Cloud/本地部署。本 PR 不自动部署，不迁移到 D1。

## 行为变化

- 访问首页显示登录/注册页。用户名 3–32 位字母、数字或下划线，大小写不敏感；密码至少 12 个字符。
- 所有业务 API 必须登录。退出、修改密码和写入业务接口使用 CSRF token；浏览器自动处理。
- 每个账号拥有独立的词库、FSRS、统计、设置、AI 缓存、备份和恢复。
- AI 地址、模型和密钥在网页“设置与导出 → 个人 AI 服务”中保存。保存后立即生效，然后开启该账号的 AI 功能并保存设置。
- 填写 OpenAI 兼容 HTTPS Base URL（例如服务商提供的 `/v1` 地址）和模型名称；请求由服务器发起。内网、回环、元数据地址、非 443 端口和跳转被拒绝。DNS 结果经过检查并固定到实际连接。
- 密钥写入账号库前使用 AES-256-GCM 加密；已保存密钥不回显，留空保留，清除需主动操作。账号之间不共享服务器 `.env` 的旧 AI 密钥。
- 新注册账号始终得到空学习空间，不自动拥有已有单人数据。

## 文件与备份边界

```text
DATA_DIR/
  auth.sqlite                 账号、密码哈希、会话和加密后的 AI 配置
  auth-encryption.key         账号密钥加密所需的服务器密钥，权限 600
  vocabflow.sqlite            原有单人学习数据，等待管理员指定归属
  users/<账号ID>/vocabflow.sqlite  新账号自己的学习数据
BACKUP_DIR/
  users/<账号ID>/...           新账号自己的学习备份
```

原有空间的学习备份仍使用原 BACKUP_DIR。不同账号即使单词 ID 相同也操作不同文件。

网页“设置与导出”仅下载当前账号的单词与中文释义 CSV（word、zh 两列），不再提供完整 SQLite 下载或恢复入口。CSV 不包含账号信息、AI 配置、复习日志和 FSRS 状态；可通过导入词库重新导入词汇。以下完整数据备份与恢复说明面向管理员运维。

管理员级灾难恢复必须额外备份 **auth.sqlite、其 WAL（或停机后一致的主文件）及 auth-encryption.key**。不要只备份加密数据库而丢失密钥文件。缺少已有账号库对应的密钥时，服务会拒绝启动，不会悄悄生成无法解密旧数据的替代密钥。

停止服务后可以将整个 DATA_DIR、BACKUP_DIR 和 `.env` 打成私密运维备份；不能把这些文件提交 Git 或放进公开的网页静态目录。

## 一次性升级步骤

1. 单人旧版仍有完整备份入口时，先下载学习备份到自己的电脑；新版设置页仅导出词汇 CSV，完整数据由管理员在停机后备份。
2. 记录原 DATA_DIR、BACKUP_DIR、端口、公网地址，并备份现有 `.env` 和公网适配源码。
3. `sudo systemctl stop vocabflow`。确认停止，避免旧进程继续写入。
4. 按下面“从自己的 Fork 获取分支”更新代码，保留原 data、backups 和 `.env`。已有的公网适配源码先备份并暂存；本分支已包含对应适配，不要直接重新套用旧补丁。
5. 执行 `npm ci && npm run build`，不要删开发依赖，本版运行仍需要 tsx。
6. 合并必要的部署配置，见下一节。
7. 在服务器交互终端创建你自己的账号：

   ```bash
   cd "$HOME/words.website"
   export PATH="$HOME/.local/node24/bin:$PATH"
   npm run account -- create your_username
   ```

   密码在终端交互输入且不回显，不能放进命令行或发给别人。已有注册账号可以跳过创建。

8. 如果要继承原有词库和学习进度，在服务停止时明确指定账号：

   ```bash
   npm run account -- claim-legacy your_username
   ```

   只允许一个账号拥有既有空间。请在这个账号开始新的个人学习前操作；认领不会合并已有个人空间，其原个人空间文件仍保留，但当前账号会改为使用原单人空间。不要用另一个账号反复认领。

9. `sudo systemctl start vocabflow`，然后查看日志和状态。
10. 登录自己的账号，核对原词库、学习进度和 AI 已保存资料。用另一个注册账号验证空空间与隔离。
11. 各账号在网页填写自己的 AI 配置。旧 `.env` 中的 AI 配置不会自动变成全站共享密钥。

创建/重置账号的 CLI 使用当前 DATA_DIR，和应用解析规则相同；切勿从另一个 DATA_DIR 创建账号后误认为部署已配置。

## 获取代码更新

从自己选择的仓库和部署分支获取代码。首次从单人版升级时，先停止服务并私密备份配置与数据，再更新代码、安装依赖并构建；随后继续上面的步骤 6–11，创建账号并认领旧数据。不要只更新代码并重启服务。

后续更新也应先检查工作区、备份数据并停止服务。确认目标分支后执行 `git pull --ff-only`、`npm ci` 和 `npm run build`，每步成功后再继续。部署来源和分支由部署者自行选择，不需要切换到贡献者的个人 Fork。

## Google Cloud IP 测试与 HTTPS

默认 `AUTH_COOKIE_SECURE=true`，Cookie 带 Secure、HttpOnly、SameSite=Strict；需要 HTTPS。推荐域名 + HTTPS 反向代理，配置 `PUBLIC_ORIGIN=https://你的域名`，应用仍监听本机，由代理转发。

保留现有 **HTTP 公网 IP 临时测试** 时，在 `.env` 中显式设置：

```dotenv
PORT=3000
LISTEN_HOST=0.0.0.0
PUBLIC_HOST=服务器当前公网IPv4
AUTH_COOKIE_SECURE=false
```

该选项用于短期兼容测试：HTTP 不加密密码、会话或提交的 API Key。实际账号/付费密钥长期使用前应先配置 HTTPS；此 PR 不替你创建域名或证书。前端已集成 HTTP UUID 回退，不需要再次运行旧的 gcp-ip-test.py。

本地开发使用 HTTP 时也显式设置 `AUTH_COOKIE_SECURE=false`。PUBLIC_ORIGIN 不能填写路径或多个来源。代理需保留原始 Host，并覆盖 X-Forwarded-For。使用同机反向代理时可设置 `TRUST_PROXY=127.0.0.1,::1`，且应用只监听本机；仅这些明确配置的代理 IP 能提供用于登录限流的客户端地址。默认不信任转发头，不能将公网客户端 IP 配为可信代理。

## 验证与日常命令

未登录访问业务接口应返回 JSON 401，而不是显示学习数据：

```bash
curl -i http://127.0.0.1:3000/api/status
```

公开的会话检查只说明是否登录，不暴露学习数据、文件路径或密钥，可用于服务就绪探测：

```bash
curl -i http://127.0.0.1:3000/api/auth/session
```

无 Cookie 时返回 `{ "user": null }`。浏览器登录后才可以读取 status/settings/stats 等。

```bash
sudo systemctl status vocabflow --no-pager
sudo journalctl -u vocabflow -n 60 --no-pager
sudo systemctl restart vocabflow
```

会话默认绝对有效期 7 天，每账号最多保留 10 个会话；退出撤销当前会话；修改密码撤销其他全部会话并重新签发当前会话。登录和注册限流计数在账号库中持久化，不因服务重启清除。

忘记密码时，由管理员在服务器交互终端运行：

```bash
npm run account -- reset-password your_username
```

旧会话立即失效。没有邮件找回和开放的管理员网页，不能通过公网接口认领既有空间或重置任意用户密码。

## 回退

升级前保留旧版源码、配置和完整数据备份。旧版没有登录保护，不能直接在公网开放的防火墙下运行。需要回退时先关闭公网入站规则，停止服务，再根据备份恢复旧版代码和匹配的数据。不要删除当前账号库或加密密钥来“重置故障”。

## 本次验证记录

准确的执行结果见 PR 描述。自动化测试使用独立临时目录，不读取用户真实数据。进程内 Express 测试覆盖真实路由、中间件与数据库，但不等价于网络、代理、TLS 或浏览器验收。实际部署前仍需完成两账号注册登录、AI 实际服务、退出、修改密码、备份恢复和 HTTPS 浏览器验收。
