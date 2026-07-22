# Readonly Translation DB — 设计脑暴

> 目标：只读、单一查询 `id -> value`、体积尽量小、查询尽量快。
> 本文只做设计讨论，暂不写实现。

## 0. 已锁定的决策

- **运行时 = Electron（Node 24.18）** → **内置 zstd / deflate / brotli 均支持字典，零依赖**（Node 24 实测确认，见 §4）。
  - ⚠️ 字典需 **Node ≥ 24**；v22.15–v22.x 的 zstd `dictionary` 被静默忽略。
- **value = `content` + `bodyHash`**，`type`/`contentType` 全部丢弃。
- **每种语言一个独立 `.db`**，各自训练字典。
- **更新 = 离线脚本全量重建**；**分发 = 直接下载 `.db`**。
- **bodyHash 保留**（丢弃只省 0.93%）。
- **编码器与分块（Node 24 实测，见 §6）**：
  - 最小：**brotli-11 + 112KB 字典、group=4 ≈ 13.9MB / 80µs**（或 group=16 ≈ 13.5MB / 150µs）。
  - 最快且仍小：**zstd-19 + 112KB 字典、group=4 ≈ 14.4MB / 57µs**（或 group=1 ≈ 14.9MB / 27µs）。

> 推荐：体积优先选 **brotli+字典 group=4**（最小，解压仍 <100µs）；若看重解压延迟选 **zstd+字典**。两者格式一致，只换 codec 字段。

## 1. 数据现状（实测 zh-TW）

| 指标 | 数值 |
|---|---|
| 记录数 | 17,346 |
| `content` 原始 UTF-8 总量 | 52.0 MB |
| 磁盘上 JSON 文件夹总量 | 93 MB（JSON/文件系统开销 ~40MB） |
| 单条 `content` 字节 | min 0 / median 1,907 / mean 2,999 / max 51,330 |
| id 范围 | 32,274 ~ 1,595,779（跨度 1.56M，密度仅 0.5%） |

每条记录字段：
- `content`：HTML 或 Markdown 字符串 —— **占几乎全部体积**
- `contentType`：只有 `text/html`(8509) 与 `text/markdown`(8837)
- `type`：只有 `curseforge`(8509) 与 `modrinth`(8837)
- `bodyHash`：12 字符 base64 = 8 字节

> 关键：`contentType` 与 `type` 完全相关（html↔curseforge，markdown↔modrinth），
> 两者合起来实际只需 **1 bit**。

## 2. 关键洞察

1. **高度可压缩**：都是 mod 描述的 HTML/Markdown，模板结构、标签、CDN 域名、常用词高度重复。整库 LZMA 能压到 10.7MB（但无法随机访问）。
2. **id 是稀疏整数**：适合「排序数组 + 二分」或紧凑索引，不需要字符串 key、不需要哈希表。
3. **元数据基本可丢**：1 bit 就能表达 type/contentType；`bodyHash` 是否真的要进 DB 需确认（见 §7）。
4. **只读**：可以离线用最高压缩级别构建，运行时零写入、可 mmap、可整块加载。

## 3. 压缩基准（实测，均基于 52MB 原始 content）

| 方案 | 体积 | 随机访问粒度 |
|---|---|---|
| 整库 gzip-9 | 17.4 MB | ❌ 需整解 |
| 整库 bzip2-9 | 12.4 MB | ❌ |
| 整库 LZMA | **10.7 MB** | ❌ |
| 逐条 deflate-9（无字典） | 22.7 MB | ✅ 单条 |
| 逐条 brotli-11（无字典） | 18.7 MB | ✅ 单条 |
| 逐条 zstd-19（无字典） | 22.8 MB | ✅ 单条 |
| 逐条 deflate-9 + 32KB 朴素字典 | 18.2 MB | ✅ 单条 |
| **逐条 zstd-19 + 112KB 训练字典** | **15.0 MB** | ✅ 单条 |
| 逐条 zstd-19 + 160KB 字典 | 14.6 MB | ✅ 单条 |
| 分块(16条/块) zstd-19 + 字典 | 14.0 MB | ⚠️ 需解整块(~16条) |

**结论**：随机访问 + 体积的最佳平衡是 **zstd + 训练字典（逐条压缩）≈ 15MB**。
若能接受「解一整块」的成本，分块可再省 ~1MB。若完全不需要随机访问，整库 LZMA 最小。

## 4. 运行时解压能力（Node 24.18 实测）

**三种内置编码器均支持字典**（交叉验证：带字典压缩、去掉字典解压会报 `ZSTD_error_corruption_detected` → 字典确实生效）：

