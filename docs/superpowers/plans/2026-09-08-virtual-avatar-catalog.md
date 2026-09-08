# 虚拟人角色目录实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立以 7 个内置虚拟人为唯一权威来源的角色与服装目录，并在分镜保存和视频任务创建时强制执行兼容性校验。

**Architecture:** 在 `src/video` 增加结构化角色与服装目录，集中维护素材、人设锚点、视觉族群、默认服装和可用服装。`VideoToolsService` 在保存脚本前校验并标准化角色服装元数据，`VideoTaskService` 在创建任务前再次校验；skill 仅保留对目录的精简引用，移除旧文本角色和旧服装模板。

**Tech Stack:** NestJS 11、TypeScript、Zod、TypeORM JSON 元数据、Markdown skill 文件、pnpm。

**验证约束:** 用户明确要求不新增单元测试或 skill 扫描测试。本计划仅执行 TypeScript 构建、ESLint 和手工验收；不修改现有测试文件。

---

## 文件结构

- Create: `src/video/avatar-catalog.ts`
  - 角色、服装和标准化角色服装元数据的类型、7 个虚拟人及其兼容服装、解析与校验函数。
- Modify: `src/video/preset-avatars.ts`
  - 从角色目录导出兼容的 `PresetAvatar` API，移除重复的手写人像列表。
- Modify: `src/video/video-tools.service.ts`
  - 扩展 `meta.character` 输入结构，在保存分镜前执行角色服装校验。
- Modify: `src/video/video-task.service.ts`
  - 在创建视频任务前再次校验已保存脚本中的预设虚拟人与服装。
- Modify: `src/video/video.service.ts`
  - 向模型注入角色服装选择和旧角色处理规则。
- Modify: `src/video/skills/life-service-storyboard-generator/SKILL.md`
  - 仅保留 7 个内置虚拟人、目录化服装和旧角色追问规则。
- Modify: `src/video/skills/life-service-storyboard-generator/references/character-prompts.md`
  - 改为 7 个角色的精简索引，不再承载独立服装定义。
- Modify: `src/video/skills/life-service-storyboard-generator/references/preset-outfits.md`
  - 改为目录服装 ID 与适用虚拟人的索引，不再写入“小洁”人设。
- Modify: `src/video/skills/life-service-storyboard-generator/references/{outfit-examples.md,preset-outfits-overview.md,new-outfits-release.md,store-visit-config.md,door-detection-rules.md,seedance_2_0_template.md,user-profile.md}`
  - 清除旧角色、旧服装示例和固定身形指令，替换为 7 个虚拟人或通用主体表述。
- Modify: `src/video/skills/life-service-storyboard-generator/config/user-profile-template.md`
  - 删除旧角色偏好条目。

### Task 1: 建立权威角色与服装目录

**Files:**
- Create: `src/video/avatar-catalog.ts`
- Modify: `src/video/preset-avatars.ts`

- [ ] **Step 1: 定义目录类型和服装 ID**

在 `src/video/avatar-catalog.ts` 创建下列类型，使角色、服装和脚本元数据使用同一组稳定标识：

```ts
export type AvatarVisualFamily = 'modern' | 'hanfu';
export type PresetOutfitId =
  | 'modern-store-visit'
  | 'modern-commute'
  | 'modern-casual'
  | 'hanfu-ceremonial'
  | 'xianxia-traveler'
  | 'wuxia-heroine';

export interface PresetOutfit {
  id: PresetOutfitId;
  alias: string;
  visualFamilies: readonly AvatarVisualFamily[];
  allowedAvatarIds: readonly PresetAvatarId[];
  sceneTags: readonly string[];
  prompt: string;
}

export interface AvatarOutfitSelection {
  mode: 'preset' | 'custom';
  presetOutfitId?: PresetOutfitId;
  customPrompt?: string;
}
```

- [ ] **Step 2: 将 7 个内置虚拟人迁移到目录**

在同一文件中定义 `PRESET_AVATARS`，保留现有 7 个素材 ID 与别名，并为每个角色补充 `visualFamily`、`identityPrompt`、`defaultOutfitId` 和 `allowedOutfitIds`。现代角色只关联现代服装，瑶琴只关联先秦礼服，云游只关联仙侠游侠装，凌霜只关联武侠女侠装。

