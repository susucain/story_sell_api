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
import {
  AgentRoleRegistryService,
  RoleId,
} from '../../../src/video/agent-role.registry';
import { getVerticalProfile } from '../../../src/video/vertical-profile.registry';

describe('VideoService system prompt', () => {
  const registry = new AgentRoleRegistryService();

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
      {} as any,
      registry,
      undefined as never,
    );

    return { service };
  };

  const emptySession = {
    sessionId: 'session-1',
    userId: 1,
    status: 'active',
    creativeBrief: {},
  } as VideoSession;

  const build = (
    roleId: RoleId,
    verticalId = 'life-service',
    orchestrated = false,
  ) => {
    const { service } = createService();
    return (service as any).buildSystemPrompt(
      emptySession,
      null,
      null,
      [],
      registry.getRoleProfile(roleId),
      getVerticalProfile(verticalId),
      orchestrated,
    ) as Promise<string>;
  };

  it('routes creation guidance without injecting the full skill', async () => {
    const prompt = await build('director');

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
    const prompt = await build('director');

    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(8000);
  });

  it('renders the active role identity instead of a hardcoded workbench name', async () => {
    const prompt = await build('screenwriter');

    expect(prompt).not.toContain('映语 AI 达人带货视频工作台');
    expect(prompt).toContain(registry.getRoleProfile('screenwriter').identity);
  });

  it('routes guides from the active vertical profile', async () => {
    const prompt = await build('director', 'life-service');

    expect(prompt).toContain(
      'life-service-storyboard-generator/references/routing.md',
    );
    expect(prompt).toContain('## 指南路由');
    expect(prompt).toContain('## 持久化约束');
  });

  it('adds the multi-agent pipeline section in orchestrated mode', async () => {
    const prompt = await build('director', 'life-service', true);

    expect(prompt).toContain('## 多 Agent 编排');
    expect(prompt).toContain('dispatch_role_agent');
    expect(prompt).toContain('screenwriter');
    expect(prompt).toContain('shot-planner');
    expect(prompt).toContain('cinematographer');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(8000);
  });

  it('omits the orchestration section outside orchestrated mode', async () => {
    const prompt = await build('director');

    expect(prompt).not.toContain('## 多 Agent 编排');
    expect(prompt).not.toContain('dispatch_role_agent');
  });

  it('does not push the pipeline onto advisor roles', async () => {
    const prompt = await build('screenwriter', 'life-service', true);

    expect(prompt).not.toContain('## 多 Agent 编排');
  });

  it('omits the new-script duration hint when editing an existing video', async () => {
    const { service } = createService();
    const sourceVideoAsset = {
      id: 9,
      parsedContent: { durationSec: 12 },
    } as any;

    const prompt = (await (service as any).buildSystemPrompt(
      emptySession,
      null,
      sourceVideoAsset,
      [],
      registry.getRoleProfile('director'),
      getVerticalProfile('life-service'),
    )) as string;

    expect(prompt).not.toContain('generate_script 的 meta 建议填写 duration');
    expect(prompt).toContain('编辑模式锁定');
  });
});
