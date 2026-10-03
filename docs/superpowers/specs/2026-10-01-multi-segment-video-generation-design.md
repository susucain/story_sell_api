# 长脚本多段视频生成设计（分段 + 逐段确认）

## Goal

让"视频脚本"支持超过单次生成上限（15s）的总时长：把脚本按时长切成多段，每段单独调用 Seedance 生成（单次仍 ≤ 15s），**每段生成完成后由用户确认**，确认后再依据"剩余时长 + 上一段产物"生成下一段，直到全部生成完毕。

本期只产出**分段成片 + 分段预览/确认闭环**，不做服务端自动拼接。

## Scope Decisions（已确认）

- **续接模式：每段由用户自己选。** 前端每段卡片提供「延长上一段 / 尾帧作首帧」切换，后端按选择构造不同的请求场景。
- **拼接：本期不做。** 后端只保证分段产物连续；删帧对齐与拼接留到二期（接口与数据结构预留，见「二期：拼接」）。
- **本期不改动**：单段（`mode: 'single'`）走现有链路，零行为变化；`MAX_VIDEO_DURATION_SEC = 15` 保持不变。

## 现状与硬约束

### 代码事实

| 位置 | 事实 |
| --- | --- |
| [video-task.service.ts](../../../src/video/video-task.service.ts#L62-L63) | `MAX_VIDEO_DURATION_SEC = 15`，`duration > 15` 直接抛 `BadRequestException` |
| [video-task.service.ts](../../../src/video/video-task.service.ts#L186-L193) | 请求体已设 `return_last_frame: true`，`content` 为 `text + image_url(reference_image) + video_url(reference_video)` |
| [video-task.entity.ts](../../../src/video/entities/video-task.entity.ts#L46-L47) | 已存在 `last_frame_url` 字段，尾帧能力已具备 |
| [video-task.service.ts](../../../src/video/video-task.service.ts#L731-L741) | 回调成功后尾帧已转存 OSS 并写入 `lastFrameUrl` |
| [video.controller.ts](../../../src/video/video.controller.ts#L222-L243) | 生成入口 `POST /video/generate`，一次脚本一任务，无分段概念 |
| 项目依赖 | **无 ffmpeg**，无任何服务端拼接能力 |

结论：**尾帧采集与转存已经通了，缺的只是"把尾帧/上一段成片喂给下一段"，以及分段编排。**

### 官方 API 硬约束（火山方舟「创建视频生成任务」）

- `return_last_frame: true` 的设计用途原文即：*"以上一个生成视频的尾帧作为下一个视频任务的首帧，快速生成多个连续视频"*。
- **图生视频-首帧/首尾帧** 与 **多模态参考生视频** 是 **互斥场景，不可混用**；一旦传 `first_frame`，就不能再传 `reference_image` / `reference_video`。
- 首尾帧模式：需 2 个 `image_url` 对象，`role` 分别为 `first_frame` / `last_frame`；只传首帧即「图生视频-首帧」。
- 延长视频属于**多模态参考生视频**（输入 `video_url` + `role: 'reference_video'`）。
- 时长官方范围 4~16s，本项目取更小值 ≤ 15s；`ratio` 全程需一致，首尾帧宽高比不一致时以首帧为准。

### 官方记录的续接风险（决定了保障措施）

| 编号 | 问题 | 官方解法 |
| --- | --- | --- |
| V-6 | 延长视频**衔接处跳变/回退** | 前段末尾删 **6 帧**、后段开头删 **1 帧**；续写时以切镜收尾、下一段以新场景起 |
| V-8 | 延长**画质劣化会叠加**，人脸出斑驳色块 | 输入视频先白模化；**必须挂高清人物图 + 场景图** |
| 10.1 | 用尾帧作首帧时，**首帧画质决定整段画质**，尾帧脏则整段脏/油 | 提示词开头挂抗脏画质包；参考图用明亮均匀柔光 |
| 10.2 | 延长时挂参考图易出**双胞胎/重复人** | 延长时**只上传要参考的视频，不上传参考图**，人物靠文字唯一特征锚定 |
| A-1 | 尾部音频"咔哒"截断音 | 剪辑时对音轨做淡出（二期拼接环节处理） |

另外 `sd2-pe` skill 明确：延长/编辑任务**必须直接写 `向后延长 @视频N`，不能写"参考 @视频N"**，否则被判为参考任务。

## 数据模型

### 新增表 `video_generation_plans`

| 列 | 定义 | 说明 |
| --- | --- | --- |
| `id` | PK | |
| `session_id` | varchar(64), index | 关联会话 |
| `user_id` | int | 归属 |
| `script_id` | int | 关联脚本版本 |
| `target_duration` | int | 脚本总时长（秒），取 `script.meta.duration` |
| `segment_duration` | int, default 15 | 单段时长 |
| `total_segments` | int | 规划段数 |
| `completed_segments` | int, default 0 | 已完成且被用户确认的段数 |
| `status` | varchar(32), default `planning` | `planning / generating / awaiting_confirm / completed / failed / cancelled` |
| `assembled_video_url` | text, null | **二期预留**，拼接成片地址 |
| `created_at` / `updated_at` | | |

### `video_tasks` 新增列（全部可空，保证向后兼容）

| 列 | 定义 | 说明 |
| --- | --- | --- |
| `plan_id` | int, null, index | 为空即现有单段流程 |
| `segment_index` | int, null | 1-based 段序号 |
| `prev_task_id` | varchar(128), null | 上一段的 `task_id`，用于取尾帧/成片 |
| `continuity_mode` | varchar(16), null | 该段实际使用的 `extend` / `frame_bridge` |

唯一约束建议：`(plan_id, segment_index)`。使用 TypeORM 迁移，不依赖 `synchronize: true`。

## 分段策略

1. **段数**：`N = ceil(target_duration / 15)`。
2. **段时长**：第 1..N-1 段为 15s；末段 `= target_duration - 15*(N-1)`。
3. **末段不足最短时长**：若末段 `< 4s`（官方最短），把最后两段的时长重新均分（两者都落在 `[4, 15]` 内），不改变 N。
4. **镜头切分**（关键）：
   - 按 `script.shots` 顺序累加镜头时长，凑满约 15s 切一段；
   - **禁止把一句台词或一个连续动作切到两段**，宁可让该段略短/略长；
   - 若单个镜头本身 > 15s，该镜头必须拆成多段，并在提示词中显式写明承接关系（同一场景、同一运镜延续）。
5. **时长口径**：计划时长用于分段规划；**实际剩余时长按回调返回的真实 `duration` 累加**（回调会覆盖 `task.duration`），避免模型实际产出与请求不符导致累计误差。

## 生成流程与状态机

```
脚本确认
  → 建立 plan（planning，写入 N 段规划）
  → 生成第 1 段（正常生成，duration = min(15, T)）
  → 回调成功：转存成片 + 尾帧 → plan.status = awaiting_confirm
  → 用户确认本段
      ├─ remaining = target - Σ(已完成段实际时长)
      ├─ remaining > 0  → 用户选择续接模式 → 生成第 k 段 → 回到 awaiting_confirm
      └─ remaining ≤ 0  → plan.status = completed（本期到此为止）
```

- 任一段 `failed`：不阻塞其它已完成段；plan 停在 `awaiting_confirm` 供用户重抽该段。
- 前端刷新/断开可恢复：plan 与各段任务全部落库，按 `planId` 拉全量。

## 续接模式详解（用户每段自选）

### 模式 A：`extend`（向后延长上一段，默认）

请求场景：多模态参考生视频。

- `content` = `text` + `video_url`(上一段成片, `role: 'reference_video'`)
- **不传任何参考图**（防双胞胎，见 10.2）；人物/场景靠文字锚定
- 提示词模板：

```
向后延长 @视频1，接续生成第 {k} 段内容。从头衔接上一段画面，保持人物造型、服装、场景、
光线、构图与运镜风格完全一致，动作连贯承接，气口自然。

{脚本全局设定：<主体N> 定义、场景、风格、核心策略}

镜头1：…
镜头2：…

高清，细节丰富，电影质感，色彩自然，光影柔和；人物面部稳定不变形、五官清晰、动作连贯
自然，不僵硬，无穿模无卡顿；保持无字幕，避免生成任何文字或字幕；不要生成水印；不要生成 Logo。
保持无字幕，避免生成任何文字或字幕。
```

- 优点：主体、运镜、音色、叙事天然连续，最贴合本项目"口播 + 剧情"竖屏形态。
- 注意：多次链式延长会累积劣化（V-8）；段数多时应提示用户，或对该段改用模式 B。

### 模式 B：`frame_bridge`（上一段尾帧作本段首帧）

请求场景：图生视频-首帧（与模式 A 互斥）。

- `content` = `text` + `image_url`(上一段 `lastFrameUrl`, `role: 'first_frame'`)
- **不得同时传 `reference_image` / `reference_video`**
- 提示词模板：同模式的全局设定 + 本段镜头 + 兜底，另在**最开头**追加抗脏画质包：

```
高码率高清画质，低噪点无颗粒雪花，画面干净通透，无脏斑色块；人物皮肤哑光无油光无反光，
面部色彩均匀；暗部干净无杂色，动态流畅无拖影
```

- 优点：帧级对接，接缝最干净。
- 注意：尾帧画质会整段继承（10.1）；连续多段使用会越来越油/脏，建议与模式 A 交替使用。

### 两种模式的共同提示词要求（沿用 `sd2-pe` 强制约束）

- 每段复用**同一份全局设定**：`<主体N>` 定义、场景、风格、核心策略 → 跨段一致性来源。
- 必挂兜底：画质包 + 稳定包 + `保持无字幕，避免生成任何文字或字幕` + `不要生成水印；不要生成 Logo`。
- 段落衔接句必写：`从头衔接上一段画面，保持人物造型、服装、场景、光线、构图与运镜风格完全一致`。
- 禁止绝对秒数（`0-3s`），只用「镜头1 / 镜头2」；段内镜头编号接着整脚本顺序延续，不要每段从"镜头1"重置造成风格跳变。
- 台词用 `{…}` 包裹；不得写"参考 @视频N"。

## API 契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/video/generate` | 新增 `mode?: 'single' \| 'segmented'`。`segmented` 时创建 plan 并返回第一段任务 |
| GET | `/video/generate/plan/:planId` | 返回 plan + 各段任务 + 每段 `lastFrameUrl` / `generatedVideoUrl` / 实际时长 |
| POST | `/video/generate/plan/:planId/next` | Body `{ continuity_mode: 'extend' \| 'frame_bridge' }`；校验上一段已 `succeeded` 且 `remaining > 0` 后创建下一段 |
| POST | `/video/generate/plan/:planId/segments/:index/regenerate` | 重抽指定段；**该段之后的已生成段标记为 stale 需重生成**（因续接依赖链被破坏） |
| POST | `/video/generate/plan/:planId/cancel` | 取消计划（不删已完成段产物） |

- 段级状态推送：复用现有 `GET /video/generate/:taskId/stream`（SSE），按 `planId` 汇总查询即可，不必新增 SSE 端点。
- 权限：沿用 `user_id` 归属校验，plan 与 task 一致。

## 前端交互（`agui-frontend/src/pages/VideoStoryboard`）

- 脚本确认后，若 `target_duration > 15`，展示**分段进度条**（第 k/N 段 + 剩余时长）。
- 每段一张卡片：
  - 生成中：状态 + 取消
  - 已完成：预览播放 + 「确认，继续下一段」+「重抽本段」
  - 确认时提供续接方式切换：**延长上一段（默认）** / **尾帧作首帧**
- 全部段完成后：展示分段列表 + 提示"本期不自动拼接，请下载分段后自行剪辑"。
- 刷新恢复：按 `planId` 拉取计划与各段状态（与项目既有"后端持久化"约定一致）。

## 二期：拼接（本期预留，不实现）

- 结构已预留：`plan.assembled_video_url`、段级 `generatedVideoUrl` / `lastFrameUrl`。
- 实现要点（官方口径）：
  1. 统一所有分段的分辨率 / 帧率 / 像素格式后拼接；
  2. **帧对齐**：前段末尾删 6 帧、后段开头删 1 帧（V-6）；
  3. 音轨淡出处理，消除尾部"咔哒"（A-1）；
  4. 输出落 OSS 并回写 `assembled_video_url`。
- 需引入 ffmpeg 依赖与运行环境，作为独立迭代。

## 风险与开放问题

1. **多段延长画质递减是官方未解问题**，只能缓解不能消除；超过 3~4 段建议人工介入或改用模式 B 交替。
2. **分段边界挑错会明显割裂**：需要一个可复用的"按镜头 + 台词完整性切段"函数，并补单测覆盖边界（末段 < 4s、单镜头 > 15s、台词跨段）。
3. **重抽中间段的依赖链**：第 k 段重抽后，k+1..N 段必须作废重生成，UI 需明确提示，避免用户误以为可局部替换。
4. **成本**：段数近似线性放大生成成本，需在 UI 提前提示预计段数与消耗。

## 参考来源

- 火山方舟「创建视频生成任务 API」：`https://www.volcengine.com/docs/82379/1520757`
- 火山方舟英文版（`return_last_frame` 用途说明）：`https://docs.volcengine.com/docs/ark/create-video-generation-task-api`
- 本地 skill：`sd2-pe/SKILL.md`（任务分类、延长句式、强制兜底）、`sd2-pe/references/seedance-2-troubleshooting-guide.md`（V-6 / V-8）、`sd2-pe/references/typical-effect-cases.md`（10.1 / 10.2 / 10.3）
