# 每日自动抓取

`Daily Stryd Footpath` 每天 **03:30 Asia/Shanghai**（UTC 19:30，`30 19 * * *`）运行一次。GitHub 的定时触发可能延迟；也可以在 Actions 页面手动运行。公共仓库长期没有活动时，GitHub 可能暂停定时工作流，需在 Actions 页面重新启用。

## 数据流程

1. 从已审阅的 `main` 执行代码，使用 Repository Secrets 中的邮箱和密码登录 Stryd，令牌只保存在本次进程内存中。
2. 恢复可丢弃的抓取进度缓存；从最新月份 Release 读取完整历史目录与总索引，校验来源、附件摘要及内容。不读写任何数据 PR 或数据分支。
3. 分页扫描全部 Stryd 日历，因此旧活动今天才上传的 Footpath 也能被发现。下载新记录，重查最近 14 天的已归档记录。上游尚未处理完成的记录下次重试；每次默认最多检查 100 份，可手动设为 1–500，并启用 `recheck_all` 检查更早记录。
4. 新增或修订记录通过原始内容摘要去重。没有数据变化时，不下载完整历史、不更新月份数据包。
5. 有变化时校验并合并历史，在临时目录准备全部月份包，只上传变化或需要修复的包。每月固定一个 `footpath-YYYY-MM` Release，新月份才创建 Release。全部上传成功后更新最新月份的总目录，未变化的包复用原固定 URL 和 SHA-256；保留本地包用于恢复缺失或损坏的远端附件。
6. 比较生产网页和 Release 中的数据版本。有新数据或上次部署失败时，通过 Vercel Deploy Hook 重新构建 `main`，等待网页数据更新。超时会报错，下一次运行重试。自动化不会创建 commit、分支或 PR。

运行摘要列出活动数、Footpath 数、新增/修订、未完成和失败数、月份 Release 及网页更新结果。403 或失效会话会停止访问并报错，不尝试绕过 Stryd 权限。代码变更仍通过 PR、CI 和代码审查后才合入 `main`。

上传中断遗留的残件会在确认本地替代包完整后清理重传，已验证的附件保留不变。如果同步期间 `main` 更新，任务会在发布目录或触发部署前停止，后续运行使用新的 `main` 重试。

## 登录与缓存

- 每次运行用 `STRYD_EMAIL`、`STRYD_PASSWORD` 登录。密码只发送给 Stryd 的 HTTPS 邮箱登录接口；账号密码和令牌不写入日志、Git、Release、缓存或构建产物。
- 邮箱密码登录返回 `token`、`refresh_token`、`client_id`、`id`。运行中遇到 401 时，用内存中的刷新令牌续期，随后重试该读取请求一次。登录及刷新请求不自动重试；响应不确定或需要额外验证时停止本次运行，下次运行重新登录。
- 构建和打包子进程的环境会移除 Stryd 账号密码、GitHub Token 和 Vercel Hook。PR 的 CI 使用合成数据，不读取这些凭据。
- Actions Cache **仅缓存** `.cache/stryd-checks.json`：Footpath ID、检查/尝试时间、ETag、原始数据摘要。写入时按字段白名单重新构造 JSON，不保存任何会话字段。
- 缓存按运行 ID 和重试次数生成新 key；恢复最近的检查进度，以避免已检查项目或尚未处理好的旧记录占满下载额度。缓存缺失、过期或损坏时重建进度；不影响重新登录或 Release 中的历史数据。缓存读写失败不会阻止数据同步。
- Cache 可被有读取权限的工作流访问，不作为凭据存储。参见 [GitHub Cache 说明](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)。
- 工作流串行运行，仅从 `main` 执行同步。代码修改遵守分支保护与 PR 审查；普通 PR 的 CI 不引用任何账号或部署凭据。
- GitHub API 使用本次运行的短期 `GITHUB_TOKEN`，只授予 `contents: write` 用于月份 Release；不需要额外的 GitHub PAT，不授予 PR 或 Actions 写入权限。

## 配置

在 GitHub **Settings → Secrets and variables → Actions** 设置以下内容，三个凭据统一使用 **Repository Secrets**，无需创建 GitHub Environment。仅将有权公开的数据用于本项目的公共月份 Releases。

| 配置 | 类型 | 用途 |
| --- | --- | --- |
| `STRYD_EMAIL` | Repository Secret | Stryd 账号邮箱 |
| `STRYD_PASSWORD` | Repository Secret | Stryd 账号密码 |
| `VERCEL_DEPLOY_HOOK` | Repository Secret | 触发 `main` 的 Vercel 构建 |
| `STRYD_SITE_URL` | 仓库 Variable | 公开生产站 HTTPS 根地址，用于核对数据版本 |

在 Vercel 项目的 **Settings → Git → Deploy Hooks** 创建绑定 `main` 的 Hook，将地址保存为上面的 Secret。Vercel 仍使用 `pnpm build:history` 构建，不接收 Stryd 账号密码。更新 Release 不会产生 Git push，因此保留 Hook 来触发数据更新后的构建；`STRYD_SITE_URL` 用于核对生产站数据版本，并在部署失败后重试。

在 Actions 手动运行 `Daily Stryd Footpath`，可设置 `max_downloads=1` 做小规模验证；`refresh_session=true` 同时验证本次内存会话续期。手动和定时运行都只在生产站的数据版本落后时请求部署，没有强制重建选项；数据已是最新时，摘要显示 `current`，不会重复触发 Hook。工作流默认按日运行，无需额外启用变量。需要暂停时，在 Actions 页面停用该工作流；恢复时重新启用。

抓取器仅使用 Python 标准库。开发验证：

```sh
python -m unittest discover -s tests/stryd -v
```

本地 `.env` 已被 Git 忽略，仅供本地测试；工作流直接读取 GitHub Secrets，不上传或读取 `.env`。密码变更后更新对应 Secret。直接 fork 本项目不会获得维护者账号或 Secret；启用 Actions 前需配置自己的凭据、初始月份 Releases、Vercel 部署及公开数据授权。构建和打包会自动使用 fork 的仓库，不会继续读取维护者仓库的数据。
