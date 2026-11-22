# dsh-familiar

[English](README.md) | **简体中文**

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的跨会话长期记忆。一份有字符上限的常驻画像，加上对你真实会话历史的静默按需召回；记忆本身是可以手改的纯文本。

所有东西都在你自己的机器上：DSH 记忆目录下的两个 Markdown/JSONL 文件。没有数据库，没有服务端，插件自身不发任何网络请求。

> npm 包名是 **`dsh-familiar-memory`**。裸名 `dsh-familiar` 被一个无关的空占位包持有，所以请从仓库安装，或使用完整包名。

---

## 为什么

大多数 agent 记忆系统解决的问题，比多数场景实际有的更大：先建向量索引，再建图，再做一套合并流水线，最后把结果藏进一个不透明的存储里。对单用户、历史本来就可全文检索的 harness 来说，这是用很重的机器换很小的收益。

`dsh-familiar` 走的是窄路：

- **开头不灌上下文。** 常驻提示里的只有一段静态策略 + 约 300 字的画像。
- **召回是静默且稀少的。** 当前请求碰到记忆时才追加一条折叠提示，没碰到就什么都不加。
- **细节取自原文**，不是摘要。证据一律通过宿主自己的会话索引取，`memory_expand` 能把命中的原始上下文整段捞回来。

## 工作原理

三层，从最便宜的开始。

```
① 常驻      profile.md            约 300 字，每会话注入一次
② 按需      facts.jsonl           关键词匹配 + 衰减打分
            会话索引              对真实历史做全文检索 → 原文片段
③ 按需      memory_expand         重新打开原始上下文窗口
```

### ① 画像

一份简短的 Markdown，上限由 `profileMaxChars` 控制（默认 500）。作为系统提示的一节注入，标题里直接标出占用：

```
## 用户长期画像（跨会话）[62% — 310/500 chars]
```

画像**按会话冻结**：手改会写盘，但要到新会话开始才重新加载。这样做是为了保住提示前缀缓存 —— 会话中途改一个系统提示段落，会让它之后的内容全部失效。通过 `memory_remember` 的显式写入会立即刷新，因为那是明确意图，不是后台漂移。

### ② 静默召回

每一步都会在本地判断当前请求是否碰到记忆。这个判断很便宜 —— 对事实索引和会话卡索引做分词关键词打分，不调模型、不查数据库。没命中就完全不注入。

命中时追加**一条**折叠提示，携带：

- 命中的事实（带记录日期），
- 从真实历史里取出的片段。

总量受 `injectBudgetChars` 硬上限约束（默认 1100）。

### ③ 原文

`memory_recall` 用于显式查找；`memory_expand` 重新打开某条消息前后的原始对话。两者都不返回模型写的摘要。

## 合并

新抽出的事实不会直接进文件，先过一道合并 —— 因为一个只会增长的平坦列表，退化成大量近重复的速度比任何人预期的都快。

| `effect` | 含义 | 落库动作 |
|---|---|---|
| `unrelated` | 和已有事实无关 | 新增一条 |
| `repeats` | 已有事实已经说过同样的事 | 不新增，`proofCount + 1` |
| `changes` | 同一属性的新取值 | 改写正文，旧值压进 `history`，`createdAt` 不动 |
| `ends` | 某事结束或不再成立 | 用过去时改写，记 `endedAt` |

真正起作用的是两条规则：

- **相似不等于同一。** token 重叠、主题相同、分类相同，只说明这条事实值得看一眼，**永远不构成**两条事实是同一件事的证据。候选生成是机械的，判断交给模型。
- **改写旧事实前，先交代清它里面的所有内容。** 如果旧文本里带着一条独立的事实会被丢掉，就把它另立一条，而不是整条覆盖。

日期比较放在代码里而不是提示里：新事实按定义更晚，所以模型从不对“距今多少天”做算术。

没有候选时一次模型调用都不发。模型不可用或输出无法解析时，降级为精确字符串去重 —— **候选永远不会被丢掉**。

## 按预算分档注入

事实不是“取前 N 条再截断”，而是**分档**：

1. 所有候选先以摘要档（56 字）进场，
2. 按分数顺序把靠前的升到全文档档（200 字），只要预算还够，
3. 预算耗尽就停在当前档 —— 一句话永远不会被砍一半。

事实最多占单次注入预算的一半，剩下的给历史片段。

## 事实的元数据

