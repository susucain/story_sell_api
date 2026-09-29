jest.mock('ai', () => ({
  tool: (definition: unknown) => definition,
  zodSchema: (schema: unknown) => schema,
}));

import { VideoToolsService } from '../../../src/video/video-tools.service';
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
      new VideoAgentExecutionService({ get: () => undefined } as never),
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

    expect(tools).toHaveProperty('generate_script');
    expect(tools).not.toHaveProperty('create_video_task');
  });

  it('exposes exactly the whitelisted tools for a role', () => {
    const role = ROLE_PROFILES.cinematographer;

    const tools = createService().buildTools(ctx, role);

    expect(Object.keys(tools).sort()).toEqual([...role.allowedTools].sort());
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
      new VideoAgentExecutionService({ get: () => undefined } as never),
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