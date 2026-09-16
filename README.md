# Footpath Studio

用于查看 Stryd Duo 足部三维轨迹、比较多次跑步、观察长期跑姿趋势的独立网页工具。不是 GPS 路线查看器，也不是 Stryd 官方产品。

## 功能

- 同时比较当前和基准跑步：左脚橙色、右脚蓝色，实线为当前、虚线为基准。
- 3D、侧视、后视、俯视，左右脚独立显示和镜像对齐。
- 固定速度范围（目标速度 ±5%）、路面和日期筛选，长期变化及 5 次滚动中位数。
- 单次跑步分段分析、原始片段查看、图片和 CSV 导出。
- 导入一份或多份 Footpath JSON；文件在浏览器中处理，不上传，刷新后需重新导入。
- 可选 GitHub Actions 每日抓取，按月归档，自动创建数据更新 PR。

三维对比采用每侧的真实代表片段，不生成平均轨迹。每侧至少需要 3 段有效样本；坐标保留原始单位，不等同于人体步幅或身体振幅。计算方法见 [分析口径](docs/analysis.md)。

## 快速开始

需要 Node.js 24 和 pnpm 11.19.0。

```sh
npm install -g pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm dev
```

全新 clone 默认展示 24 次数学合成的演示跑步，不需要账号或密钥。选择“导入 JSON”后会开始自己的数据集，后续导入会去重追加。选择“重新开始”可返回导入和演示入口。

```sh
pnpm test
pnpm build
pnpm preview
```

## 公开历史数据

维护者 deanxizian 已同意公开自己的历史 Footpath。正式站采用独立 Release 附件中的历史快照：**608 次跑步，2023-11-22 至 2026-09-15**。数据包括足部坐标、时间、活动名称、距离、速度等运动元数据；不含登录会话或密钥。

源码与约 1 GB 的历史数据分开保存。Release 按**北京时间的跑步开始日期**分月打包，共 **35 个月**，例如 `footpath-2026-09.tar`。每个月包包含当月索引和三维轨迹，`footpath-catalog.tar` 保存网站的总索引；不使用 Git LFS。

构建使用 [published-history.json](published-history.json) 指定的每个包的固定 URL、大小和 SHA-256 校验值，下载后汇总为完整历史数据，不隐式读取本地个人文件。网页仍按需加载单次跑步轨迹。

```sh
# 下载已公开、固定版本的快照并构建历史站
pnpm build:history
pnpm preview
```

维护者的 `Daily Stryd Footpath` Action 每天北京时间 **06:20** 检查已上传的 Footpath，也可以手动运行。新数据归入跑步开始月份；未变化的月包复用原 Release，新版本使用新的固定附件。自动化创建或更新数据 PR，审阅并合入 `main` 后由 Vercel 发布。没有新数据时不创建 Release 或 PR。配置和重新连接账号的方法见 [自动抓取](docs/stryd-sync.md)。

## 项目目录

```text
src/                   网页、三维渲染、数据模型和合成示例
tests/                 数据完整性和分析行为测试
scripts/               历史快照打包、校验与构建检查
scripts/stryd/         可选的账号抓取与加密会话管理
docs/                  分析方法、格式和部署文档
.github/               PR 模板、无密钥 CI 和受保护的每日抓取
published-history.json 固定公开快照的来源与校验值
```

`private-data/`、`public-history/`、`.cache/`、`dist/` 都是本地生成目录，不进入 Git。软件采用 [MIT](LICENSE) 许可证；依赖及参考来源见 [第三方说明](docs/attribution.md)。

所有应用更改通过 PR，经 CI 与审阅后合入 `main`。参见 [贡献指南](CONTRIBUTING.md)。
