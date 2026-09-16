# Video Agent Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-asset video-agent requests faster and bounded by configurable, observable timeout behavior.

**Architecture:** Keep one ToolLoopAgent for storyboard orchestration. Analyze newly supplied assets before creating that agent through a concurrency-limited visual-analysis service, then provide the persisted summaries to the main agent. A shared execution helper owns deadline handling, abort propagation, timeout codes, and structured logs. The system prompt becomes a concise router that points the agent to focused skill references.

**Tech Stack:** NestJS, TypeORM, Vercel AI SDK, Zod, Jest, Nginx.

---

## File Structure

- Create: `src/video/video-agent-execution.service.ts` - Configurable deadline wrapper, abort-signal composition, typed timeout errors, and redacted phase logs.
- Create: `src/video/video-asset-analysis.service.ts` - Bounded-concurrency visual analysis for pending images and videos.
- Create: `test/unit/video/video-agent-execution.service.spec.ts` - Deadline, cancellation, and logging tests.
- Create: `test/unit/video/video-asset-analysis.service.spec.ts` - Concurrency, partial failure, and persistence tests.
- Modify: `src/video/video.service.ts` - Run asset analysis before the main agent, use timeout-aware model and tool execution, and build the compact prompt.
- Modify: `src/video/video-tools.service.ts` - Apply per-tool deadlines and remove model-directed sequential asset parsing.
- Modify: `src/video/video.module.ts` - Register the two new services.
- Modify: `src/video/video-llm.service.ts` - Expose the model instance used by both asset analysis and the main agent.
- Modify: `src/video/process-tracker.ts` - Represent parsed and failed parallel asset analyses.
- Modify: `src/video/skill-loader.service.ts` - Load named reference files and the compact routing prompt.
- Modify: `src/video/skills/life-service-storyboard-generator/SKILL.md` - Retain metadata only and link to the focused references.
- Create: `src/video/skills/life-service-storyboard-generator/routing.md`
- Create: `src/video/skills/life-service-storyboard-generator/character.md`
- Create: `src/video/skills/life-service-storyboard-generator/storyboard.md`
- Create: `src/video/skills/life-service-storyboard-generator/seedance.md`
- Modify: `src/video/video.controller.ts` - Map typed agent failures to a structured retryable stream error.
- Modify: `src/main.ts` - Emit request IDs and make them available to the video request context.
- Modify: `env.prod.example` - Document all timeout and analysis concurrency variables.
- Modify: `agui-frontend/nginx.conf` - Raise `/ai` and `/video` proxy read timeouts to 330 seconds.
- Modify: `agui-frontend/src/pages/VideoStoryboard/index.tsx` - Render retryable timeout errors as a retry action.

### Task 1: Deadline and Observability Foundation

**Files:**
- Create: `src/video/video-agent-execution.service.ts`
- Create: `test/unit/video/video-agent-execution.service.spec.ts`
- Modify: `src/video/video.module.ts`
- Modify: `env.prod.example`

- [ ] **Step 1: Write failing unit tests for deadline behavior and redacted logs**

```ts
it('aborts work and returns MODEL_TIMEOUT when a phase exceeds its deadline', async () => {
  const service = createService({ VIDEO_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS: '5' });
  const work = jest.fn(({ signal }: { signal: AbortSignal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  );

  await expect(service.runModelPhase({ requestId: 'r1', sessionId: 's1' }, work))
    .rejects.toMatchObject({ code: 'MODEL_TIMEOUT', retryable: true });
  expect(work).toHaveBeenCalledTimes(1);
});

it('logs duration and identifiers without prompt or URL fields', async () => {
  const logger = { log: jest.fn() };
  const service = createService({}, logger);

  await service.runToolPhase(
    { requestId: 'r1', sessionId: 's1', toolName: 'get_script' },
    async () => ({ scriptId: 8 }),
  );

  expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('"toolName":"get_script"'));
  expect(logger.log.mock.calls.flat().join('')).not.toContain('https://');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- video-agent-execution.service.spec.ts --runInBand`

Expected: FAIL because `VideoAgentExecutionService` does not exist.

- [ ] **Step 3: Implement typed failures and the execution wrapper**

