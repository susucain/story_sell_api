jest.mock('ai', () => ({
  tool: (definition: unknown) => definition,
  zodSchema: (schema: unknown) => schema,
}));

import { VideoToolsService } from '../../../src/video/video-tools.service';
import { SeedancePromptValidatorService } from '../../../src/video/seedance-prompt-validator.service';
import { ROLE_PROFILES } from '../../../src/video/agent-role.registry';
import { VideoAgentExecutionService } from '../../../src/video/video-agent-execution.service';

describe('VideoToolsService role scoping', () => {
  const createService = (
    overrides: { sessionRepo?: unknown } = {},
  ): VideoToolsService =>
    new VideoToolsService(
      undefined as never,
      undefined as never,
      (overrides.sessionRepo ?? undefined) as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      new VideoAgentExecutionService({ get: () => undefined } as never),
      undefined as never,
    );

  const ctx = { sessionId: 'session-1', userId: 1 };

  it('returns the full tool set when no role is provided', () => {
    const tools = createService().buildTools(ctx);

    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        'start_script_creation',
        'generate_script',
        'create_video_task',
        'get_session_state',
      ]),
    );
  });

  it('only exposes tools allowed by the active role profile', () => {
    const tools = createService().buildTools(ctx, ROLE_PROFILES.screenwriter);

    expect(tools).toHaveProperty('read_file');
    expect(tools).not.toHaveProperty('generate_script');
    expect(tools).not.toHaveProperty('create_video_task');
  });

  it('blocks generate_script until a role has been dispatched in orchestrated mode', async () => {
    const tools = createService().buildTools({
      ...ctx,
      requireDispatch: true,
      dispatchedRoles: [],
    });

    const result = await (
      tools as Record<string, { execute: Function }>
    ).generate_script.execute(
      { title: 't', storyboard_markdown: '', seedance_prompt: '', meta: {} },
      {},
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('dispatch_role_agent');
  });

  it('blocks generate_script until the sd2-pe rules have been read', async () => {
    const tools = createService().buildTools({
      ...ctx,
      readFiles: new Set<string>(),
    });

    const result = await (
      tools as Record<string, { execute: Function }>
    ).generate_script.execute(
      { title: 't', storyboard_markdown: '', seedance_prompt: '', meta: {} },
      {},
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('sd2-pe/SKILL.md');
  });

  it('records read skill files so the sd2-pe review can be verified', async () => {
    const readFiles = new Set<string>();
    const tools = createService().buildTools({ ...ctx, readFiles });

    await (tools as Record<string, { execute: Function }>).read_file.execute(
      { path: 'sd2-pe/SKILL.md' },
      {},
    );

    expect([...readFiles]).toContain('sd2-pe/skill.md');
  });

  it('exposes exactly the whitelisted tools for a role', () => {
    const role = ROLE_PROFILES.cinematographer;

    const tools = createService().buildTools(ctx, role);

    expect(Object.keys(tools).sort()).toEqual([...role.allowedTools].sort());
  });
});

