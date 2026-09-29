jest.mock('ai', () => ({
  convertToModelMessages: jest.fn(),
  createUIMessageStream: jest.fn(),
  getToolName: jest.fn(),
  isStepCount: jest.fn(),
  isToolUIPart: jest.fn(),
  ToolLoopAgent: jest.fn(),
}));
jest.mock('../../../src/video/video-llm.service', () => ({
  VideoLLMService: class {},
}));
jest.mock('../../../src/video/skill-loader.service', () => ({
  SkillLoaderService: class {},
}));
jest.mock('../../../src/video/storyboard-parser.service', () => ({
  StoryboardParserService: class {},
}));
jest.mock('../../../src/video/video-tools.service', () => ({
  VideoToolsService: class {},
}));
jest.mock('../../../src/video/video-task.service', () => ({
  VideoTaskService: class {},
}));

import { Brackets } from 'typeorm';
import { VideoService } from '../../../src/video/video.service';

describe('VideoService session search', () => {
  const items = [{ id: 1, sessionId: 'session-1' }];
  let query: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let searchBrackets: Brackets | undefined;
  let service: VideoService;

  beforeEach(() => {
    searchBrackets = undefined;
    query = {
      where: jest.fn(),
      andWhere: jest.fn((condition: unknown) => {
        if (condition instanceof Brackets) searchBrackets = condition;
        return query;
      }),
      orderBy: jest.fn(),
      addOrderBy: jest.fn(),
      skip: jest.fn(),
      take: jest.fn(),
      getManyAndCount: jest.fn().mockResolvedValue([items, 1]),
    };
    Object.values(query).forEach((method) => {
      if (method !== query.getManyAndCount && method !== query.andWhere) {
        method.mockReturnValue(query);
      }
    });

    const sessionRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(query),
    };
    service = new VideoService(
      sessionRepo as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  });

  it('returns the normal paginated list when keyword is empty', async () => {
    const result = await service.findSessionsByUserId(7, {
      page: 2,
      pageSize: 20,
      keyword: '  ',
    });

    expect(query.where).toHaveBeenCalledWith(
      'video_session.user_id = :userId',
      {
        userId: 7,
      },
    );
    expect(query.andWhere).not.toHaveBeenCalled();
    expect(query.orderBy).toHaveBeenCalledWith(
      'video_session.updated_at',
      'DESC',
    );
    expect(query.addOrderBy).toHaveBeenCalledWith('video_session.id', 'DESC');
    expect(query.skip).toHaveBeenCalledWith(20);
    expect(query.take).toHaveBeenCalledWith(20);
    expect(result).toEqual({
      items,
      total: 1,
      page: 2,
      pageSize: 20,
      hasMore: false,
    });
  });

  it('searches topic and product name with the normalized keyword', async () => {
    await service.findSessionsByUserId(7, { keyword: '  烤鸭  ' });

    const search = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    };
    if (!searchBrackets) throw new Error('Expected search brackets');
    searchBrackets.whereFactory(search as never);

    expect(search.where).toHaveBeenCalledWith(
      "INSTR(LOWER(COALESCE(video_session.topic, '')), LOWER(:keyword)) > 0",
      { keyword: '烤鸭' },
    );
    expect(search.orWhere).toHaveBeenCalledWith(
      "INSTR(LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(video_session.product_profile, '$.product_name')), '')), LOWER(:keyword)) > 0",
      { keyword: '烤鸭' },
    );
  });
});
