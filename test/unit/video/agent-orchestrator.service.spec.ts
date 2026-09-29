jest.mock('ai', () => ({
  ToolLoopAgent: jest.fn(),
  tool: (definition: unknown) => definition,
  zodSchema: (schema: unknown) => schema,
  isStepCount: jest.fn(),
}));

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(),
}));

import { ToolLoopAgent } from 'ai';
import { ConfigService } from '@nestjs/config';
import { AgentOrchestratorService } from '../../../src/video/agent-orchestrator.service';
import { AgentRoleRegistryService } from '../../../src/video/agent-role.registry';
import { VideoAgentExecutionService } from '../../../src/video/video-agent-execution.service';
import { VideoLLMService } from '../../../src/video/video-llm.service';
import { VideoToolsService } from '../../../src/video/video-tools.service';

const toolLoopAgentMock = ToolLoopAgent as unknown as jest.Mock;

describe('AgentOrchestratorService', () => {
  const buildOrchestrator = () => {
    const configService = { get: () => undefined } as unknown as ConfigService;
    return new AgentOrchestratorService(
      new AgentRoleRegistryService(),
      { getLanguageModel: () => ({}) } as unknown as VideoLLMService,
      { buildTools: () => ({}) } as unknown as VideoToolsService,
      new VideoAgentExecutionService(configService),
    );
  };

  const brief = { vertical: 'life-service', goal: '生成团购探店视频' };

  afterEach(() => {
    toolLoopAgentMock.mockReset();
  });

  it('runs role sub-agents in the order chosen by the director', async () => {
    toolLoopAgentMock.mockImplementation(() => ({
      generate: jest.fn().mockResolvedValue({ text: '角色产出' }),
    }));

    const result = await buildOrchestrator().run({
      brief,
      dispatch: ['screenwriter', 'shot-planner'],
    });

    expect(result.order).toEqual(['screenwriter', 'shot-planner']);
    expect(result.outputs.map((output) => output.role)).toEqual([
      'screenwriter',
      'shot-planner',
    ]);
  });

  it('enforces the total agent deadline across dispatched roles', async () => {
    toolLoopAgentMock.mockImplementation(() => ({
      generate: jest.fn().mockImplementation(() => new Promise(() => {})),
    }));

    await expect(
      buildOrchestrator().run({
        brief,
        dispatch: ['screenwriter'],
        deadlineMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
  });

  it('exposes the creative brief and dispatch tools for the director', () => {
    const tools = buildOrchestrator().buildDispatchTools({
      sessionId: 'session-1',
      userId: 1,
    });

    expect(Object.keys(tools).sort()).toEqual([
      'dispatch_role_agent',
      'submit_creative_brief',
    ]);
  });
});