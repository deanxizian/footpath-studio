# 每日自动抓取

`Daily Stryd Footpath` 每天 **06:20 Asia/Shanghai**（UTC 22:20，`20 22 * * *`）运行一次。GitHub 的定时触发可能延迟；也可以在 Actions 页面手动运行。公共仓库长期没有活动时，GitHub 可能暂停定时工作流，需在 Actions 页面重新启用。

## 数据流程

1. 从已审阅的 `main` 执行代码，只使用受保护的 `stryd-sync` 环境凭据。
2. 读取公开历史总索引。若有未合并的 `sync/footpath-data` PR，读取其中的清单作为基线；不执行该分支的代码，并拒绝包含其他文件修改的 PR。
3. 分页扫描全部 Stryd 日历，因此旧活动今天才上传的 Footpath 也能被发现。下载新记录，重查最近 14 天的已归档记录。上游尚未完成处理的记录下次重试；每次默认最多检查 100 份，可手动设为 1–500，并启用 `recheck_all` 检查更早记录。
4. 新增或修订记录通过原始内容摘要去重。没有数据变化时，不下载完整历史、不发布 Release、不创建 PR。
5. 有变化时校验并合并历史，按跑步开始时间的北京时间月份打包。仅上传变化月份和总索引到新的 `history-…-sync-…` Release；未变化的月包复用先前附件的固定 URL 和 SHA-256。原来的快照可继续构建。
6. 创建或更新一个数据 PR，唯一修改文件是 `published-history.json`。显式触发无密钥 CI，保留仓库的代码审查和 `main` 保护。审阅者合并后，Vercel 自动构建并发布；抓取任务不自动合并 PR。

运行摘要列出活动数、Footpath 数、新增/修订、未完成和失败数，以及数据 PR。403 或失效会话会停止访问并报错，不尝试绕过 Stryd 权限。

## 凭据保存

- AES-256-GCM 解密密钥只在 `stryd-sync` 环境的 `STRYD_AUTH_KEY` Secret 中。
- 轮换会话保存在标签为 `stryd-sync-state` 的**未发布 Release 草稿**附件中，内容额外进行 AES-GCM 加密。不进入 Git、公开月包、构建产物、缓存或日志。
- GitHub 将 Release 草稿限制为具有写入权限的用户可见；初始化还会检查匿名读取返回 404。见 [GitHub Release API 文档](https://docs.github.com/en/rest/releases/releases#list-releases)。此草稿必须一直保持未发布状态，代码每次读取和保存都会检查。
- 每次令牌刷新后，立即上传新的加密状态并读回验证，再继续请求。状态按附件 ID 读取最新版本；不回退到旧的刷新令牌。会话刷新 POST 遇到不确定响应时不重试。
- 工作流全局串行，运行中的任务不会被下一次定时任务取消；环境只允许受保护的分支。只有 `main` 可以执行抓取任务，PR 的 CI 不读取凭据。
- GitHub API 使用该次运行的短期 `GITHUB_TOKEN`，不需要额外保存长期 GitHub PAT。它拥有上传附件、创建数据 PR、触发 CI 所需的权限。

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
| `STRYD_STATE_RELEASE_ID` | 仓库 Variable | 凭据草稿的 ID |
| `STRYD_SYNC_ENABLED` | 仓库 Variable | `true` 启用，`false` 暂停 |

仓库设置中开启 **Actions → General → Allow GitHub Actions to create and approve pull requests**，以允许创建数据 PR；脚本不会批准自己的 PR。保留 `main` 的 PR、CI 和审阅对话保护。

在 Actions 手动运行一次，确认抓取摘要和数据 PR。可选 `refresh_session` 会额外测试一次令牌刷新及加密持久化。新建个人仓库时，还需要自己的初始历史快照及公开数据授权；直接 fork 本项目并不会自动获得维护者账号或 Secret。

`GITHUB_TOKEN` 创建的 PR 可能出现等待人工批准的 PR 事件工作流；本项目另外显式 dispatch 无密钥 CI。见 [GitHub 的触发说明](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs)。代码审查与 Vercel Preview 仍应在合并前检查。
