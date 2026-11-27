# dsh-familiar

[English](README.md) | **简体中文**

给 DeepSeek Harness 打造的跨会话长期记忆插件。

让 AI 记住你是谁、你的项目习惯、被纠正过的做法，不用每次开新会话都从头解释。

记忆就是本地两个纯文本文件，可以用编辑器打开、grep、进 git。没有数据库，没有服务端，插件本身不发任何网络请求。

> npm 包名是 `dsh-familiar-memory`。裸名 `dsh-familiar` 被一个无关的空占位包占着，所以请从仓库安装，或用完整包名。

## ✨ 核心特性

- **本地纯文本存储** —— 记忆就是 `profile.md` + `facts.jsonl` 两个文件，可编辑、可 git 管理，无数据库、无服务端、零网络请求
- **三层记忆架构** —— 常驻画像 + 事实库 + 历史会话原文召回，按需匹配，不灌上下文
- **自动合并去重** —— 新记忆写入前先过一道合并，自动识别重复、更新、失效，记忆库不会越堆越乱
- **静默按需注入** —— 话题沾边才召回相关记忆，单次注入有字数硬上限，也不会把一句话拦腰截断
- **零依赖** —— 无构建步骤，不启动子进程，不需要额外提权，下载即用

## 🚀 快速安装

```sh
git clone https://github.com/yyy2556/dsh-familiar.git dsh-familiar
dsh plugin add /path/to/dsh-familiar
```

重启 DSH 生效。

> 也可以用完整包名从 npm 装：`dsh plugin add dsh-familiar-memory`（发布后可用）。
>
> 升级已有安装不会多出插件行，loader 行 id 固定是 `remember`。

## 🛠️ 日常怎么用

装上就不用管了。插件默认开启自动抽取，你正常聊天，它在回合结束后静默沉淀值得记的信息，下次会话自动召回。

侧栏有一个「记忆」入口，点开能直接看画像、带日期和来源标记的事实、以及会话卡（只读）。

需要主动管理时用这几条指令：

| 指令 | 作用 |
|---|---|
| `memory_recall` | 手动检索记忆，`detail` 支持 brief / normal / deep 三档 |
| `memory_expand` | 把某条历史消息展开成它前后的原始对话，避免用摘要脑补 |
| `memory_remember` | 主动写入：`kind=profile` 进常驻画像，`kind=fact` 进事实库（可用 `operations` 一次批量删旧加新） |
| `memory_list` | 查看已存记忆，按分类计数 |
| `memory_forget` | 删除条目：按事实 id，或按唯一命中的画像文字（多命中会报错列出候选，不会误删） |
| `memory_maintain` | 生成维护报告，加 `{ apply: true }` 才真正归档陈旧内容 |

## 🧠 工作原理

记忆分三层，按优先级注入：

1. **常驻画像（`profile.md`）** —— 约 300 字的核心画像，每次会话都带。有字数上限（默认 500），注入时标题标出占用比例。按会话冻结，手改要等新会话才生效，这样不会打断提示缓存。
2. **事实库（`facts.jsonl`）** —— 沉淀下来的偏好、纠错、项目细节，每条带分类和来源。按话题关键词匹配召回，本地打分，不调模型不查库，没命中就什么都不注入。
3. **历史会话原文** —— 事实不够用时，通过 DSH 全文索引从真实对话里取片段补充细节。拿的是原文，不是模型写的摘要。

召回结果按字数预算分档注入：所有候选先以摘要形式进场，预算够就按分数升到全文，不够就停在摘要档。单次总量有硬上限（默认 1100 字）。

## ⚙️ 配置

在插件页的 `remember` 行下改，或写进 profile 的 `cordis.patch.yml`。常用的几个：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `autoInject` | `true` | 静默自动召回开关 |
| `injectBudgetChars` | `1100` | 单次注入字数硬上限 |
| `profileMaxChars` | `500` | 常驻画像字数上限 |
| `injectCorrectionSlots` | `2` | 纠错类记忆的保底注入名额 |
| `autoExtract` | `true` | 回合结束后自动抽取 |
| `memoryDir` | `$DSH_PROFILE_DIR/memory` | 记忆文件存放目录 |
| `debug` | `false` | 写 `debug.log` 诊断日志 |