```ts
export type VideoAgentTimeoutCode =
  | 'MODEL_TIMEOUT'
  | 'TOOL_TIMEOUT'
  | 'ASSET_PARSE_TIMEOUT'
  | 'AGENT_TOTAL_TIMEOUT';

export class VideoAgentTimeoutError extends Error {
  readonly retryable = true;
  constructor(
    readonly code: VideoAgentTimeoutCode,
    readonly phase: string,
    readonly durationMs: number,
  ) {
    super(`${phase} timed out after ${durationMs}ms`);
  }
}

async run<T>(
  context: PhaseContext,
  timeoutMs: number,
  timeoutCode: VideoAgentTimeoutCode,
  work: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new VideoAgentTimeoutError(timeoutCode, context.phase, timeoutMs)),
    timeoutMs,
  );
  const startedAt = Date.now();
  try {
    return await work(AbortSignal.any([controller.signal, parentSignal].filter(Boolean) as AbortSignal[]));
  } finally {
    clearTimeout(timer);
    this.logOutcome(context, Date.now() - startedAt);
  }
}
```

Read configuration with validated positive integers and these defaults: model first event `90000`, asset parse `90000`, normal tool `30000`, script save `45000`, total request `300000`, analysis concurrency `3`. Log JSON with only `requestId`, `sessionId`, `phase`, `toolName`, `assetId`, `durationMs`, `outcome`, and `errorCode`.

- [ ] **Step 4: Register the service and document configuration**

Add `VideoAgentExecutionService` to `VideoModule.providers`. Add these non-secret names and defaults to `env.prod.example`:

```dotenv
VIDEO_AGENT_MODEL_FIRST_EVENT_TIMEOUT_MS=90000
VIDEO_AGENT_ASSET_PARSE_TIMEOUT_MS=90000
VIDEO_AGENT_TOOL_TIMEOUT_MS=30000
VIDEO_AGENT_SCRIPT_SAVE_TIMEOUT_MS=45000
VIDEO_AGENT_TOTAL_TIMEOUT_MS=300000
VIDEO_AGENT_ASSET_ANALYSIS_CONCURRENCY=3
```

- [ ] **Step 5: Run focused tests and type check**

Run: `pnpm test -- video-agent-execution.service.spec.ts --runInBand && pnpm build`

Expected: PASS and a successful Nest build.

- [ ] **Step 6: Commit**

```bash
git add src/video/video-agent-execution.service.ts src/video/video.module.ts \
  test/unit/video/video-agent-execution.service.spec.ts env.prod.example
git commit -m "feat: add video agent deadline handling"
```

### Task 2: Bounded-Concurrency Asset Analysis

**Files:**
- Create: `src/video/video-asset-analysis.service.ts`
- Create: `test/unit/video/video-asset-analysis.service.spec.ts`
- Modify: `src/video/video-llm.service.ts`
- Modify: `src/video/video.service.ts`
- Modify: `src/video/process-tracker.ts`
- Modify: `src/video/video.module.ts`

- [ ] **Step 1: Write failing tests for three-at-a-time analysis and partial failure**

```ts
it('analyzes pending assets with a maximum of three concurrent model calls', async () => {
  const model = createDeferredVisualModel();
  const service = createAnalysisService({ model, concurrency: 3 });
  const assets = Array.from({ length: 5 }, (_, index) => asset(index + 1));

  const pending = service.analyzePendingAssets(assets, context('r1', 's1'));
  expect(model.calls).toHaveLength(3);
  model.resolveAll({ summary: 'product image' });
  await pending;
  expect(model.maximumInFlight).toBe(3);
});

it('persists a timeout as failed while preserving successful siblings', async () => {
  const result = await service.analyzePendingAssets([asset(1), asset(2)], context('r1', 's1'));

  expect(result).toEqual(expect.arrayContaining([
    expect.objectContaining({ assetId: 1, status: 'parsed' }),
    expect.objectContaining({ assetId: 2, status: 'failed', errorCode: 'ASSET_PARSE_TIMEOUT' }),
  ]));
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- video-asset-analysis.service.spec.ts --runInBand`

Expected: FAIL because `VideoAssetAnalysisService` does not exist.

- [ ] **Step 3: Implement a single-asset visual prompt and bounded worker pool**

Expose `createModel()` from `VideoLLMService`; it must return the existing OpenAI-compatible model with `enable_thinking: false`. Implement `analyzePendingAssets` to:

1. Select only `assetPurpose in ('all', 'analysis')` and `status !== 'parsed'`.
2. Schedule at most `VIDEO_AGENT_ASSET_ANALYSIS_CONCURRENCY` workers.
3. For each image or video URL, invoke the visual model with a compact analysis instruction requesting JSON `{ summary, contentCategory }`.
4. Use `VideoAgentExecutionService.run` with `ASSET_PARSE_TIMEOUT`.
5. Persist successful summaries as `status: 'parsed'`; persist failures as `status: 'failed'` with a non-sensitive error code in `parsedContent`.
6. Return `Promise.allSettled`-style results without throwing for an individual asset failure.

