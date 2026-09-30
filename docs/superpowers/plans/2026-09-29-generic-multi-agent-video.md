# Generic Multi-Agent Video Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-skill, single-agent life-service video pipeline into a generic, multi-vertical pipeline driven by an orchestrator agent that dispatches specialized role agents (screenwriter / director / cinematographer), while keeping the existing Seedance generation path unchanged.

**Architecture:** Keep one streaming entry point and the AGUI stream contract. Replace the hardcoded identity + guide routing in the system prompt with data-driven **role profiles** selected per request. Replace the hardcoded `VIDEO_SKILLS` / `VIDEO_REFERENCES` constants with a directory-scanned **skill registry**. Introduce a **Director (orchestrator) agent** that produces a structured creative brief and dispatches role sub-agents, each holding its own scoped skill/tool subset. Generalize the e-commerce `productProfile` and the single storyboard parser format into a per-vertical brief + parser strategy. The generation side (Seedance submit/callback/persist) is explicitly out of scope.

**Tech Stack:** NestJS, TypeORM, Vercel AI SDK (`ToolLoopAgent`, `tool`, `zodSchema`), Zod, Jest, React + Vite (frontend process panel).

---

## Scope Decisions (confirmed)

- **通用化范围:** 多垂类 — one multi-agent framework must serve life-service plus other categories (knowledge口播, brand ads, narrative shorts), switched by profile/skill.
- **生成能力:** 暂不动 — `MAX_VIDEO_DURATION_SEC = 15` single-prompt Seedance path stays as-is. Multi-shot stitching is deferred (see Out of Scope).
- **编排形态:** 编排 Agent 自主调度 — Director Agent decides which role agents to invoke via tool calls (aligned with FilmAgent / AniME), bounded by a global deadline budget.

## Reference Prior Art

- **FilmAgent** (SIGGRAPH Asia 2024, arXiv 2501.12909) — director / screenwriter / actor / cinematographer; Critique-Correct-Verify, Debate-Judge.
- **MovieAgent** (arXiv 2503.07314, NUS) — hierarchical Director → Scene → Shot planning.
- **MAViS** (arXiv 2508.08487) — script / shot / character / keyframe / animation / audio + Shot/Voice/Subtitle Reviewer.
- **AniME** (SIGGRAPH Asia 2025, Bilibili) — centralized Director Agent + per-agent MCP toolboxes + global Asset Memory Bank.

Mapping: our green "编排 Agent" = FilmAgent/MovieAgent Director; role sub-agents = screenwriter / cinematographer; the optional reviewer = MAViS reviewer role.

## Current Coupling Points (must be removed)

1. Hardcoded identity + guide routing — `src/video/video.service.ts:784`, `:829-834`.
2. Hardcoded skill registry — `src/video/skill-loader.service.ts:11-34`.
3. E-commerce tool fields — `src/video/video-tools.service.ts:308-347` (`update_product_profile`).
4. Domain-locked script meta schema — `src/video/video-tools.service.ts:349-361` (`character.mode`, `outfit`, `edit.mode`, `ratio`).
5. Single storyboard format — `src/video/storyboard-parser.service.ts:47-83`.
6. Fixed 3-phase process panel — `src/video/types/process-state.ts:35-36`.

## File Structure

- Create: `src/video/agent-role.registry.ts` — Role profile type + built-in profiles (`director`, `screenwriter`, `shot-planner`, `cinematographer`, optional `reviewer`).
- Modify: `src/video/skill-loader.service.ts` — Directory-scanned skill/reference registry; keep `SkillMeta` frontmatter parsing.
- Create: `test/unit/video/skill-loader.service.spec.ts` (extend) — Registry scan + name routing tests.
- Modify: `src/video/video.service.ts` — `buildSystemPrompt(roleProfile, ctx)`; Director orchestrator loop; per-role agent construction.
- Modify: `src/video/video-tools.service.ts` — `buildTools(ctx, roleProfile)` returns role-scoped tool subsets; generalize `update_product_profile` → `update_creative_brief`.
- Modify: `test/unit/video/video-system-prompt.spec.ts` — Prompt is built from profile; no hardcoded life-service strings when a non-life-service profile is active.
- Modify: `src/video/entities/video-session.entity.ts` — `productProfile` → `creativeBrief` (JSON, vertical-agnostic) with migration/兼容.
- Modify: `src/video/storyboard-parser.service.ts` — Parser strategy registry keyed by vertical/profile.
- Modify: `src/video/types/process-state.ts` — Dynamic phase descriptor list instead of a fixed union.
- Modify: `agui-frontend/src/components/AgentMessage/process-types.ts` + `src/pages/VideoStoryboard/index.tsx` — Render backend-provided dynamic phases.
- Modify: `src/video/video.module.ts` — Register the role registry provider.

