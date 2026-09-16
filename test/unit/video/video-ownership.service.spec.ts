import { NotFoundException } from '@nestjs/common';
jest.mock('ai', () => ({}));
jest.mock('../../../src/video/video-llm.service', () => ({ VideoLLMService: class {} }));
import { VideoService } from '../../../src/video/video.service';
import { VideoTaskService } from '../../../src/video/video-task.service';

describe('video ownership boundaries', () => {
  it('filters assets by the authenticated user', async () => {
    const assetRepo = { find: jest.fn().mockResolvedValue([]) };

    await VideoService.prototype.findAssetsBySessionId.call(
      { assetRepo },
      'session-1',
      7,
    );

    expect(assetRepo.find).toHaveBeenCalledWith({
      where: { sessionId: 'session-1', userId: 7 },
      order: { createdAt: 'DESC' },
    });
  });

  it('rejects deleting another user asset', async () => {
    const assetRepo = { delete: jest.fn().mockResolvedValue({ affected: 0 }) };

    await expect(
      VideoService.prototype.deleteAsset.call({ assetRepo }, 42, 8),
    ).rejects.toEqual(new NotFoundException('素材不存在'));
    expect(assetRepo.delete).toHaveBeenCalledWith({ id: 42, userId: 8 });
  });

  it('filters task lookup by the authenticated user', async () => {
    const videoTaskRepo = { findOne: jest.fn().mockResolvedValue(null) };

    await VideoTaskService.prototype.queryTask.call(
      { videoTaskRepo },
      'task-1',
      9,
    );

    expect(videoTaskRepo.findOne).toHaveBeenCalledWith({
      where: { taskId: 'task-1', userId: 9 },
    });
  });
});
