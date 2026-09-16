# 数据与部署

## 两种构建

| 命令 | 数据来源 | 使用场景 |
| --- | --- | --- |
| `pnpm build` | 源码中的合成示例 | CI、独立使用者、演示部署 |
| `pnpm build:history` | `published-history.json` 固定的公开 Release | 维护者的公开历史站 |
| `pnpm dev:archive` | 本机 `private-data/data/` | 有本地历史快照的开发环境 |

历史构建流式下载约 1 GB 数据，验证大小和 SHA-256，再检查归档路径、文件类型、每个数据文件摘要及索引引用关系。失败即停止构建，不回退到旧数据。已校验的压缩包缓存在 `.cache/`；此目录不进入源码。

## Vercel

导入 `deanxizian/footpath-studio`，项目根目录为仓库根，框架 Vite、Node.js 24、安装命令 `pnpm install --frozen-lockfile`、输出目录 `dist`。历史站构建命令为 `pnpm build:history`；其他使用者可以选 `pnpm build`。

使用 Vercel 的 GitHub 集成：功能分支生成 Preview，合入 `main` 后生产部署。不需要在本仓库设置 Vercel Token 或 Stryd 登录信息。相关行为见 [Vercel Git 部署文档](https://vercel.com/docs/git)。

## 发布新历史快照

本项目不连接 Stryd 账号。旧自动抓取仓库已删除，历史快照不会自行增加。要接入新的抓取流程，必须另行设计凭据存储及刷新机制，不能把会话放入公开 Git 历史。

1. 从有授权的数据源准备 `private-data/data/` 下的 `version.json` 和全部被索引引用的 `.bin`。
2. 在功能分支修改 `published-history.json` 中的版本 URL 和日期，然后运行 `pnpm pack:history`。命令生成 `.cache/footpath-history.tar`，更新文件大小、校验值与数量。
3. 复核公开范围后，将归档上传到 URL 所对应的 GitHub Release。不要覆盖已有版本，使用新标签。
4. 执行 `pnpm build:history` 并检查页面；将小型 manifest 的修改作为 PR 提交。审核合并后 Vercel 构建新快照。

GitHub Release 可用于分发独立附件，当前归档低于单附件 2 GiB 上限，见 [GitHub Releases 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。