| 字段 | 取值 | 存在的原因 |
|---|---|---|
| `kind` | `fact` `correction` `preference` `project` `environment` | 同分类候选召回、保底名额、面板分组 |
| `source` | `user`（用户说的）/ `inferred`（模型归纳的） | 把两者分开 |
| `origin` | `auto-extract` / `memory_remember` | 写入路径 —— 和“谁说的”是两个问题 |
| `proofCount` | 整数 | 证据强度，驱动合并与名额排序 |
| `hitCount` / `lastHitAt` | 整数 / 时间戳 | 衰减与归档判断 |
| `archivedAt` | 时间戳 | 完全退出匹配与注入，但仍留在文件里 |
| `endedAt` | 时间戳 | 默认隐藏，问到过去的事时才出现 |

### 纠错类有保底名额

`kind: correction` 的事实（用户纠正过你的做法）不需要匹配当前话题。每个会话为它们保留 1~2 个名额（`injectCorrectionSlots`，默认 2）。

名额是**刻意对半分**的：**一个给证据最强的，一个给最近被碰过的。** 只按 `proofCount` 排序会让名单**固化** —— 被确认次数最多的那条永久占位，昨天才出现的纠正永远轮不到。

保底注入**不计入命中**。命中只统计“话题匹配后注入”，否则保底条目会不断重置自己的衰减，下面这个机制就永远不会触发。

### 衰减与归档

没被命中过的事实掉的是权重，不是存在：

- ≥90 天：分数 ×0.8
- ≥180 天：分数 ×0.6
- 已归档（`archivedAt`）：完全排除

这个插件里**没有任何按时间删除的逻辑**。归档需要显式调用 `memory_maintain { apply: true }`。

### ended 的事实默认隐藏

带 `endedAt` 的事实只在请求带有过去时线索时出现（上次 / 之前 / 以前 / 曾经 / 当时 / 历史 / used to …）。线索表刻意收窄，并配有误触发测试：12 句日常对话里误触发 2 句（16.7%），两句都是**确实在说过去**的句子。

## 维护报告

事实数超过 `maintainThreshold`（默认 120）时，会往 `maintenance.md` 写一份 dry-run 报告：

- 疑似重复（字面 Jaccard ≥ 0.5），
- ≥180 天没有被命中，
- 超长条目（>300 字），
- 已归档。

报告不改任何数据。`memory_maintain` 通过工具调用打印同样的数字，`memory_maintain { apply: true }` 才会把陈旧的归档。

## 工具

| 工具 | 用途 |
|---|---|
| `memory_recall` | 检索记忆：事实匹配 + 历史全文，`detail` = brief / normal / deep |
| `memory_expand` | 把某条历史消息展开成它前后的原始对话 |
| `memory_remember` | 写入：`kind=profile` 进常驻画像，`kind=fact` 进可检索的事实库，带 `category` 与 `source` |
| `memory_list` | 查看已存内容，含各分类计数与固化建议 |
| `memory_forget` | 按事实 id 删除，或按**唯一命中**的画像子串删除一行 |
| `memory_maintain` | 维护报告；`apply: true` 才归档长期没命中的事实 |

### 安全地编辑画像

两条规则，都是踩过坑换来的：

1. **只认唯一子串。** `remove` / `patch` 必须恰好命中一行。0 命中是错误；多命中是错误并列出候选。没有整文件替换 —— 整条覆盖会静默抹掉同一行里其它的信息。
2. **容量只在批量结果上检查一次。** 超过 `profileMaxChars` 时返回你差多少字符、以及当前全部条目，并期望**一次** `memory_remember` 调用同时删掉或缩短旧条目、加入新条目。否则模型会在“加不进去”和“该删多少”之间来回打转。

## 安装

```sh
git clone https://github.com/yyy2556/dsh-familiar.git dsh-familiar
dsh plugin add /path/to/dsh-familiar
```

没有构建步骤，也没有运行期依赖，所以普通检出即可安装。bundle 在 `package.json` 里声明了 `dsh.bundle` 并附带 `cordis.patch.yml`，因此按普通 bundle 行安装。发布到 npm 之后，`dsh plugin add dsh-familiar-memory` 装的是同一个东西。

安装后重启 DSH。插件不需要任何提权，也从不启动子进程。

loader 行 id 保持为 `remember`，所以升级已有安装不会多出一行。

## 配置