describe('VideoToolsService continuation validation', () => {
  const createService = (): VideoToolsService =>
    new VideoToolsService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      new VideoAgentExecutionService({ get: () => undefined } as never),
      undefined as never,
    );

  const continuationCtx = {
    sessionId: 'session-1',
    userId: 1,
    readFiles: new Set<string>(['sd2-pe/skill.md']),
    continuation: {
      sourceAssetId: 20,
      sourceDurationSec: 12,
      continuityMode: 'extend' as const,
    },
  };

  const runGenerateScript = (
    context: Record<string, unknown>,
    meta: Record<string, unknown>,
  ) =>
    (
      createService().buildTools(context) as Record<
        string,
        { execute: Function }
      >
    ).generate_script.execute(
      { title: 't', storyboard_markdown: '', seedance_prompt: '', meta },
      {},
    );

  it('requires meta.continuation when the request is a continuation', async () => {
    const result = await runGenerateScript(continuationCtx, {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('必须填写 meta.continuation');
  });

  it('rejects a continuation whose source or continuity mode differs', async () => {
    const result = await runGenerateScript(continuationCtx, {
      continuation: {
        mode: 'continuation',
        sourceAssetId: 20,
        sourceDurationSec: 12,
        continuityMode: 'frame_bridge',
      },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain(
      '必须使用当前引用的原视频与用户指定的衔接方式',
    );
  });

  it('rejects meta.edit inside a continuation request', async () => {
    const result = await runGenerateScript(continuationCtx, {
      continuation: {
        mode: 'continuation',
        sourceAssetId: 20,
        sourceDurationSec: 12,
        continuityMode: 'extend',
      },
      edit: {
        mode: 'full_video_edit',
        sourceAssetId: 20,
        sourceDurationSec: 12,
        targetStartSec: 1,
        targetEndSec: 3,
        preserveAudio: true,
      },
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('不得创建视频编辑任务');
  });

  it('rejects meta.continuation outside a continuation request', async () => {
    const result = await runGenerateScript(
      {
        sessionId: 'session-1',
        userId: 1,
        readFiles: new Set<string>(['sd2-pe/skill.md']),
      },
      {
        continuation: {
          mode: 'continuation',
          sourceAssetId: 20,
          sourceDurationSec: 12,
          continuityMode: 'extend',
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain(
      '只有基于原视频续写时才能创建 meta.continuation',
    );
  });
});

describe('VideoToolsService 参考素材上限', () => {
  const createService = (assets: unknown[]): VideoToolsService =>
    new VideoToolsService(
      { find: jest.fn().mockResolvedValue(assets) } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      new SeedancePromptValidatorService(),
      new VideoAgentExecutionService({ get: () => undefined } as never),
      undefined as never,
    );

  const ctx = {
    sessionId: 'session-1',
    userId: 1,
    readFiles: new Set<string>(['sd2-pe/skill.md']),
  };

  interface GenerateScriptResult {
    success: boolean;
    message: string;
  }

  const runGenerateScript = (
    assets: unknown[],
    meta: Record<string, unknown>,
  ): Promise<GenerateScriptResult> => {
    const tools = createService(assets).buildTools(ctx) as unknown as {
      generate_script: {
        execute: (
          input: Record<string, unknown>,
          options: Record<string, unknown>,
        ) => Promise<GenerateScriptResult>;
      };
    };
    return tools.generate_script.execute(
      { title: 't', storyboard_markdown: '', seedance_prompt: '', meta },
      {},
    );
  };

  const noCharacter = {
    character: { mode: 'none', selectionSource: 'auto_selected' },
  };

  it('参考素材本身超上限时中断，并要求模型告知用户移除素材', async () => {
    const result = await runGenerateScript(
      Array.from({ length: 10 }, (_, index) => ({
        assetType: 'image',
        url: `https://example.test/image-${index + 1}.png`,
      })),
      noCharacter,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('请先移除多余素材后再重新生成');
  });
});

describe('VideoToolsService creative brief tool', () => {
  const createService = (sessionRepo: unknown): VideoToolsService =>
    new VideoToolsService(
      undefined as never,
      undefined as never,
      sessionRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      new VideoAgentExecutionService({ get: () => undefined } as never),
      undefined as never,
    );

  it('exposes update_creative_brief instead of the e-commerce profile tool', () => {
    const tools = createService(undefined).buildTools({
      sessionId: 'session-1',
      userId: 1,
    });

    expect(tools).toHaveProperty('update_creative_brief');
    expect(tools).not.toHaveProperty('update_product_profile');
  });

  it('accepts vertical-agnostic brief fields', async () => {
    const sessionRepo = {
      findOne: jest.fn().mockResolvedValue({ creativeBrief: {} }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const tools = createService(sessionRepo).buildTools({
      sessionId: 'session-1',
      userId: 1,
    });

    const result = await (
      tools as Record<string, { execute: Function }>
    ).update_creative_brief.execute(
      { vertical: 'knowledge', subject: 'AI 科普', tone: '极简' },
      {},
    );

    expect(result.profile).toMatchObject({
      vertical: 'knowledge',
      subject: 'AI 科普',
    });
    expect(sessionRepo.update).toHaveBeenCalledWith(
      { sessionId: 'session-1' },
      {
        creativeBrief: {
          vertical: 'knowledge',
          subject: 'AI 科普',
          tone: '极简',
        },
      },
    );
  });
});
