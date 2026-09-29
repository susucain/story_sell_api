jest.mock('ai', () => ({
  tool: (definition: unknown) => definition,
  zodSchema: (schema: unknown) => schema,
}));

import { VideoToolsService } from '../../../src/video/video-tools.service';
import { ROLE_PROFILES } from '../../../src/video/agent-role.registry';

describe('VideoToolsService role scoping', () => {
  const createService = () =>
    new VideoToolsService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
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

    expect(tools).toHaveProperty('generate_script');
    expect(tools).not.toHaveProperty('create_video_task');
  });

  it('exposes exactly the whitelisted tools for a role', () => {
    const role = ROLE_PROFILES.cinematographer;

    const tools = createService().buildTools(ctx, role);

    expect(Object.keys(tools).sort()).toEqual([...role.allowedTools].sort());
  });
});