- [ ] **Step 4: Integrate analysis before the main ToolLoopAgent**

In `VideoService.streamChat`, create and start `ProcessTracker` before analysis. After file assets are persisted and before `buildSystemPrompt`, call:

```ts
const analysisResults = await this.assetAnalysisService.analyzePendingAssets(
  analysisAssets,
  requestContext,
  tracker,
  totalRequestSignal,
);
```

Refresh assets after analysis before building the system prompt. Remove `parse_asset` from the main agent's tool set and from `ProcessTracker` tool-chunk handling; the primary agent now receives persisted summaries rather than serially generating them itself.

- [ ] **Step 5: Extend the process tracker for failed assets**

Add `markAssetFailed(assetId, errorCode)` to set the item state to failed, display a generic retryable failure description, and complete the material phase once every item is either completed or failed. Do not expose URLs, provider text, or raw exceptions in the stream.

- [ ] **Step 6: Run video unit tests and build**

Run: `pnpm test -- video-asset-analysis.service.spec.ts video.service.spec.ts --runInBand && pnpm build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/video/video-asset-analysis.service.ts src/video/video-llm.service.ts \
  src/video/video.service.ts src/video/process-tracker.ts src/video/video.module.ts \
  test/unit/video/video-asset-analysis.service.spec.ts
git commit -m "feat: parallelize video asset analysis"
```

### Task 3: Compact Prompt and On-Demand References

**Files:**
- Modify: `src/video/skill-loader.service.ts`
- Modify: `src/video/video.service.ts`
- Modify: `src/video/video-tools.service.ts`
- Modify: `src/video/skills/life-service-storyboard-generator/SKILL.md`
- Create: `src/video/skills/life-service-storyboard-generator/routing.md`
- Create: `src/video/skills/life-service-storyboard-generator/character.md`
- Create: `src/video/skills/life-service-storyboard-generator/storyboard.md`
- Create: `src/video/skills/life-service-storyboard-generator/seedance.md`
- Modify: `test/unit/video/skill-loader.service.spec.ts`
- Create: `test/unit/video/video-system-prompt.spec.ts`

- [ ] **Step 1: Write failing prompt and skill-loading tests**

```ts
it('loads only the routing prompt as fixed system context', async () => {
  const prompt = await service.buildSystemPrompt(session, null, null);

  expect(prompt).toContain('routing.md');
  expect(prompt).not.toContain('完整视频编辑模式');
  expect(prompt).not.toContain('### 镜头 1：福利钩子');
});

it('maps named references to files within the skills root', async () => {
  await expect(loader.loadReference('storyboard')).resolves.toContain('分镜');
  await expect(loader.loadReference('../secret' as never)).rejects.toThrow('未知 video reference');
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `pnpm test -- skill-loader.service.spec.ts video-system-prompt.spec.ts --runInBand`

Expected: FAIL because `loadReference` and the compact prompt do not exist.

- [ ] **Step 3: Split the current Skill**

Move the current detailed requirements into the four files:

- `routing.md`: creation, modification, query, and confirmation routing plus required tool order.
- `character.md`: avatar, outfit, inheritance, conflict, and portrait rules.
- `storyboard.md`: storyboard format, shot duration, and creation constraints.
- `seedance.md`: Seedance validation, asset references, no-text priority, and save requirements.

Leave `SKILL.md` with frontmatter and a concise directory index. Preserve all existing business rules exactly once; remove duplicate rules while moving them.

- [ ] **Step 4: Implement named reference loading and compact prompt construction**

Add a closed `VIDEO_REFERENCES` map in `SkillLoaderService`. `loadReference(name)` must accept only `routing`, `character`, `storyboard`, and `seedance`. Update `buildSystemPrompt` to include the session summary, material summaries, persistence invariants, and this routing index:

```text
For a creation or storyboard change, read routing.md, storyboard.md, and seedance.md.
Read character.md only when a person, avatar, portrait, or outfit is requested.
For status queries and standalone material analysis, do not read creation references.
```

Update the `read_file` tool description with the four allowed reference paths. Keep specialist reference files available, but do not embed them in the base prompt.

- [ ] **Step 5: Run focused tests and inspect prompt size**

Run: `pnpm test -- skill-loader.service.spec.ts video-system-prompt.spec.ts --runInBand && pnpm build`

Expected: PASS. Add an assertion that the fixed prompt is below `8_000` UTF-8 bytes for an empty session.

- [ ] **Step 6: Commit**

```bash
git add src/video/skill-loader.service.ts src/video/video.service.ts src/video/video-tools.service.ts \
  src/video/skills/life-service-storyboard-generator \
  test/unit/video/skill-loader.service.spec.ts test/unit/video/video-system-prompt.spec.ts
