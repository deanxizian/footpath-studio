# 数据与部署

## 两种构建

| 命令 | 数据来源 | 使用场景 |
| --- | --- | --- |
| `pnpm build` | 源码中的合成示例 | CI、独立使用者、演示部署 |
| `pnpm build:history` | `published-history.json` 固定的公开 Release | 维护者的公开历史站 |
| `pnpm dev:archive` | 本机 `private-data/data/` | 有本地历史快照的开发环境 |

历史数据按 `Asia/Shanghai` 时区的跑步开始日期分月，跨午夜或跨月的一次跑步整体归入开始月份。Release 中包括：

- `footpath-YYYY-MM.tar`：当月独立的 `data/version.json`、压缩索引和全部被引用的三维轨迹。
- `footpath-catalog.tar`：网站使用的原始总索引与版本文件。
- `published-history.json`：月份、跑步数、附件 URL、大小和 SHA-256，源码中保留同一份清单。

历史构建最多同时流式下载 4 个包，验证大小和 SHA-256，再检查归档路径、文件类型、每个数据文件摘要、月份及索引引用关系。每个月的活动必须与总索引完全一致；汇总后再次校验全部记录。失败即停止构建，不回退到旧数据。网站的浏览器加载格式不变。

已校验的归档缓存在 `.cache/history-releases/<tag>/`，再次构建只下载缺失或校验失败的包。归档使用固定 USTAR 元数据，不带 macOS 辅助文件；本地文件时间变化不会改变归档内容。缓存不进入源码。

## Vercel

导入 `deanxizian/footpath-studio`，项目根目录为仓库根，框架 Vite、Node.js 24、安装命令 `pnpm install --frozen-lockfile`、输出目录 `dist`。历史站构建命令为 `pnpm build:history`；其他使用者可以选 `pnpm build`。

使用 Vercel 的 GitHub 集成：功能分支生成 Preview，合入 `main` 后生产部署。Vercel 只读取公开历史附件，不需要 Vercel Token 或 Stryd 登录信息。相关行为见 [Vercel Git 部署文档](https://vercel.com/docs/git)。

## 发布新历史快照

维护者可以启用[每日自动抓取](stryd-sync.md)，自动更新月包并提交数据 PR。凭据只由受保护的抓取任务使用，不进入 Git 或网站。以下流程仍可用于手动发布。

1. 从有授权的数据源准备 `private-data/data/` 下的 `version.json` 和全部被索引引用的 `.bin`。
2. 在功能分支运行 `pnpm pack:history private-data history-YYYY-MM-DD-monthly YYYY-MM-DD`，传入新的 Release 标签和快照日期。命令生成 `.cache/history-releases/<tag>/` 下的月包、总索引包和清单，同时更新源码中的 `published-history.json`。
3. 复核公开范围后，将该目录内的附件上传到对应的 GitHub Release。先完成上传和校验，再发布 Release。不要覆盖已有版本，使用新标签；旧快照保留，保证旧提交仍可构建。
4. 执行 `pnpm build:history` 并检查页面；将打包代码或清单修改作为 PR 提交。CI 和代码审查完成、Preview 验证通过后合并，由 Vercel 构建新快照。

只分析某个月时，可以单独下载对应月包，解包后得到同样的公开 `data/` 格式。月份包不是“导入 JSON”按钮接受的原始 JSON 文件。需要完整网站数据时使用 `pnpm build:history`，不要把多个月包直接解压到同一目录覆盖各自的 `version.json`。

GitHub Release 可用于分发独立附件，当前归档低于单附件 2 GiB 上限，见 [GitHub Releases 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。

自动化更新同一个月份时，会在新的快照 Release 中上传该月份的新包和总索引；未变化的月份继续引用先前 Release 的附件。旧包保持不变，保证旧提交的 SHA-256 和构建仍有效。整个历史不需要每天重新上传。