---

## Task 1: Directory-scanned skill registry

**Files:**
- Modify: `src/video/skill-loader.service.ts`
- Test: `test/unit/video/skill-loader.service.spec.ts`

- [ ] **Step 1: Write failing tests for dynamic registry behavior**

```ts
it('discovers every SKILL.md under the skills dir', async () => {
  const registry = await service.listSkills();
  expect(registry.map((s) => s.name)).toEqual(
    expect.arrayContaining(['life-service-storyboard-generator', 'sd2-pe']),
  );
});

it('lists references for a given skill by scanning its references dir', async () => {
  const refs = await service.listReferences('life-service-storyboard-generator');
  expect(refs).toEqual(expect.arrayContaining(['routing', 'storyboard', 'seedance', 'character']));
});

it('throws a typed error for an unknown skill name', async () => {
  await expect(service.loadMeta('does-not-exist')).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- skill-loader.service.spec.ts --runInBand`
Expected: FAIL because `listSkills` / `listReferences` do not exist.

- [ ] **Step 3: Implement scanning-based registry**

Replace the `VIDEO_SKILLS` / `VIDEO_REFERENCES` constants with runtime discovery: read `skillsDir` entries, find `SKILL.md` per skill, parse frontmatter via the existing `loadMeta` path, and enumerate `references/*.md` per skill. Keep `loadMeta()` but make the skill name **required** (no more implicit default).

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test -- skill-loader.service.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/skill-loader.service.ts test/unit/video/skill-loader.service.spec.ts
git commit -m "refactor(video): discover skills dynamically instead of hardcoding registry"
```

---

## Task 2: Role profile registry

**Files:**
- Create: `src/video/agent-role.registry.ts`
- Modify: `src/video/video.module.ts`
- Test: `test/unit/video/agent-role.registry.spec.ts`

- [ ] **Step 1: Write failing tests for role profiles**

```ts
it('exposes a director profile that can dispatch role agents', () => {
  const profile = getRoleProfile('director');
  expect(profile.allowedSkills).toContain('life-service-storyboard-generator');
  expect(profile.dispatches).toEqual(
    expect.arrayContaining(['screenwriter', 'shot-planner', 'cinematographer']),
  );
});