```ts
{
  id: 'asset-20260804202300-dfnsm',
  alias: '瑶琴',
  displayName: '瑶琴·先秦名伶',
  visualFamily: 'hanfu',
  identityPrompt: '端庄典雅的女性先秦名伶，先秦历史文化题材',
  defaultOutfitId: 'hanfu-ceremonial',
  allowedOutfitIds: ['hanfu-ceremonial'],
}
```

- [ ] **Step 3: 定义服装目录和目录查询函数**

定义 6 套可用服装，服装描述只描述衣着、配饰和气质，不描述“小洁”的年龄、脸型、身材或发型。实现以下导出函数：

```ts
export function getPresetAvatar(id: PresetAvatarId): PresetAvatar;
export function findPresetAvatarByAlias(alias: string): PresetAvatar | undefined;
export function getPresetOutfit(id: PresetOutfitId): PresetOutfit;
export function isPresetAvatarId(value: string): value is PresetAvatarId;
export function isPresetOutfitId(value: string): value is PresetOutfitId;
```

- [ ] **Step 4: 实现目录完整性和角色服装校验**

在 `avatar-catalog.ts` 实现 `validateAvatarOutfitSelection`。它接收预设角色和 `AvatarOutfitSelection`，在未提供服装时返回默认服装；拒绝未知服装、跨视觉族群服装、未被角色允许的服装，以及空白自定义服装。自定义服装仅允许与角色 `visualFamily` 对应的关键词；不匹配时返回可恢复错误，例如“瑶琴仅支持古风服装”。

```ts
export type AvatarCatalogValidation =
  | { success: true; outfit: AvatarOutfitSelection }
  | { success: false; message: string };

export function validateAvatarCatalogIntegrity(): void;
export function validateAvatarOutfitSelection(
  avatar: PresetAvatar,
  outfit?: AvatarOutfitSelection,
): AvatarCatalogValidation;
```

- [ ] **Step 5: 保持原有预设人像模块的导入兼容**

将 `src/video/preset-avatars.ts` 收敛为从 `avatar-catalog.ts` 重新导出原有 `PresetAvatarId`、`PresetAvatar`、`PRESET_AVATARS`、`isPresetAvatarId` 与 `getPresetAvatar`。确认 `video-tools.service.ts` 和 `video-task.service.ts` 无需更改导入路径即可继续编译。

- [ ] **Step 6: 提交角色目录**

```bash
git add src/video/avatar-catalog.ts src/video/preset-avatars.ts
git commit -m "feat: add virtual avatar outfit catalog"
```

### Task 2: 在脚本保存时标准化并校验角色服装

**Files:**
- Modify: `src/video/video-tools.service.ts`

- [ ] **Step 1: 扩展 `meta.character` 的 Zod 结构**

在 `buildGenerateScriptTool` 的 `meta.character` schema 中添加可选的 `outfit` 字段：

```ts
outfit: z.object({
  mode: z.enum(['preset', 'custom']),
  presetOutfitId: z.string().optional(),
  customPrompt: z.string().optional(),
}).optional(),
```

保留该字段为可选，以便历史脚本读取不受影响；新建 `preset_avatar` 脚本必须在服务端标准化为有效服装。

- [ ] **Step 2: 引入目录校验函数**

将 `video-tools.service.ts` 的预设人像导入替换为：

```ts
import {
  getPresetAvatar,
  isPresetAvatarId,
  validateAvatarOutfitSelection,
} from './avatar-catalog';
```

- [ ] **Step 3: 在现有 `preset_avatar` 分支中加入服装校验**

在别名与人像 ID 的匹配检查之后调用目录校验。成功时用返回的标准化服装覆盖 `meta.character.outfit`，使未指定服装时也保存默认服装；失败时返回校验信息，禁止保存脚本。

```ts
const avatar = getPresetAvatar(meta.character.presetAvatarId);
const outfitValidation = validateAvatarOutfitSelection(avatar, meta.character.outfit);
if (!outfitValidation.success) {
  return { success: false, message: outfitValidation.message };
}
meta.character.outfit = outfitValidation.outfit;
```

