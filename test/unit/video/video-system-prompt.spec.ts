jest.mock('ai', () => ({
  ToolLoopAgent: class {},
  createUIMessageStream: jest.fn(),
  convertToModelMessages: jest.fn(),
  getToolName: jest.fn(),
  isStepCount: jest.fn(),
  isToolUIPart: jest.fn(),
}));

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(),
}));

import { VideoService } from '../../../src/video/video.service';
import { VideoSession } from '../../../src/video/entities/video-session.entity';

describe('VideoService system prompt', () => {
  const createService = () => {
    const repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const service = new VideoService(
      repo as any,
      repo as any,
      repo as any,
      repo as any,
      repo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    return { service };
  };

  const emptySession = {
    sessionId: 'session-1',
    userId: 1,
    status: 'active',
    productProfile: {},
  } as VideoSession;

  it('routes creation guidance without injecting the full skill', async () => {
    const { service } = createService();

    const prompt = await (service as any).buildSystemPrompt(emptySession, null, null, []);

    expect(prompt).toContain('references/routing.md');
    expect(prompt).toContain('references/storyboard.md');
    expect(prompt).toContain('references/seedance.md');
    expect(prompt).toContain('references/character.md');
    expect(prompt).toContain('references/type-configuration-center.md');
    expect(prompt).toContain('references/seedance_2_0_template.md');
    expect(prompt).toContain('sd2-pe/SKILL.md');
    expect(prompt).not.toContain('只可使用以上四个参考文件');
    expect(prompt).not.toContain('# 生活服务视频分镜生成器');
    expect(prompt).not.toContain('### 镜头 1：福利钩子');
  });

  it('keeps the fixed empty-session prompt below 8000 UTF-8 bytes', async () => {
    const { service } = createService();

    const prompt = await (service as any).buildSystemPrompt(emptySession, null, null, []);

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(8000);
  });
});
