# 可恢复的 Agent 运行（Run）设计

## Goal

把「生成任务的执行生命周期」从「HTTP 连接的生命周期」里解耦出来，让长耗时（单轮 60s~900s）的脚本创作：

1. **不因客户端断开而中断** —— 刷新、切换会话、切标签页、断网都不再杀死任务；
2. **刷新后可续订** —— 恢复创作过程面板与已流出的正文，并从断点继续实时更新；
3. **副作用恰好一次** —— 重试/重放不会产生第二个脚本；
4. **中止必须显式** —— 只有「停止生成」或超时才会取消任务；
5. **会话级并发** —— A 会话在生成时，B 会话可正常提问，互不阻塞。

本期覆盖脚本创作链路；机制按通用 run 协议设计，后续可平移到视频生成等长任务。

## 背景：四个已证实的问题

| 编号 | 现象 | 根因（代码位置） |
| --- | --- | --- |
| S1 | 刷新页面后生成被掐断 | [video.controller.ts](../../../src/video/video.controller.ts#L117-L125) 监听 `res` 的 `close`，连接断开即 `abort`，一路贯穿到执行器的 `totalSignal` |
| S2 | 刷新后过程面板消失 | 面板状态以 `data-process-state` 流式 part 承载（[process-tracker.ts](../../../src/video/process-tracker.ts#L502-L510)），仅存在于连接内，不落库 |
| S3 | 刷新后脚本卡消失 | [video.service.ts](../../../src/video/video.service.ts#L554-L562) 的 `onEnd` 仅在 `completed === true` 时落库；超时中止时助手消息整体丢失 |
| S4 | 切换会话后输入框被锁 | `busy` / `canSend` 依赖 `useChat` 的**单一** `status`，跨会话共用导致新会话被判定为"正在处理" |
| S5 | 切换会话后旧任务成孤儿 | [index.tsx](../../../agui-frontend/src/pages/VideoStoryboard/index.tsx#L663-L683) 的 `handleSwitchSession` 未中止在途请求，旧流仍在后台跑并争夺同一份 `messages` 状态 |
| S6 | 副作用与消息不一致 | 脚本已写入 `video_scripts`，但助手消息未落库；前端提示"操作状态未知，请刷新查看结果"，刷新后却看不到任何东西 |

一次真实事故的时间线（本地库）：请求 00:23:28 → 脚本 80 落库 00:28:08（**280s**）→ 总预算 300s 耗尽中止 → 助手消息丢失 → 用户点「刷新查看结果」触发历史覆盖，带面板的那条本地消息被整条抹掉 → 之后一轮模型只复述旁白、零工具调用，于是"连过程条都没有"。

## Scope Decisions（已确认）

- **断开 ≠ 取消。** 客户端断开连接只意味着"客户端不再订阅"，不构成取消。取消只有两个来源：用户显式「停止生成」、或 run 超时/配额回收。
- **面板不落库。** 沿用既有硬约束「数据库只存消息元数据」。面板与正文增量走事件日志，不进 `messages` 表。
- **正文一起恢复（已确认）。** 刷新后不仅恢复进度面板，还要恢复"已流出但尚未落库"的正文文本。
- **恢复形态：待定。** 候选为「完整过程面板」与「轻量状态条」两种；因 Phase 0/1 不涉及该选择，**最迟在 Phase 2 开工前拍板**，默认按完整面板推进。
- **本期不做：** 跨实例的无损迁移（先单实例 + Redis 事件重放）；工具级断点续跑（只做阶段级续跑）。

## 现状与硬约束

### 代码事实

| 位置 | 事实 |
| --- | --- |
| [video.controller.ts](../../../src/video/video.controller.ts#L102-L147) | 用 `disconnectController` 把客户端断开映射成 abort signal，作为 `parentSignal` 传给 `streamChat` |
| [video.controller.ts](../../../src/video/video.controller.ts#L147) | 响应经 `pipeUIMessageStreamToResponse` 输出 |
| `ai` 包内部（`UI_MESSAGE_STREAM_HEADERS`） | 已内置 `content-type: text/event-stream`、`cache-control: no-cache`、`connection: keep-alive`、**`x-accel-buffering: no`**、`x-vercel-ai-ui-message-stream: v1` |
| `ai` 包内部（`writeToServerResponse`） | 每个 SSE 事件一次 `response.write(value)`，`value` 是完整 SSE 帧 |
| [process-tracker.ts](../../../src/video/process-tracker.ts#L502-L510) | 每次 `emit()` 推送的是**全量状态快照**（`JSON.parse(JSON.stringify(this.state))`），而非增量 |
| [video.service.ts](../../../src/video/video.service.ts#L554-L562) | 仅成功路径落库助手消息 |
| [video.service.ts](../../../src/video/video.service.ts#L1098-L1153) | `saveAssistantUIMessage` 只写 `content` + `toolCalls`（工具名 + 500 字摘要）+ `metadata.scriptId`，**不写 `parts`** |
| [video.service.ts](../../../src/video/video.service.ts#L737-L748) | 历史接口因 `parts` 为空，助手消息只还原成一个 text part |
| [video.service.ts](../../../src/video/video.service.ts#L1161-L1180) | 已实现「中止兜底」：本轮已生成脚本但整体被中断时，补写一条助手消息 |
| [index.tsx](../../../agui-frontend/src/pages/VideoStoryboard/index.tsx#L474-L477) | `handleStop` 调用 `stop()` + 移除未完成的助手轮次 |
| [index.tsx](../../../agui-frontend/src/pages/VideoStoryboard/index.tsx#L195-L202) | 面板取**最后一条** `data-process-state` part 渲染 |
| [video-generation-plan](../../../src/video/video-generation-plan.service.ts) | 分段视频已实现 planId 落库 + 前端刷新后恢复面板 + Redis 推送，是本方案的**既有先例** |

### 关键结论

- **面板数据不需要"事件溯源重建"**：因为 `emit()` 每次都是全量快照，恢复时只需取**最新一条快照**（`XREVRANGE ... COUNT 1`），复杂度远低于预期。
- **已流出的正文必须进事件流**：否则刷新后只能恢复进度条，正文要等本轮落库才出现，体验割裂。
- **SSE 传输层已就绪**：`x-accel-buffering: no` 由 SDK 内置，生产 nginx 的 `proxy_read_timeout` 已对齐 930s，静默上限（模型首事件预算 180s）小于该值。

## 业界调研结论

| 方案 | 代表实现 | 断开后任务 | 刷新恢复 | 显式中止 | 幂等 | 改造成本 |
| --- | --- | --- | --- | --- | --- | --- |
| A 长连接直跑（现状） | 裸 SSE/HTTP | ✗ 中止 | ✗ | 隐式 | ✗ | — |
| B 后台任务 + 轮询 | BullMQ + `GET /jobs/:id` | ✓ 继续 | ✓ 查状态 | ✓ | 需自建 | 低 |
| C 后台任务 + 推送 + 游标重放 | Redis Stream + SSE + `Last-Event-ID` | ✓ 继续 | ✓ 秒级续上 | ✓ | 需自建 | 中 |
| D 持久化执行引擎 | Temporal / Restate / Inngest / DBOS | ✓ 继续 | ✓ 含断点续跑 | ✓ | 内建 | 高 |
| E 连接层托管 | Vercel `resumable-stream` | ✓ 继续 | △ 仅整页刷新 | ✗ 与 `stop()` 冲突 | ✗ | 低但覆盖窄 |

**结论：选 C。** 理由：

- **不选 D**：Temporal 要求确定性重放，而流水线核心是 LLM 非确定性调用，必须整体下沉为 Activity，改造面过大；且 `agent_runs` + `tool_invocations` 本身就是最小可用的执行日志，未来可平滑迁移。
- **不选 E**：只覆盖整页刷新，且与 `stop()` 不兼容（上游 issue #8390 已确认），治不了 S4/S5/S6。
- **选 C 的底气**：Redis 已在栈内（`video-task-updates`），且分段视频的 planId 恢复模式已验证可行。

## 目标架构

```
浏览器 UI ──POST /chat──▶ 接入层(NestJS) ──▶ Run 记录 + 事件日志 ──▶ 后台执行器(多 Agent)
    ▲                        │                 (MySQL + Redis Stream)        │
    └──── 事件流（含正文增量）─┘ ◀────────────── 写入事件 ◀──────────────────┘
```

核心是中间那一列：**Run 是执行的一等公民，事件日志是可重放的真相来源**，两侧都只跟它打交道。

### 事件模型

```ts
run_event = { seq: number, ts: number, type: RunEventType, payload: unknown }

type RunEventType =
  | 'phase'        // 阶段开始/结束
  | 'tool'         // 工具调用摘要
  | 'panel'        // 面板全量快照（复用现有 emit 语义）
  | 'text-delta'   // 正文增量（按 100ms 合批）
  | 'result'       // 结果引用（scriptId / planId）
  | 'error' | 'done'
```

- `seq` 单调递增，作为 SSE 的 `id:` 与重放游标。
- **DB 只存里程碑**：阶段起止、工具摘要、结果引用。
- **高频数据只进 Redis Stream**：`XADD run:{runId}:events MAXLEN ~ 2000`，TTL 24h。正文全量文本不落 DB，符合现有硬约束。

### 接口契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/video/chat` | 幂等创建或复用 run；投递执行；**202 + `{ runId }`** |
| `GET` | `/video/runs/:runId/events?after=<seq>` | 先重放 `seq > after`，再尾随推送；发 `id:` / `retry:` / 25s 心跳注释 |
| `POST` | `/video/runs/:runId/cancel` | **唯一**的中止入口 |
| `GET` | `/video/sessions/:id/active-run` | 只返回**非终态** run，供前端挂载/切回时恢复 |

**恢复规则**：`active-run` 返回终态时前端不挂面板，直接渲染历史，避免"面板闪一下又消失"的竞态观感。

### 前端契约

- 挂载 / 切回会话 → `active-run` → 用最新 `panel` 快照渲染 → 用 `text-delta` 拼回正文 → 按 `after=lastSeq` 订阅增量。
- 面板状态来源从"消息 part"迁移为"run 视图"；历史消息只负责静态展示。
- composer 锁改为**按会话**：`statusBySession[sessionId]`。
- 断线自动重连（指数退避）+ `visibilitychange` 回前台立即重试。

## 核心模块划分

| 模块 | 职责 | 落地要点 |
| --- | --- | --- |
| M1 Run 生命周期 | `queued → running → awaiting_user → succeeded / failed / cancelled` | `agent_runs` 表 + 乐观锁；`idempotency_key` 唯一约束 |
| M2 事件总线与重放 | 追加事件、按 seq 重放、尾随推送 | Redis Stream + MAXLEN + TTL；seq 空洞触发快照重建 |
| M3 后台执行器 | 脱离请求信号执行流水线 | 复用现有 `runTotalAgent`，仅解除信号绑定 |
| M4 幂等与副作用台账 | 工具恰好一次 + 阶段级续跑 | `tool_invocations(run_id, step_index, tool, args_hash)` 唯一；`generate_script` 幂等键 = `(session_id, user_msg_id, revision)` |
| M5 心跳与崩溃回收 | 发现孤儿 run 并对账 | `heartbeat_at` + sweeper；Phase 0 的「中止兜底」是其极简版 |
| M6 前端 Run 恢复 | 面板 + 正文恢复、断线重连 | 复用 planId 恢复模式 |
| M7 会话级并发与配额 | 同会话串行、跨会话并行 | 同 session 至多 1 个 running run |
| M8 可观测性 | runId 全链路贯穿 | Langfuse trace + 指标 |

## 技术选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 执行编排 | BullMQ（Redis） | Redis 已在栈内，零新中间件 |
| 事件重放 | Redis Stream | 支持范围查询 + 阻塞读；Pub/Sub 无重放能力，不用 |
| 状态存储 | MySQL `agent_runs` + 里程碑 | 沿用 TypeORM 迁移 |
| 传输 | SSE（HTTP/2） | 沿用现有链路；HTTP/1.1 每域 6 连接上限，需 HTTP/2 |
| 前端 | 保留 AI SDK + 新增 run 订阅层 | 不引入 `resumable-stream`（与 stop 冲突） |
| D 类引擎 | 暂不引入，预留迁移路径 | 触发条件：跨实例断点续跑 / 长时人工审批 / 复杂重试策略 |

## 实施计划

### Phase 0 · 止血（已完成）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 超时预算对齐 | ✅ 已完成 | `.env` 六项预算与 `env.prod.example` 对齐，总预算 300s → 900s，新增 `ROLE_TIMEOUT` |
| 中止兜底 | ✅ 已完成 | 本轮已生成脚本但被中断时补写助手消息，消除 S6 的自相矛盾 |
| SSE 响应头 | ✅ 无需改动 | 审计发现 `x-accel-buffering: no` / `cache-control` / `connection` 由 SDK 内置 |
| 静默期心跳 | ⏸ 暂不需要 | 生产 nginx 直连 ECS 且 `proxy_read_timeout=930s` > 最长静默 180s；若未来引入 LB 再加 |
| 切会话语义明确 | ✅ 已完成 | 切换会话时中止在途请求并提示，消除"孤儿任务 + 输入锁死"（Phase 1 替换为 detach + 恢复） |

### Phase 1 · Run 一等公民（流协议不变）

- 新增 `agent_runs` 表 + `idempotency_key` 唯一约束。
- `POST /video/chat` 返回 `runId`；新增 `POST /video/runs/:runId/cancel`。
- **翻转断开语义**：客户端断开不再 abort，只解绑订阅。
- 在途 run 用进程内注册表（`sessionId → runId`）管理，暂不引队列。

**验收**：刷新后 run 仍成功 = 100%；重复脚本率 = 0；显式取消后 30s 内停止。

### Phase 2 · 事件重放 + 正文恢复

- Redis Stream 落 `panel` / `text-delta` / `result` 事件（正文 100ms 合批）。
- 新增 `GET /video/runs/:runId/events`（重放 + 尾随）与 `GET /video/sessions/:id/active-run`。
- 前端改为 run 订阅；composer 锁改会话级；恢复形态按「待定项」拍板。

**验收**：生成中刷新 → 面板与正文恢复 P95 < 1s；seq 无空洞；多标签页同时订阅互不影响。

### Phase 3 · 自愈

- BullMQ worker + `heartbeat_at` + sweeper + 台账对账。
- 崩溃后按 `tool_invocations` 判断 run 最终态（reconcile 成 succeeded 或 failed）。

**验收**：`kill -9` worker 后 run 最终态正确率 100%；孤儿 run 数 = 0。

### Phase 4 · 规模化

- Redis Stream 广播替代进程内广播；配额与优先级；run 类型注册表。

**验收**：200 并发会话无串话、无连接泄漏。

## 风险评估与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 语义变化：断开不再取消，用户以为停了其实在跑 | 成本浪费 | 显式「停止生成」入口 + run 硬超时上限 + 空闲心跳回收 |
| 事件膨胀 | Redis 内存 | `MAXLEN ~2000` + 24h TTL + 仅里程碑落 DB |
| 重复副作用 | 数据脏 / 重复计费 | 幂等键 + 唯一约束 + 台账对账 |
| 队列积压 | 长尾延迟 | 并发上限 + 优先级 + 单会话 1 run |
| 迁移风险 | 线上回归 | 双写 + feature flag 灰度 + 保留旧路径回滚开关 |
| 事件 schema 漂移 | 旧客户端解析失败 | schema 版本号 + 未知类型忽略 + 兼容解析 |
| 恢复逻辑与快照不一致 | 面板错乱 | 快照为全量语义；seq 空洞时强制重新拉快照 |

## 质量保障

- **单测**：run 状态机非法迁移、seq 连续性、幂等键冲突、重放与快照一致性。
- **集成**：断开后 run 仍完成；取消后 30s 内停止；重试不产生第二个脚本。
- **混沌**：随机断连/切会话、Redis 抖动、worker 被 kill、DB 写成功但响应丢失。
- **压测**：并发会话数、事件吞吐、SSE 长连接数、HTTP/1.1 连接槽位耗尽。
- **可观测指标**：time-to-first-event、各阶段时长、恢复率、重复副作用率、孤儿 run 数、SSE 重连次数、队列深度。
- **发布**：双写灰度 → 影子比对 → 按会话比例放量 → 全量。

## 可扩展性

1. **Run 类型注册表**：`kind` 驱动（`script` / `video` / 未来的剪辑、配音），一套协议服务所有长任务。
2. **事件总线收敛**：把现有 `video-task-updates` 与 run events 合并为一个 bus、两类主题，避免两套推送并存。
3. **恢复协议通用化**：把 `planId → SegmentPlanPanel` 提炼为 `runId → RunView`，新功能默认获得"刷新可恢复"。
4. **多实例就绪**：Phase 4 用 Redis Stream 广播替代进程内广播，天然支持水平扩容。
5. **向 D 演进**：`agent_runs` + `tool_invocations` 即执行日志，未来接 Temporal/Restate 时业务层无需重写。

## 待拍板事项

| 编号 | 事项 | 影响阶段 | 默认建议 |
| --- | --- | --- | --- |
| 1 | 恢复形态：完整过程面板 / 轻量状态条 | Phase 2 | 完整过程面板（信息更全，正文恢复后体验连贯） |
| 2 | 完成后是否自动收起面板 | Phase 0 可选 | 自动收起（降低长历史噪音） |
| 3 | run 记录保留期 | Phase 3 | 终态后 7 天归档清理 |