对 `user_portrait` 和 `none` 模式，若传入 `outfit` 则返回“仅系统内置虚拟人支持预设服装”的错误，避免同一元数据模型出现无主服装。

- [ ] **Step 4: 拦截旧角色名**

在 `preset_avatar` 分支中检查 `roleName`。当值为“小洁”“小丽”“小蓉”时返回“该角色已下线，请选择小叶、程曦、青黛、小岚、瑶琴、云游或凌霜之一”。不要自动映射到任意虚拟人。

- [ ] **Step 5: 提交脚本保存校验**

```bash
git add src/video/video-tools.service.ts
git commit -m "feat: validate avatar outfits when saving scripts"
```

### Task 3: 在视频任务创建前二次校验

**Files:**
- Modify: `src/video/video-task.service.ts`

- [ ] **Step 1: 复用角色服装元数据类型**

在 `video-task.service.ts` 中引入 `AvatarOutfitSelection`、`getPresetAvatar` 和 `validateAvatarOutfitSelection`。扩展本地 `CharacterMeta`：

```ts
interface CharacterMeta {
  mode: 'user_portrait' | 'preset_avatar' | 'none';
  primaryAssetId?: number;
  presetAvatarId?: PresetAvatarId;
  presetAlias?: string;
  outfit?: AvatarOutfitSelection;
}
```

- [ ] **Step 2: 在 `resolveCharacterImageUrl` 中校验已保存元数据**

在预设虚拟人 ID 有效性检查之后，验证 `presetAlias` 与目录别名一致，并调用 `validateAvatarOutfitSelection`。当历史脚本没有 `outfit` 时允许其继续执行；当存在 `outfit` 但校验失败时抛出 `BadRequestException`，并将校验消息原样提供给调用方。

```ts
const avatar = getPresetAvatar(character.presetAvatarId);
if (character.presetAlias && character.presetAlias !== avatar.alias) {
  throw new BadRequestException('脚本绑定的虚拟人像简称无效');
}
if (character.outfit) {
  const validation = validateAvatarOutfitSelection(avatar, character.outfit);
  if (!validation.success) throw new BadRequestException(validation.message);
}
```

- [ ] **Step 3: 提交任务二次校验**

```bash
git add src/video/video-task.service.ts
git commit -m "feat: revalidate avatar outfits before video tasks"
```

### Task 4: 将角色目录规则注入生成上下文

**Files:**
- Modify: `src/video/video.service.ts`

- [ ] **Step 1: 从目录生成系统提示词中的角色表**

在构造视频 agent 系统提示词的模块顶部导入 `PRESET_AVATARS` 与对应服装查询函数。以目录数据生成别名、题材、默认服装和可选服装摘要，替代硬编码的 7 个名字与分散的服装规则。

```ts
const avatarChoices = PRESET_AVATARS.map((avatar) =>
  `${avatar.alias}（${avatar.identityPrompt}；默认服装：${getPresetOutfit(avatar.defaultOutfitId).alias}）`,
).join('；');
```

- [ ] **Step 2: 更新角色选择规则**

替换现有“用户说出 7 个角色即绑定预设人像”的系统提示词，增加以下强制规则：

```text
选择预设虚拟人时，meta.character.outfit 必须填写。
未指定服装时使用目录默认服装。
用户指定预设服装时，只能选择该虚拟人允许的服装。
用户要求“小洁”“小丽”“小蓉”等旧角色时，调用 request_user_confirmation 要求从 7 个内置虚拟人中选择；禁止自动映射或保存脚本。
```

- [ ] **Step 3: 提交系统提示词改动**

```bash
git add src/video/video.service.ts
git commit -m "feat: guide avatar outfit selection in video agent"
```

### Task 5: 清理 skill 中的平行角色与服装体系

**Files:**
- Modify: `src/video/skills/life-service-storyboard-generator/SKILL.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/character-prompts.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/preset-outfits.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/outfit-examples.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/preset-outfits-overview.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/new-outfits-release.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/store-visit-config.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/door-detection-rules.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/seedance_2_0_template.md`
- Modify: `src/video/skills/life-service-storyboard-generator/references/user-profile.md`
- Modify: `src/video/skills/life-service-storyboard-generator/config/user-profile-template.md`

