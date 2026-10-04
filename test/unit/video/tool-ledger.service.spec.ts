import {
  ToolLedgerService,
  hashToolArgs,
  isSideEffectTool,
} from '../../../src/video/tool-ledger.service';

function createRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

describe('hashToolArgs', () => {
  it('is stable regardless of key order', () => {
    expect(hashToolArgs({ a: 1, b: 2 })).toBe(hashToolArgs({ b: 2, a: 1 }));
  });

  it('differs when a value changes', () => {
    expect(hashToolArgs({ a: 1 })).not.toBe(hashToolArgs({ a: 2 }));
  });
});

describe('isSideEffectTool', () => {
  it('flags mutating tools and ignores read-only ones', () => {
    expect(isSideEffectTool('generate_script')).toBe(true);
    expect(isSideEffectTool('create_video_task')).toBe(true);
    expect(isSideEffectTool('get_script')).toBe(false);
  });
});

describe('ToolLedgerService', () => {
  it('inserts a succeeded invocation with the next step index', async () => {
    const repo = createRepo();
    repo.count.mockResolvedValueOnce(3);
    const service = new ToolLedgerService(repo as never);

    await service.recordSuccess('run-1', 'generate_script', { a: 1 }, '42');

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        tool: 'generate_script',
        stepIndex: 3,
        status: 'succeeded',
        resultRef: '42',
      }),
    );
  });

  it('updates the existing row instead of inserting a duplicate', async () => {
    const repo = createRepo();
    repo.findOne.mockResolvedValueOnce({ id: 9, resultRef: null });
    const service = new ToolLedgerService(repo as never);

    await service.recordFailure('run-1', 'generate_script', { a: 1 });

    expect(repo.update).toHaveBeenCalledWith(
      9,
      expect.objectContaining({ status: 'failed' }),
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('swallows write failures so the tool path is never broken', async () => {
    const repo = createRepo();
    repo.findOne.mockRejectedValueOnce(new Error('db down'));
    const service = new ToolLedgerService(repo as never);

    await expect(
      service.recordSuccess('run-1', 'generate_script', {}),
    ).resolves.toBeUndefined();
  });

  it('reports a terminal success when a terminal tool succeeded', async () => {
    const repo = createRepo();
    repo.count.mockResolvedValueOnce(1);
    const service = new ToolLedgerService(repo as never);

    await expect(service.hasTerminalSuccess('run-1')).resolves.toBe(true);
  });

  it('no-ops when deleting with an empty run id list', async () => {
    const repo = createRepo();
    const service = new ToolLedgerService(repo as never);

    await service.deleteByRunIds([]);

    expect(repo.delete).not.toHaveBeenCalled();
  });
});