在 `remember` 行下设置（profile 的 `cordis.patch.yml` 或插件详情页）：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoInject` | `true` | 是否运行静默召回 |
| `injectMode` | `auto` | `notice` 强制提示形式，`off` 关闭注入 |
| `injectBudgetChars` | `1100` | 单次注入硬上限（约 550 token） |
| `injectMaxFacts` | `4` | 单次注入最多几条事实 |
| `injectCorrectionSlots` | `2` | 纠错类保底名额（0 = 关闭） |
| `cardScoreThreshold` | `0.30` | 会话卡匹配阈值 |
| `profileMaxChars` | `500` | 画像上限 |
| `maintainThreshold` | `120` | 触发维护报告的事实数 |
| `autoConsolidate` | `true` | 写入前是否过合并 |
| `autoExtract` | `true` | 回合结束时是否抽取 |
| `extractProvider` / `extractModel` | 宿主默认 | 抽取与合并所用的模型 |
| `extractMaxChars` / `extractMaxFacts` | `6000` / `3` | 抽取的输入/输出上限 |
| `indexLimit` / `indexTtlMs` | `400` / `300000` | 会话索引规模与刷新间隔 |
| `maxEvidenceSessions` / `maxSnippetsPerSession` / `snippetChars` | `2` / `3` / `200` | 召回证据的形态 |
| `memoryDir` | `$DSH_PROFILE_DIR/memory` | 数据目录 |
| `debug` | `false` | 写 `debug.log` |

## 数据文件

记忆目录下的纯文本文件，全部可读、可 grep、可安全手改。

| 文件 | 内容 |
|---|---|
| `profile.md` | 常驻画像 |
| `facts.jsonl` | 一行一条 JSON 事实 |
| `sessions.json` | 会话卡索引（派生缓存，可安全删除） |
| `extract.json` | 每会话的抽取水印 |
| `maintenance.md` | 最近一次 dry-run 维护报告 |
| `debug.log` | 诊断日志，每次启动重置 |

## 面板

侧栏有一个只读的「记忆」页，显示画像、带日期与证据次数的事实，以及会话卡。它读取 `GET /remember/memory.json` —— 插件注册的同源路由。

## 隐私

- 记忆存在你掌控的本地文件里，什么都不上传。
- 插件自身不发网络请求。它唯一的模型调用是事实抽取与合并，都用你 harness 里已配置的模型（`extractProvider` / `extractModel`，或默认模型）。
- 抽取通过宿主的会话索引读你自己的历史，不另外复制对话。
- 提交仓库或分享 `debug.log` 之前先看一眼 —— `.gitignore` 已经把记忆数据排除了。

## 局限

- 没有向量。检索是事实上的关键词/双字打分，加上宿主的全文索引。这个规模到几千条事实、几百个会话都还合适，但它不是语义搜索引擎。
- 分词以中文为主（CJK bigram）。拉丁文本也会分词，但打分是在中文对话上调的。
- 抽取质量取决于所配置的模型；弱模型产出的弱事实，合并判断也更弱。
- 面板是只读的 —— 修改走工具或直接改文件。

## 参考

这个设计借鉴了三个开源记忆系统，值得说清哪条思路来自哪里：

- **hindsight** —— `unrelated / repeats / changes / ends` 合并协议、`proofCount`，以及把日期比较放到代码里而不是提示里。
- **OpenViking** —— 分档预算填充（先把预算铺开给候选，再按分数升档），以及“相似永远不构成同一身份的证据”这条规则。
- **hermes-agent** —— 容量契约（报出超了多少、要求一次批量解决）、唯一子串的 `patch`/`remove`，以及按会话冻结画像以保住提示缓存。

三者都不是依赖。插件只使用宿主的 Cordis 服务（`tools`、`sessionQuery`、`systemPrompt`、`llm`、`webServer`）。

## 开发

```sh
node test/consolidate.test.mjs   # 合并协议、候选召回、预算分档
node test/profile.test.mjs       # 唯一子串编辑、容量契约
node test/recall.test.mjs        # 过去时误触发、ended 过滤、衰减、维护报告
```

三个文件共 46 条断言，不用测试框架，没有构建步骤。

`tools/merge-now.mjs` 是清理既有记忆库的一次性工具：`prompt` 生成合并指令，`apply` 把模型的判定写回，`plan` 执行人工指定的去重计划。三者都会先备份 `facts.jsonl`。

## 许可证

MIT
