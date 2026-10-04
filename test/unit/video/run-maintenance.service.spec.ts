import { RunMaintenanceService } from '../../../src/video/run-maintenance.service';

function createService() {
  const runRepo = {
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const ledger = {
    hasTerminalSuccess: jest.fn().mockResolvedValue(false),
    deleteByRunIds: jest.fn().mockResolvedValue(undefined),
  };
  const runService = {
    collectActiveRunIds: jest.fn(() => new Set<string>()),
  };
  const service = new RunMaintenanceService(
    runService as never,
    ledger as never,
    runRepo as never,
  );
  return { service, runRepo, ledger, runService };
}

function staleRun(runId: string, heartbeatAt: Date | null = null) {
  return { runId, status: 'running', heartbeatAt };
}

describe('RunMaintenanceService reconcile', () => {
  it('reconciles a stale orphan run to failed when no terminal side effect succeeded', async () => {
    const { service, runRepo, ledger } = createService();
    runRepo.find.mockResolvedValueOnce([staleRun('r1')]);
    ledger.hasTerminalSuccess.mockResolvedValueOnce(false);

    const count = await service.reconcileStaleRuns();

    expect(count).toBe(1);
    expect(runRepo.update).toHaveBeenCalledWith(
      { runId: 'r1' },
      expect.objectContaining({
        status: 'failed',
        errorCode: 'RUN_ORPHANED',
      }),
    );
  });

  it('reconciles to succeeded when the ledger shows a terminal success', async () => {
    const { service, runRepo, ledger } = createService();
    runRepo.find.mockResolvedValueOnce([
      staleRun('r1', new Date(Date.now() - 120_000)),
    ]);
    ledger.hasTerminalSuccess.mockResolvedValueOnce(true);

    await service.reconcileStaleRuns();

    expect(runRepo.update).toHaveBeenCalledWith(
      { runId: 'r1' },
      expect.objectContaining({
        status: 'succeeded',
        errorCode: 'RUN_RECOVERED',
      }),
    );
  });

  it('skips runs still registered as active in this process', async () => {
    const { service, runRepo, runService } = createService();
    runService.collectActiveRunIds.mockReturnValueOnce(new Set(['r1']));
    runRepo.find.mockResolvedValueOnce([staleRun('r1')]);

    const count = await service.reconcileStaleRuns();

    expect(count).toBe(0);
    expect(runRepo.update).not.toHaveBeenCalled();
  });

  it('skips runs whose heartbeat is still fresh', async () => {
    const { service, runRepo } = createService();
    runRepo.find.mockResolvedValueOnce([staleRun('r1', new Date())]);

    const count = await service.reconcileStaleRuns();

    expect(count).toBe(0);
    expect(runRepo.update).not.toHaveBeenCalled();
  });

  it('swallows sweep failures and resolves with zero', async () => {
    const { service, runRepo } = createService();
    runRepo.find.mockRejectedValueOnce(new Error('db down'));

    await expect(service.reconcileStaleRuns()).resolves.toBe(0);
  });
});

describe('RunMaintenanceService retention', () => {
  it('deletes expired terminal runs and their ledger rows', async () => {
    const { service, runRepo, ledger } = createService();
    runRepo.find.mockResolvedValueOnce([{ runId: 'r1' }, { runId: 'r2' }]);

    const count = await service.cleanupExpiredRuns();

    expect(count).toBe(2);
    expect(ledger.deleteByRunIds).toHaveBeenCalledWith(['r1', 'r2']);
    expect(runRepo.delete).toHaveBeenCalledTimes(1);
  });

  it('no-ops when nothing is expired', async () => {
    const { service, runRepo, ledger } = createService();

    const count = await service.cleanupExpiredRuns();

    expect(count).toBe(0);
    expect(ledger.deleteByRunIds).not.toHaveBeenCalled();
    expect(runRepo.delete).not.toHaveBeenCalled();
  });
});