it('exposes a screenwriter profile scoped to script-writing skills only', () => {
  const profile = getRoleProfile('screenwriter');
  expect(profile.allowedTools).not.toContain('create_video_task');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- agent-role.registry.spec.ts --runInBand`
Expected: FAIL because `agent-role.registry.ts` does not exist.

- [ ] **Step 3: Implement the role profile type + built-ins**

Define a `RoleProfile` shape: `{ id, displayName, identity, allowedSkills: string[], allowedTools: string[], outputSchemaHint?, dispatches?: string[], vertical?: string }`. Ship built-ins `director` / `screenwriter` / `shot-planner` / `cinematographer` / `reviewer`. `director` is the only profile with `dispatches` and the only one allowed to call the generation-side tools once Phase 3 lands.

- [ ] **Step 4: Register the provider in `video.module.ts`**

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `pnpm test -- agent-role.registry.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/video/agent-role.registry.ts src/video/video.module.ts test/unit/video/agent-role.registry.spec.ts
git commit -m "feat(video): add role profile registry for multi-agent roles"
```

---

## Task 3: Profile-driven system prompt (behavior-equivalent for life-service)

**Files:**
- Modify: `src/video/video.service.ts` (`buildSystemPrompt`)
- Test: `test/unit/video/video-system-prompt.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('renders the active role identity instead of a hardcoded workbench name', async () => {
  const prompt = await build('screenwriter');
  expect(prompt).not.toContain('映语 AI 达人带货视频工作台');
  expect(prompt).toContain(getRoleProfile('screenwriter').identity);
});

it('routes guides from the profile skills, not a hardcoded path list', async () => {
  const prompt = await build('director', { vertical: 'life-service' });
  expect(prompt).toContain('life-service-storyboard-generator/references/routing.md');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- video-system-prompt.spec.ts --runInBand`
Expected: FAIL because the prompt still hardcodes the workbench identity.

- [ ] **Step 3: Refactor `buildSystemPrompt` to take a profile**

Change the signature to accept a `RoleProfile` (and keep the existing `session` / `referencedScript` / `sourceVideoAsset` / `currentAssets` context). Build the identity line, the guide-routing section, and the persistence-constraint section from profile data. Register a `life-service` profile whose routing text is identical to the current strings so behavior is preserved for the existing vertical.

- [ ] **Step 4: Run the focused test + the existing prompt spec to verify no regression**

Run: `pnpm test -- video-system-prompt.spec.ts video.service.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/video.service.ts test/unit/video/video-system-prompt.spec.ts
git commit -m "refactor(video): build system prompt from role profile data"
```

---

## Task 4: Role-scoped tool subsets

**Files:**
- Modify: `src/video/video-tools.service.ts` (`buildTools`)
- Test: `test/unit/video/video-tools.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('only exposes tools allowed by the active role profile', () => {
  const tools = service.buildTools(ctx, getRoleProfile('screenwriter'));
  expect(tools).toHaveProperty('generate_script');
  expect(tools).not.toHaveProperty('create_video_task');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- video-tools.service.spec.ts --runInBand`
Expected: FAIL because `buildTools` ignores role scoping.

- [ ] **Step 3: Scope `buildTools` by profile**

Take a `RoleProfile` argument and return only the tools in `profile.allowedTools`. Keep all existing tool builders intact; only the assembly changes. `director` gets the dispatch tools (Task 5) plus read-only query tools.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test -- video-tools.service.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/video-tools.service.ts test/unit/video/video-tools.service.spec.ts
git commit -m "feat(video): scope tool set by role profile"
```

---

## Task 5: Director orchestrator with role-agent dispatch

**Files:**
- Create: `src/video/agent-orchestrator.service.ts`
- Modify: `src/video/video.service.ts` (stream loop)
- Modify: `src/video/video-agent-execution.service.ts` (per-role budgets)
- Test: `test/unit/video/agent-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing tests for orchestration**

```ts
it('runs role sub-agents in the order chosen by the director', async () => {
  const result = await orchestrator.run({ brief, dispatch: ['screenwriter', 'shot-planner'] });
  expect(result.order).toEqual(['screenwriter', 'shot-planner']);
});

it('enforces the total agent deadline across dispatched roles', async () => {
  await expect(orchestrator.run({ brief, dispatch: ['screenwriter'], deadlineMs: 5 }))
    .rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- agent-orchestrator.service.spec.ts --runInBand`
Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement the orchestrator**

The Director agent runs with `runTotalAgent`-style budget. Add a `dispatch_role_agent({ role, task })` tool that invokes the role's `ToolLoopAgent` with its own scoped prompt/tools, and a `submit_creative_brief({ brief })` tool that produces the structured brief. Reuse `VideoAgentExecutionService` wrappers for per-role sub-budgets so aborts/timeouts still map to the existing typed errors. Ensure role sub-agent output is collected into a shared asset memory structure (the Asset Memory Bank analog) rather than free-form text.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test -- agent-orchestrator.service.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Run the full video test suite for regressions**

Run: `pnpm test -- video --runInBand`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/video/agent-orchestrator.service.ts src/video/video.service.ts src/video/video-agent-execution.service.ts test/unit/video/agent-orchestrator.service.spec.ts
git commit -m "feat(video): add director orchestrator that dispatches role agents"
```

---

## Task 6: Generalize `productProfile` → `creativeBrief`

**Files:**
- Modify: `src/video/entities/video-session.entity.ts`
- Modify: `src/video/video-tools.service.ts` (`update_product_profile` → `update_creative_brief`)
- Modify: `src/video/video.service.ts` (prompt section "商品画像" → "创作简报")
- Test: `test/unit/video/video-tools.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('accepts vertical-agnostic brief fields', async () => {
  const res = await tool.execute({ vertical: 'knowledge', topic: 'AI 科普', tone: '极简' });
  expect(res.profile).toMatchObject({ vertical: 'knowledge', topic: 'AI 科普' });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- video-tools.service.spec.ts --runInBand`
Expected: FAIL because the tool still only accepts e-commerce fields.

- [ ] **Step 3: Rename + generalize**

Rename the JSON column to `creativeBrief` (keep a read-through fallback for existing rows) and the tool to `update_creative_brief`, with fields `{ vertical, subject, key_points[], audience, duration, platform, tone, constraints[] }`. Update the prompt section header and keep `life-service` mapping documented in the life-service profile so existing sessions behave the same.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test -- video-tools.service.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/entities/video-session.entity.ts src/video/video-tools.service.ts src/video/video.service.ts
git commit -m "refactor(video): generalize product profile into vertical-agnostic creative brief"
```

---

## Task 7: Multi-schema storyboard parsing

**Files:**
- Modify: `src/video/storyboard-parser.service.ts`
- Test: `test/unit/video/storyboard-parser.service.spec.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('parses the life-service shot format', () => {
  const parsed = service.parse(LIFE_SERVICE_SAMPLE, { vertical: 'life-service' });
  expect(parsed.shots.length).toBeGreaterThan(0);
});

it('parses the narrative-shot format', () => {
  const parsed = service.parse(NARRATIVE_SAMPLE, { vertical: 'narrative' });
  expect(parsed.shots[0]).toHaveProperty('sceneHeading');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- storyboard-parser.service.spec.ts --runInBand`
Expected: FAIL because only one format is supported.

- [ ] **Step 3: Introduce a parser strategy registry**

Extract the current `### 镜头 N` logic into a `life-service` strategy; add a `narrative` strategy. Select the strategy by the active vertical/profile; keep the current default meta (`duration: 15, ratio: '9:16', platform: '抖音/小红书'`) as the life-service default only.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm test -- storyboard-parser.service.spec.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/video/storyboard-parser.service.ts test/unit/video/storyboard-parser.service.spec.ts
git commit -m "feat(video): support per-vertical storyboard parser strategies"
```

---

## Task 8: Dynamic process phases (frontend alignment)

**Files:**
- Modify: `src/video/types/process-state.ts`
- Modify: `agui-frontend/src/components/AgentMessage/process-types.ts`
- Modify: `agui-frontend/src/pages/VideoStoryboard/index.tsx`

- [ ] **Step 1: Write failing backend test**

```ts
it('emits phase descriptors supplied by the orchestrator', () => {
  const state = buildProcessState([{ id: 'dispatch-screenwriter', title: '编剧' }]);
  expect(state.phases[0].id).toBe('dispatch-screenwriter');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- process-state.spec.ts --runInBand`
Expected: FAIL because `ProcessPhase.id` is a fixed union.

- [ ] **Step 3: Relax the union to `string` and drive phases from orchestrator output**

Change `ProcessPhase.id` from the fixed 3-value union to `string`; the orchestrator emits one phase per dispatched role. Update the frontend types and the process panel to render whatever phases the backend sends (map the existing 3 phases to the life-service profile so current UX is unchanged).

- [ ] **Step 4: Verify frontend**

Run: `cd agui-frontend && pnpm build`
Expected: build succeeds; process panel renders life-service phases as before.

- [ ] **Step 5: Commit**

```bash
git add src/video/types/process-state.ts agui-frontend/src/components/AgentMessage/process-types.ts agui-frontend/src/pages/VideoStoryboard/index.tsx
git commit -m "feat(video): emit dynamic process phases for multi-agent roles"
```

---

## Cost & Risk Summary

| Workstream | Effort | Risk | Notes |
|---|---|---|---|
| Task 1 skill registry | Low | Low | Pure backend, behavior-preserving |
| Task 2 role registry | Low | Low | New file + provider registration |
| Task 3 profile-driven prompt | Medium | Medium | Prompt recomposition affects output quality — regression compare required |
| Task 4 role-scoped tools | Low-Medium | Medium | Tool assembly change; keep builders intact |
| Task 5 orchestrator | Medium-High | High | Streaming UX, deadline budget, abort propagation must be re-wired |
| Task 6 creative brief | Medium | Medium | Entity migration + frontend script card dependency |
| Task 7 parser strategies | Medium | Medium | Additive, low blast radius |
| Task 8 dynamic phases | Low-Medium | Low | Presentation layer, can ship last |

Minimum viable generic framework = Tasks 1–5. Tasks 6–8 complete multi-vertical support. Task 5 is the only high-risk item; it should land behind the existing typed-error contract so failures stay retryable/pre-mutation as today.

## Out of Scope (deferred)

- Breaking the `MAX_VIDEO_DURATION_SEC = 15` single-prompt Seedance limit (`src/video/video-task.service.ts:63`) and multi-shot stitching — highest effort/risk, separate project (see MovieAgent hierarchical planning).
- Pluggable video backends (Kling / Veo) — no work in this plan.
- Optional MAViS-style `reviewer` role (subtitle/safety/voice review) — profile slot is reserved in Task 2 but the reviewer agent itself is not implemented here.