完整配置表见[附录](#附录完整配置)。

## 📁 数据文件

所有记忆都存在本地 `memory` 目录下，全部是可读文本，可手动编辑：

| 文件 | 内容 |
|---|---|
| `profile.md` | 常驻画像 |
| `facts.jsonl` | 事实库，一行一条 JSON |
| `sessions.json` | 会话卡索引，派生缓存，删了会自动重建 |
| `extract.json` | 每会话抽取进度 |
| `maintenance.md` | 最近一次维护报告 |
| `debug.log` | 诊断日志，每次启动清空 |

## 🔒 隐私

- 所有记忆数据只存在你的本地设备，不上传任何服务器
- 插件自身不发起任何网络请求
- 只用你 DSH 里已配置的模型做抽取与合并，数据不出本地
- `.gitignore` 已经把记忆数据排除了，但提交仓库或分享 `debug.log` 之前还是看一眼

## 📌 已知局限

- 关键词 + 双字打分检索，没有向量，适合几千条事实、几百个会话的规模，不是语义搜索
- 分词以中文为主，拉丁文本也能分，但打分是在中文对话上调的
- 抽取质量取决于你配置的模型，弱模型产出弱事实
- 侧栏面板只读，修改走工具指令或直接编辑文件

## 🧑‍💻 开发

无构建步骤，直接跑测试：

```sh
node test/consolidate.test.mjs   # 合并协议、候选召回、预算分档
node test/profile.test.mjs       # 唯一子串编辑、容量契约
node test/recall.test.mjs        # 过去时误触发、ended 过滤、衰减、维护报告
```

三个文件 46 条断言，不用测试框架。

`tools/merge-now.mjs` 是清理既有记忆库的一次性工具：`prompt` 生成合并指令，`apply` 写回判定，`plan` 执行人工去重计划。三者都先备份 `facts.jsonl`。

## 致谢

设计思路参考了三个开源记忆系统：

- [hindsight](https://github.com/vectorize-io/hindsight) —— 合并协议、证据计数、日期比较放代码里
- [OpenViking](https://github.com/volcengine/OpenViking) —— 预算分档填充、「相似不等于同一」
- [hermes-agent](https://github.com/NousResearch/hermes-agent) —— 容量契约、唯一子串编辑、按会话冻结画像

都不是依赖。插件只用宿主的 Cordis 服务（`tools`、`sessionQuery`、`systemPrompt`、`llm`、`webServer`）。

## 许可证

MIT

---

# 附录

给维护者和想改代码的人看的，普通使用不需要读。

## 附录：合并协议

新抽出的事实不会直接进库，先过一道合并，否则一个只增不减的列表会迅速堆满近重复。

| effect | 含义 | 落库动作 |
|---|---|---|
| `unrelated` | 和已有事实无关 | 新增一条 |
| `repeats` | 已有事实已经说过 | 不新增，`proofCount + 1` |
| `changes` | 同一属性换了值 | 改写正文，旧值压进 `history`，`createdAt` 不动 |
| `ends` | 某事结束或不再成立 | 用过去时改写，记 `endedAt` |

判定交给模型，候选是机械生成的：token 重叠共享两个以上，外加同分类最近更新的两条。

两条规则约束合并：

- 相似不等于同一。token 重叠、主题相同、分类相同，只说明值得看一眼，不构成同一身份的证据。
- 改写旧事实前，先确认旧文本里没有别的独立信息会被丢掉。有的话另立一条，不整条覆盖。

日期比较在代码里做：新事实按定义更晚，模型不算「距今多少天」。

抽取时会把最近已有的几条事实（上限 `extractKnownMaxChars`）一并给模型看，让它分得清「已经记过」和「新的」；提示词里明确排除了任务进度和只在本次对话里有意义的内容。

没有候选时不发模型调用。模型不可用或某条候选没有得到判定时，本地先精确匹配，再用保守的 4-gram 重叠率兜底（至少 `0.75`，且文本长度差不超过 15%），只在相同类别内生效。模型明确判为 `unrelated` 时尊重该判定。这样更倾向保留补充信息，不误删独立事实。

## 附录：事实元数据

| 字段 | 取值 | 作用 |
|---|---|---|
| `kind` | `fact` `correction` `preference` `project` `environment` | 同分类候选召回、保底名额、面板分组 |
| `source` | `user` / `inferred` | 用户明说的，还是模型归纳的 |
| `origin` | `auto-extract` / `memory_remember` | 写入路径，和 source 是两码事 |
| `proofCount` | 整数 | 被确认过几次，驱动合并与名额排序 |
| `hitCount` / `lastHitAt` | 整数 / 时间戳 | 衰减和归档判断 |
| `archivedAt` | 时间戳 | 退出匹配和注入，但留在文件里 |
| `endedAt` | 时间戳 | 默认隐藏，问到过去时才出现 |

## 附录：纠错类保底名额

`kind: correction` 的事实不需要匹配当前话题，每个会话保底注入 1~2 条。

名额对半分：一个给 `proofCount` 最高的，一个给 `lastHitAt` 最新的。只按证据强度排会让名单固化，老纠正一直占位，新纠正进不来。

保底注入不计入命中。命中只统计话题匹配后的注入，否则保底条目每轮重置衰减，降权机制永远触发不了。

## 附录：衰减与归档

没被命中过的事实掉权重，不掉存在：

- ≥90 天：分数 ×0.8
- ≥180 天：分数 ×0.6
- 已归档：完全排除

没有任何按时间删除的逻辑。归档要显式调 `memory_maintain { apply: true }`。

## 附录：ended 的事实

带 `endedAt` 的事实只在请求带过去时线索时出现（上次、之前、以前、曾经、当时、历史、used to）。线索表收窄过，误触发率很低，触发的都是确实在说过去的句子。

## 附录：维护报告

事实数超过 `maintainThreshold`（默认 120）时，往 `maintenance.md` 写 dry-run 报告：疑似重复（字面 Jaccard ≥ 0.5）、≥180 天没被命中、超长条目（>300 字）、已归档。

报告不改任何数据。

## 附录：画像编辑的两个保护

1. **只认唯一子串**。`remove` / `patch` 必须恰好命中一行。0 命中报错；多命中报错并列出候选。没有整文件替换，整条覆盖会静默抹掉同一行里的其它信息。
2. **容量只在批量结果上检查**。超限时返回差多少字符和当前全部条目，期望一次调用同时删旧的、加新的。否则模型会在「加不进去」和「该删多少」之间打转。

## 附录：完整配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `autoInject` | `true` | 静默自动召回 |
| `injectMode` | `auto` | `notice` 强制提示形式，`off` 关闭注入 |
| `injectBudgetChars` | `1100` | 单次注入硬上限（约 550 token） |
| `injectMaxFacts` | `4` | 单次最多几条事实 |
| `injectCorrectionSlots` | `2` | 纠错类保底名额，0 关闭 |
| `cardScoreThreshold` | `0.30` | 会话卡匹配阈值 |
| `profileMaxChars` | `500` | 画像上限 |
| `maintainThreshold` | `120` | 触发维护报告的事实数 |
| `autoConsolidate` | `true` | 写入前过合并 |
| `autoExtract` | `true` | 回合结束抽取 |
| `extractProvider` / `extractModel` | 宿主默认 | 抽取与合并用的模型 |
| `extractMaxChars` / `extractMaxFacts` | `6000` / `3` | 抽取输入输出上限 |
| `extractKnownMaxChars` | `3000` | 抽取时给模型看的已有事实字符上限 |
| `indexLimit` / `indexTtlMs` | `400` / `300000` | 会话索引规模与刷新间隔 |
| `maxEvidenceSessions` / `maxSnippetsPerSession` / `snippetChars` | `2` / `3` / `200` | 召回证据形态 |
| `memoryDir` | `$DSH_PROFILE_DIR/memory` | 数据目录 |
| `debug` | `false` | 写诊断日志 |