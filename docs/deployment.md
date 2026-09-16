# 数据与部署

## 两种构建

| 命令 | 数据来源 | 使用场景 |
| --- | --- | --- |
| `pnpm build` | 源码中的合成示例 | CI、独立使用者、演示部署 |
| `pnpm build:history` | 最新月份 Release 的动态目录 | 维护者的公开历史站 |
| `pnpm dev:archive` | 本机 `private-data/data/` | 有本地历史快照的开发环境 |

## 每月一个 Release

Release 标签使用 `footpath-YYYY-MM`，标题列出月份和跑步数量。按 `Asia/Shanghai` 时区的跑步开始日期分月；跨月的一次跑步整体归入开始月份。新增或修订数据更新对应的月份 Release，只有出现新的月份才创建新的 Release。

- `footpath-YYYY-MM-<摘要>.tar`：当月独立的 `data/version.json`、压缩索引和被引用的三维轨迹。
- 最新月份的 `footpath-catalog-<摘要>.tar`：完整历史的总索引与版本文件。
- 最新月份的 `published-history.json`：网站当前目录，包含每月包的固定 URL、大小、SHA-256 与跑步数量。带摘要的同名 JSON 是发布及故障恢复时使用的不可变目录副本。

每个 Release 正文的“下载本月最新 Footpath 数据”指向当前月包；旧修订附件保留用于校验和回溯。新月包先上传并验证，网站目录最后切换，避免构建读取未完成的上传。小目录文件替换期间的短暂 404 会重试；下一次同步也能从不可变副本修复中断的目录替换。

源码的 `history-source.json` 只保存公开仓库名。默认构建读取 `releases/latest/download/published-history.json`，不需要 GitHub API Token，也不依赖匿名 API 配额。最新月份必须保持 GitHub 的 Latest；以后发布软件版本时，应避免把软件 Release 设为 Latest。

构建最多同时流式下载 4 个包，验证大小和 SHA-256，再检查归档路径、文件类型、每个数据文件摘要、月份及索引引用。每月活动必须与总索引完全一致；汇总后再次校验全部记录。失败即停止构建，不回退到合成示例。已校验的包缓存在 `.cache/history-releases/<tag>/`，实际使用的清单写入 `.cache/published-history.json`，均不进入 Git。

## Vercel

导入 `deanxizian/footpath-studio`，根目录为仓库根，框架 Vite、Node.js 24、安装命令 `pnpm install --frozen-lockfile`、输出目录 `dist`。历史站构建命令为 `pnpm build:history`；其他使用者可以选 `pnpm build`。

代码通过 GitHub 集成部署：功能分支生成 Preview，PR 合入 `main` 后生产部署。数据通过 [Vercel Deploy Hook](https://vercel.com/docs/deploy-hooks) 部署：数据 Action 更新 Releases 后，请求绑定 `main` 的 Hook，让同一份代码重新读取最新数据并构建。无需为了触发部署创建 commit。

Hook 地址只保存在受保护的 `stryd-sync` 环境 Secret 中，不放入源码或日志。Vercel 构建只读取公开附件，不接收 Stryd 会话。同步任务每次比较生产站的数据 revision 与已发布目录；不一致时触发部署并等待更新，超时会使 Action 失败，下次同步继续重试。手动运行中的 `deploy_site` 可以主动重建当前数据。

## 手动准备 / 重现数据

```sh
# 只在忽略的 .cache 目录内生成月份包与清单，不修改源码
pnpm pack:history --source private-data --output .cache/monthly-publication

# 重现保存过的具体目录版本（不依赖此刻的 Latest）
node scripts/fetch-public-history.mjs --manifest /path/to/published-history.json
pnpm exec vite build --mode public-history
node scripts/check-public-release.mjs --history
```

发布前应校验全部附件。日常发布使用 [每日自动抓取](stryd-sync.md) 中的流程；账号密码仅保存在 Actions Secrets 中。只分析某个月时，可以单独下载月包；不要将多个月包直接解压到同一目录覆盖各自的 `version.json`。月包不是“导入 JSON”按钮接受的原始 JSON 文件。