| 编码 | 字典选项 | 备注 |
|---|---|---|
| `zstdCompressSync/zstdDecompressSync` | ✅ `{dictionary}` | **仅 Node ≥ 24**（v22.x 静默忽略） |
| `deflateRawSync/inflateRawSync` | ✅ `{dictionary}`（≤32KB 窗口） | 早就支持 |
| `brotliCompressSync/brotliDecompressSync` | ✅ `{dictionary}` | Node 24 可用 |

> 构建时用 `zstd.train_dictionary()` 产生字典写入 `.db`；运行时传 `{dictionary}` 即可。

## 5. 候选文件格式（单文件、mmap 友好）

单一 `.db` 文件，记录按 id 升序、每 **G=4** 条打成一个 zstd 块（带字典）：

```
┌─────────────┬─────────────────────────────────────────────┐
│ Header      │ magic, version, codec, N, G, 各段偏移          │
├─────────────┼─────────────────────────────────────────────┤
│ Dictionary  │ zstd 训练字典（~112KB）                       │
├─────────────┼─────────────────────────────────────────────┤
│ Keys        │ N × uint32，升序 id（记录 r 在块 r/G，位 r%G） │
├─────────────┼─────────────────────────────────────────────┤
│ BlockOffset │ (ceil(N/G)+1) × uint32，各压缩块字节边界       │
├─────────────┼─────────────────────────────────────────────┤
│ BodyHash    │ N × 8B，随 Keys 同序                          │
├─────────────┼─────────────────────────────────────────────┤
│ Data        │ 各块（G 条 content 以 \0 连接后 zstd(字典) 压缩） │
└─────────────┴─────────────────────────────────────────────┘
```

**查询流程** `get(id) -> { content, bodyHash }`：
1. 在 Keys 段二分 `id` → 记录下标 `r`（`O(log N)`）。
2. `bodyHash = BodyHash[r]`。
3. 块号 `b = r / G`，用 `BlockOffset[b..b+1]` 取该块压缩字节。
4. `zstdDecompressSync(block, { dictionary })` → 按 `\0` 切分 → 取第 `r % G` 段 = `content`。

**索引体积估算**：Keys 68KB + BlockOffset ~17KB + BodyHash 136KB ≈ **220 KB**，可整段驻内存。

**总体积估算（group=4）**：数据 ~14.43MB + 字典 0.11MB + 索引 0.22MB ≈ **14.8MB**
（对比原始 93MB 磁盘 / 52MB 原文，约 **6.3×** 缩减，O(log N) 二分 + 单块解压，零依赖）。

## 6. Profiling：三编码器 × 分块（**Node 24.18 真实实测**，zh-TW 17357 条）

单条随机查询延迟（含解压整块 + 切分），均带 112KB / 32KB 训练字典：

| 编码器 + 字典 | group=1 | group=4 | group=8 | group=16 |
|---|---|---|---|---|
| deflate-9 + 32KB | 17.41MB / 18.7µs | 17.07MB / 44µs | — | — |
| **zstd-19 + 112KB** | 14.93MB / 27µs | **14.41MB / 57µs** | 14.22MB / 81µs | 14.04MB / 126µs |
| **brotli-11 + 112KB** | 14.70MB / 135µs | **13.90MB / 80µs** | 13.68MB / 111µs | 13.48MB / 150µs |
| brotli-11 无字典（对照） | 18.72MB / 18µs | — | — | 15.74MB / 155µs |

结论：
- **brotli+字典每个档位都最小**：group=4 已 13.90MB，group=16 可到 13.48MB；代价是解压慢 1.5–2倍（仍 <200µs）。
- **zstd+字典是速度/体积平衡**：group=4 = 14.41MB / 57µs，group=1 = 14.93MB / 27µs（解压最快的小块方案）。
- **deflate+字典解压最快**（≥19µs）但体积最大（~17MB，32KB 窗口限制）。
- 字典已吸收大部分跨记录冗余，分块边际收益递减；group=4 是普适平衡点。

## 6c. 速度特性
- Dict/Keys/BlockOffset/BodyHash 可整段驻内存（~330KB），二分纳秒级。
- 冷启动只需读 header + 加载字典(112KB) + 索引段，无需解压全库。
- Data 段可 mmap 或按 offset `read`，只解压命中块；热点 id 可叠加 LRU 缓存。

## 6d. 实验：按 type 拆成 2 个 db（Node 24 实测，zh-TW，group=4，各自 112KB 字典）

