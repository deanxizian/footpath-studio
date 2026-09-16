# 每日自动抓取

`Daily Stryd Footpath` 每天 **06:20 Asia/Shanghai**（UTC 22:20，`20 22 * * *`）运行一次。GitHub 的定时触发可能延迟；也可以在 Actions 页面手动运行。公共仓库长期没有活动时，GitHub 可能暂停定时工作流，需在 Actions 页面重新启用。

## 数据流程

1. 从已审阅的 `main` 执行代码，只使用受保护的 `stryd-sync` 环境凭据。
2. 从最新月份 Release 读取完整历史目录与总索引，校验来源、附件摘要及内容。不读写任何数据 PR 或数据分支。
3. 分页扫描全部 Stryd 日历，因此旧活动今天才上传的 Footpath 也能被发现。下载新记录，重查最近 14 天的已归档记录。上游尚未处理完成的记录下次重试；每次默认最多检查 100 份，可手动设为 1–500，并启用 `recheck_all` 检查更早记录。
4. 新增或修订记录通过原始内容摘要去重。没有数据变化时，不下载完整历史、不更新月份数据包。
5. 有变化时校验并合并历史，只上传变化的月份包。每月固定一个 `footpath-YYYY-MM` Release，旧月份不变，新月份才创建 Release。全部上传成功后更新最新月份的总目录，未变化的包复用原固定 URL 和 SHA-256。
6. 比较生产网页和 Release 中的数据版本。有新数据或上次部署失败时，通过 Vercel Deploy Hook 重新构建 `main`，等待网页数据更新。超时会报错，下一次运行重试。自动化不会创建 commit、分支或 PR。

运行摘要列出活动数、Footpath 数、新增/修订、未完成和失败数、月份 Release 及网页更新结果。403 或失效会话会停止访问并报错，不尝试绕过 Stryd 权限。代码变更仍通过 PR、CI 和代码审查后才合入 `main`。

上传中断遗留的残件会在确认本地替代包完整后清理重传，已验证的附件保留不变。如果同步期间 `main` 更新，任务会在发布目录或触发部署前停止，后续运行使用新的 `main` 重试。

## 凭据保存

- AES-256-GCM 解密密钥只在 `stryd-sync` 环境的 `STRYD_AUTH_KEY` Secret 中。
- 轮换会话保存在标签为 `stryd-sync-state` 的**未发布 Release 草稿**附件中，内容额外进行 AES-GCM 加密。不进入 Git、公开月包、构建产物、缓存或日志。
- GitHub 将 Release 草稿限制为具有写入权限的用户可见；初始化还会检查匿名读取返回 404。见 [GitHub Release API 文档](https://docs.github.com/en/rest/releases/releases#list-releases)。此草稿必须一直保持未发布状态，代码每次读取和保存都会检查。
- 每次令牌刷新后，立即上传新的加密状态并读回验证，再继续请求。状态按附件 ID 读取最新版本；不回退到旧的刷新令牌。会话刷新 POST 遇到不确定响应时不重试。
- 仅在新状态读回验证成功后清理旧附件，保留最近 20 份加密备份，避免长期运行达到 Release 附件数量上限。保存或验证失败时不删除旧备份。
- 工作流全局串行，运行中的任务不会被下一次定时任务取消；环境只允许受保护的分支。只有 `main` 可以执行抓取任务，PR 的 CI 不读取凭据。
- GitHub API 使用该次运行的短期 `GITHUB_TOKEN`，不需要额外保存长期 GitHub PAT。工作流仅授予 `contents: write`，用于 Release 和附件；不授予 PR 或 Actions 写入权限，也没有 Git commit 或 PR 写入逻辑。

不要发布或删除凭据草稿。若状态损坏、刷新失效或上游登录撤销，重新连接账号。账户会话可能失效，自动化不能保证永久免登录。

## 首次连接 / 重新连接

需要 Python 3.13、已登录的 GitHub CLI，以及你自己的 Stryd PowerCenter 登录会话。重新连接前，等待已有抓取运行结束；脚本会检查运行状态。

```sh
python -m venv .venv
.venv/bin/pip install -r scripts/stryd/requirements.txt
.venv/bin/python scripts/stryd/bootstrap.py prepare
```

在已登录的 Stryd PowerCenter 页面 DevTools Console 中运行本机生成的 `.local/stryd/browser-export.js`。它只下载 RSA-OAEP + AES-GCM 加密的 `stryd-bootstrap.enc.json`，不打印令牌，也不修改浏览器登录状态。然后运行：

```sh
.venv/bin/python scripts/stryd/bootstrap.py install \
  --repo OWNER/REPO \
  --envelope ~/Downloads/stryd-bootstrap.enc.json \
  --private-key .local/stryd/bootstrap-private.pem
```

安装会创建受保护的 `stryd-sync` 环境、私有可见的加密草稿状态，设置以下配置并验证真实刷新及持久化。脚本不输出 GitHub Token、Stryd 令牌或加密密钥。

| 配置 | 类型 | 用途 |
| --- | --- | --- |
| `STRYD_AUTH_KEY` | 环境 Secret | 解密会话状态 |
| `VERCEL_DEPLOY_HOOK` | 环境 Secret | 触发 `main` 的 Vercel 构建 |
| `STRYD_SITE_URL` | 仓库 Variable | 公开生产站的 HTTPS 根地址，用于核对数据版本 |
| `STRYD_STATE_RELEASE_ID` | 仓库 Variable | 凭据草稿的 ID |
| `STRYD_SYNC_ENABLED` | 仓库 Variable | `true` 启用，`false` 暂停 |

在 Vercel 项目的 **Settings → Git → Deploy Hooks** 创建绑定 `main` 的 Hook，将地址保存为 `stryd-sync` 环境的 `VERCEL_DEPLOY_HOOK` Secret；将公开网站根地址保存为仓库变量 `STRYD_SITE_URL`。Hook 地址具有触发部署的能力，应作为 Secret 保存。Vercel 仍使用 `pnpm build:history` 构建。

不需要开启 **Allow GitHub Actions to create and approve pull requests**。保留 `main` 的 PR、CI 和审阅对话保护。在 Actions 手动运行一次，确认抓取摘要和网页版本。可选 `refresh_session` 测试令牌刷新及加密持久化；`deploy_site` 在没有新数据时也请求一次网页重建。

新建个人仓库时，还需要自己的初始月份 Releases、`history-source.json` 仓库配置和公开数据授权。直接 fork 本项目不会获得维护者账号、Secret 或自动开启同步。