git commit -m "feat: load video creation guidance on demand"
```

### Task 4: Agent Integration, Client Errors, and Proxy Deadline

**Files:**
- Modify: `src/video/video.service.ts`
- Modify: `src/video/video-tools.service.ts`
- Modify: `src/video/video.controller.ts`
- Modify: `src/main.ts`
- Modify: `agui-frontend/nginx.conf`
- Modify: `agui-frontend/src/pages/VideoStoryboard/index.tsx`
- Create: `test/unit/video/video-agent-error.spec.ts`

- [ ] **Step 1: Write failing tests for tool deadlines and retryable stream errors**

```ts
it('uses the script-save deadline for generate_script', async () => {
  await expect(runGenerateScriptWithSlowRepository()).rejects.toMatchObject({
    code: 'TOOL_TIMEOUT',
    retryable: true,
  });
});

it('serializes a typed timeout without raw provider details', () => {
  const response = toVideoAgentError(new VideoAgentTimeoutError('AGENT_TOTAL_TIMEOUT', 'agent', 300000));

  expect(response).toEqual({
    code: 'AGENT_TOTAL_TIMEOUT',
    retryable: true,
    message: '创作请求超时，请重试',
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm test -- video-agent-error.spec.ts --runInBand`

Expected: FAIL because timeout errors are not mapped at the controller boundary.

- [ ] **Step 3: Propagate total, model, and tool cancellation**

Create one request-level `AbortController` in `VideoService.streamChat`, with the 300-second deadline. Pass its signal to asset analysis, `agent.stream`, and every tool execution. Wrap:

- Main model first-event wait with `MODEL_TIMEOUT`.
- `generate_script` persistence with the 45-second script-save deadline.
- All other tools with the 30-second tool deadline.
- The outer request with `AGENT_TOTAL_TIMEOUT`.

When cancellation occurs, stop writing chunks, call `tracker.error()` with a generic retryable message, and do not call `saveAssistantUIMessage`.

- [ ] **Step 4: Add request correlation and safe client error presentation**

In `main.ts`, attach a UUID request ID to each request and response header. Carry it into the video service context and logs. In the controller, translate `VideoAgentTimeoutError` to the structured code and generic Chinese message before writing the stream error. In `VideoStoryboard/index.tsx`, map retryable timeout codes to a visible retry button that resubmits the unchanged latest user input; keep the generic close action for other errors.

- [ ] **Step 5: Update Nginx timeout**

Change both proxy locations in `agui-frontend/nginx.conf`:

```nginx
location /ai {
    proxy_read_timeout 330s;
}

location /video {
    proxy_read_timeout 330s;
}
```

Deploy the generated Nginx configuration through the existing frontend deployment process, then validate it with `nginx -t` and reload Nginx on the ECS host.

- [ ] **Step 6: Run all affected tests, lint, and build**

Run:

```bash
pnpm test -- video-agent-execution.service.spec.ts video-asset-analysis.service.spec.ts \
  video-agent-error.spec.ts video-system-prompt.spec.ts video.service.spec.ts \
  skill-loader.service.spec.ts --runInBand
pnpm build
pnpm --dir ../agui-frontend build
```

Expected: all tests pass and both applications build successfully.

- [ ] **Step 7: Verify production behavior after deployment**

1. Send a five-image storyboard request.
2. Confirm three asset-analysis phase logs start before any finishes.
3. Confirm every log shares the request ID and excludes prompt text and URLs.
4. Confirm a controlled timeout returns the retryable message before 330 seconds.
5. Confirm a normal storyboard request persists an assistant message and script.

- [ ] **Step 8: Commit**

```bash
git add src/video/video.service.ts src/video/video-tools.service.ts src/video/video.controller.ts \
  src/main.ts agui-frontend/nginx.conf agui-frontend/src/pages/VideoStoryboard/index.tsx \
  test/unit/video/video-agent-error.spec.ts
git commit -m "feat: bound and observe video agent execution"
```

## Plan Self-Review

- Scope coverage: Task 1 supplies configured timeouts, cancellation primitives, and redacted logs. Task 2 provides real parallel visual analysis. Task 3 removes fixed prompt bloat and retains on-demand constraints. Task 4 propagates failures to the client and aligns the proxy deadline.
- Type consistency: all timeout paths use `VideoAgentTimeoutError` and the same four public codes. Asset results use existing `VideoAsset.status` values `parsed` and `failed`.
- Deployment boundary: backend code and frontend Nginx configuration deploy independently through their existing pipelines; production verification occurs only after both are deployed.