- [ ] **Step 1: 重写 `SKILL.md` 的角色入口**

保留 7 个别名和其素材 ID 的简短说明，但将服装来源明确为“运行时角色目录”。删除“小丽”“小蓉”“小洁”预设角色描述，改为以下规则：

```text
仅小叶、程曦、青黛、小岚、瑶琴、云游、凌霜可作为系统虚拟人。
旧角色名不是系统虚拟人；遇到时必须要求用户选择上述角色，不得沿用旧角色文本描述。
每个预设虚拟人必须使用目录默认服装或其兼容服装，禁止跨现代与古风视觉族群搭配。
```

- [ ] **Step 2: 收敛角色和服装参考文件**

将 `character-prompts.md` 重写为 7 个角色的别名、人设边界和题材摘要；将 `preset-outfits.md` 重写为 6 套服装的稳定 ID、名称、适用角色和场景标签。两份文件均不写素材 ID、独立的人脸描述或“小洁”示例。

- [ ] **Step 3: 清理剩余活动参考文件**

在列出的样例、规则、模板和用户画像文件中删除“小洁”“小丽”“小蓉”及与之绑定的身材、镜头、口播规则。将现代探店样例统一为“小岚”，职场样例使用“程曦”，国风、仙侠、武侠样例分别使用“瑶琴”“云游”“凌霜”；没有必要点名角色的地方改为“主角色”。

不修改 `docs/storyboards/` 下的历史分镜归档。

- [ ] **Step 4: 检查活动 skill 内容**

运行下列命令，确保历史归档以外的有效 skill 文件不再包含旧角色名：

```bash
rg -n '小洁|小丽|小蓉' src/video/skills/life-service-storyboard-generator \
  -g '!docs/storyboards/**'
```

预期：无匹配结果。

- [ ] **Step 5: 提交 skill 清理**

```bash
git add src/video/skills/life-service-storyboard-generator
git commit -m "docs: align storyboard skill with avatar catalog"
```

### Task 6: 构建、静态检查与手工验收

**Files:**
- Modify: 无

- [ ] **Step 1: 执行 TypeScript 构建**

```bash
pnpm build
```

预期：命令以退出码 0 完成，Nest 编译成功。

- [ ] **Step 2: 执行 ESLint**

```bash
pnpm lint
```

预期：命令以退出码 0 完成。注意该项目的 `lint` 脚本带 `--fix`；提交前检查其是否产生预期外变更。

- [ ] **Step 3: 手工验收保存分镜**

通过视频生成接口或开发环境依次验证：

1. 输入“用小岚出镜”且未指定服装，保存结果为 `preset_avatar`，并包含小岚的默认现代服装。
2. 输入“用瑶琴出镜，穿职场通勤装”，保存被拒绝并提示选择古风服装。
3. 输入“用小洁出镜”，流程进入角色选择确认，且不会生成或保存新脚本。
4. 输入“用程曦出镜，穿职场通勤装”，保存成功且角色、别名、服装 ID 一致。

- [ ] **Step 4: 手工验收视频任务二次校验**

对一份已保存脚本，在数据库或受控开发请求中将 `presetAlias` 或服装 ID 改为与角色不兼容的值后创建视频任务。

预期：任务创建返回明确的 `BadRequestException` 错误，不提交外部视频生成请求。

- [ ] **Step 5: 提交验证后产生的预期格式化变更**

若 `pnpm lint` 修改了上述任务涉及的源文件，检查 diff 后提交：

```bash
git add src/video
git commit -m "style: format avatar catalog changes"
```

若没有格式化变更，不创建空提交。

## 计划自检

- 目录模型、skill 投影、脚本保存校验、视频任务二次校验、旧角色处理和历史脚本兼容均有对应任务。
- 未安排新增单元测试或 skill 扫描测试，符合用户明确约束。
- 不修改历史分镜归档，不新增虚拟人，不移除上传人像功能。
- 角色、服装和元数据字段在所有任务中统一使用 `presetAvatarId`、`presetAlias` 与 `outfit`。
