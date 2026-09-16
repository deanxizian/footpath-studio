# Footpath Studio

用于查看 Stryd Duo 足部三维轨迹、比较多次跑步、观察长期跑姿趋势的独立网页工具。不是 GPS 路线查看器，也不是 Stryd 官方产品。

## 功能

- 同时比较当前和基准跑步：左脚橙色、右脚蓝色，实线为当前、虚线为基准。
- 3D、侧视、后视、俯视，左右脚独立显示和镜像对齐。
- 固定速度范围（目标速度 ±5%）、路面和日期筛选，长期变化及 5 次滚动中位数。
- 单次跑步分段分析、原始片段查看、图片和 CSV 导出。
- 导入一份或多份 Footpath JSON；文件在浏览器中处理，不上传，刷新后需重新导入。

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

源码与约 1 GB 的历史数据分开保存。构建使用 [published-history.json](published-history.json) 指定的固定版本和 SHA-256 校验值，不隐式读取本地个人文件。

```sh
# 下载已公开、固定版本的快照并构建历史站
pnpm build:history
pnpm preview
```

这是历史快照。旧抓取仓库已删除，目前新项目不自动登录 Stryd 或同步新增活动。发布新快照的方法见 [数据与部署](docs/deployment.md)。

## 项目目录

```text
src/                   网页、三维渲染、数据模型和合成示例
tests/                 数据完整性和分析行为测试
scripts/               历史快照打包、校验与构建检查
docs/                  分析方法、格式和部署文档
.github/               PR 模板和无账号密钥的 CI
published-history.json 固定公开快照的来源与校验值
```

`private-data/`、`public-history/`、`.cache/`、`dist/` 都是本地生成目录，不进入 Git。软件采用 [MIT](LICENSE) 许可证；依赖及参考来源见 [第三方说明](docs/attribution.md)。

所有应用更改通过 PR，经 CI 与审阅后合入 `main`。参见 [贡献指南](CONTRIBUTING.md)。
