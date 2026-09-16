# 导入格式

支持原始 Stryd JSON 的 `foot_data_list`，或以下紧凑格式。每个片段至少包含两个有限 XYZ 点和有限时间戳；`side: 1` 为左脚，`side: 2` 为右脚。

```json
{
  "format": "footpath-studio-v1",
  "title": "我的跑步",
  "segments": [
    {
      "side": 1,
      "timestamp": 1700000000,
      "timestamp_frac": 0.25,
      "speed": 3.4,
      "power": 220,
      "ground_contact_time": 230,
      "stride_time": 680,
      "points": [[0, 0, 0], [0.5, 0.1, 0.2], [0, 0, 0]]
    }
  ]
}
```

原始格式使用 `positions: [{"x":0,"y":0,"z":0}, ...]`，其余字段含义相同。缺失的速度、功率和时长指标保留为空；关闭速度筛选可以查看没有速度的片段。

单文件上限 128 MB，一次导入总计不超过 256 MB。文件只存在浏览器内存中。当前按起止时间、片段数和点数去重；具有相同这些字段的重新处理版本可能被视为重复，应“重新开始”后单独导入比较。

发布格式使用 `data/version.json` 指向 gzip 压缩的索引。所有 `.bin` 文件以压缩字节的 SHA-256 命名，索引包含逐次统计行与几何文件地址。浏览器校验摘要后才解压，几何文件按需加载，最多缓存 3 次网络加载的跑步。

Release 使用 `footpath-YYYY-MM.tar` 分月分发。每个月包都包含上述完整目录结构，只引用北京时间当月开始的活动。总索引包 `footpath-catalog.tar` 保留完整历史的索引；构建脚本校验各个月包与总索引一致后，汇总三维文件，继续提供相同的网页数据格式。`published-history.json` 的格式标识为 `footpath-studio-monthly-history-v1`，记录 `Asia/Shanghai` 时区和每个附件的摘要。
