import { OssService } from '../../../src/oss/oss.service';

describe('OSS ownership boundaries', () => {
  it('filters file lists by the authenticated user', async () => {
    const ossFileRepo = { findAndCount: jest.fn().mockResolvedValue([[], 0]) };

    const result = await OssService.prototype.findAll.call(
      { ossFileRepo },
      1,
      10,
      5,
    );

    expect(ossFileRepo.findAndCount).toHaveBeenCalledWith({
      where: { userId: 5 },
      order: { createdAt: 'DESC' },
      skip: 0,
      take: 10,
    });
    expect(result.total).toBe(0);
  });

  it('filters deletion by the authenticated user', async () => {
    const ossFileRepo = {
      delete: jest.fn().mockResolvedValue(undefined),
      findOneBy: jest.fn().mockResolvedValue(null),
    };

    await expect(OssService.prototype.remove.call({ ossFileRepo }, 10, 6))
      .resolves.toBeNull();
    expect(ossFileRepo.findOneBy).toHaveBeenCalledWith({ id: 10, userId: 6 });
    expect(ossFileRepo.delete).not.toHaveBeenCalled();
  });
});