| 子库 | 记录数 | 原文 | zstd+字典 | brotli+字典 |
|---|---|---|---|---|
| curseforge (html) | 8,512 | 29.9MB | 7.33MB | 7.09MB |
| modrinth (markdown) | 8,845 | 22.1MB | 6.94MB | 6.68MB |
| **数据合计** | 17,357 | 52MB | **14.27MB** | **13.77MB** |

对比（仅数据部分）：单库 zstd 14.41 / brotli 13.90 → 拆分 14.27 / 13.77（**拆分数据反而略小 ~0.13MB**，因专用字典更贴合 HTML/Markdown）。
含字典+索引总盘子：单库 ≈14.23(br)/14.74(zstd)，拆两库 ≈14.23(br)/14.72(zstd) → **几乎相等**。

**结论：按 type 拆库在体积上几乎零代价**（专用字典收益 ≈ 第二个字典成本）。因此拆分与否可纯按架构决定（分平台独立更新/下载，如 curseforge 更新更频繁时只重建那一个）。

## 6e. ru 全量单库基准（Node 24 实测，group=4，112KB 字典）

| 库 | 记录数 | 原文 | zstd+字典 | brotli+字典 | +字典/索引 |
|---|---|---|---|---|---|
| ru（全部，cf+mr） | 47,178 | 195.3MB | 41.47MB | **40.96MB** | +0.73MB |

压缩比约 **4.8×**（比 zh-TW 的 3.7× 更高，量大→跨记录冗余更多）。ru 单库 ≈ **41.7MB**（brotli）。

## 6f. 实验：按 Modrinth 流行度切 hot/cold（p95 = 覆盖 95% 下载量）

数据源 [scripts/modrinth_popularity.json](scripts/modrinth_popularity.json)，分布图 [scripts/modrinth_popularity.png](scripts/modrinth_popularity.png)。

- Modrinth 全站 **140,867** 项目；top-10k 下载量总和 14.87B。分布=**强长尾 + 拐点**（rank~1000 后陡降），非硬断崖。
- **p95 阈值：rank K=3718**（覆盖 95% 下载量，≈ 你预期的 4k）。
- 仅 **modrinth** 记录可按下载排名分（文件名=project_id）；curseforge 需另找热度源。

| split | 记录数 | 原文 | zstd+字典 | brotli+字典 | +字典/索引 |
|---|---|---|---|---|---|
| zh-TW hot（in top-3718） | 2,608 | 8.3MB | 2.41MB | **2.33MB** | +0.15MB |
| zh-TW cold（其余 modrinth） | 6,190 | 13.6MB | 4.40MB | **4.24MB** | +0.20MB |
| ru hot | 3,304 | 15.9MB | 3.45MB | **3.39MB** | +0.16MB |
| ru cold | 20,595 | 71.9MB | 16.34MB | **16.19MB** | +0.38MB |

**关键观察**
- **hot 库很小**：zh-TW hot ≈ 2.5MB / ru hot ≈ 3.5MB → 完全可**内置随应用打包**，零网络即命中热门项目。
- 但 hot 只覆盖我们 modrinth 记录的一小部分：**zh-TW 仅 52% 落在 top-10k、30% 落在 hot；ru 仅 32%/14%**。
- ⚠️ **请求分布 ≠ 下载分布**得到实证：我们已翻译了大量长尾项目（用户实际请求过），Modrinth 下载排名只是代理。理想应改用**自己的请求日志**定 hot 集。

## 7. 剩余待决 / 实现前确认

- **Q1 Node 版本下限**：字典需 Node ≥ 24。确认 Electron 打包的 Node 确为 24.18（已假定）；若部分用户仍旧版，需 fallback。
- **Q2 字典大小**：112KB 是实测甜点，zh-CN（数据小）可单独扫 64/160KB；每语言独立训练。
- **Q3 端序/对齐**：小端 uint32；Keys/BlockOffset 4B 对齐便于 `Uint32Array` 直接映射。
- **Q4 空 content**：`\0` 切分天然支持空段。
- **Q5 版本演进**：Header 保留 version + codec id + dictID，方便日后换字典/算法。

---
### 结论（已定方向）
> 每语言一个 `.db` = `header + 训练字典(112KB) + 升序uint32 Keys + BlockOffset + BodyHash + group4 压缩数据块`。
> **最小：brotli-11 + 字典 ≈ 13.9MB / 80µs；最快且小：zstd-19 + 字典 ≈ 14.4MB / 57µs。**
> 均为 Node 24 内置、零依赖、`O(log N)` 二分 + 单块解压。离线全量重建、直接下载分发。格式与 codec 无关，Header 里用 codec 字段标识。
