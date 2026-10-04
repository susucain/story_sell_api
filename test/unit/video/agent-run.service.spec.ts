import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import {
  AgentRunService,
  RUN_REASON_USER_CANCELLED,
} from '../../../src/video/agent-run.service';

function createRepo() {
  return {
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
  };
}

function createCancelBus() {
  return {
    onCancel: jest.fn(),
    publishCancel: jest.fn().mockResolvedValue(undefined),
  };
}

function createService(repo = createRepo(), cancelBus = createCancelBus()) {
  return {
    service: new AgentRunService(repo as any, cancelBus as any),
    repo,
    cancelBus,
  };
}

describe('AgentRunService', () => {
  it('registers a run and rejects a second run for the same session', async () => {
    const { service, repo } = createService();

    const run = await service.startRun('session-1', 7);

    expect(run.signal.aborted).toBe(false);
    expect(service.getActive('session-1')).toBe(run);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        userId: 7,
        status: 'running',
        // 会话互斥键
        runningKey: 'session-1',
      }),
    );

    await expect(service.startRun('session-1', 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps a duplicate running_key to a 409 (cross-instance guard)', async () => {
    const repo = createRepo();
    repo.save.mockRejectedValueOnce(
      new QueryFailedError('insert', [], {
        code: 'ER_DUP_ENTRY',
        errno: 1062,
      } as never),
    );
    const { service } = createService(repo);

    await expect(service.startRun('session-1', 7)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(service.getActive('session-1')).toBeUndefined();
  });

  it('releases the registry when the run cannot be persisted', async () => {
    const repo = createRepo();
    repo.save.mockRejectedValueOnce(new Error('db down'));
    const { service } = createService(repo);

    await expect(service.startRun('session-1', 7)).rejects.toThrow('db down');
    expect(service.getActive('session-1')).toBeUndefined();
  });

  it('cancels the active run for a session and records the reason', async () => {
    const { service } = createService();
    const run = await service.startRun('session-1', 7);

    const cancelled = await service.cancel('session-1', 7);

    expect(cancelled).toBe(true);
    expect(run.signal.aborted).toBe(true);
    expect(run.errorCode).toBe(RUN_REASON_USER_CANCELLED);
  });

  it('does not cancel a run owned by another user', async () => {
    const { service } = createService();
    const run = await service.startRun('session-1', 7);

    const cancelled = await service.cancel('session-1', 8);

    expect(cancelled).toBe(false);
    expect(run.signal.aborted).toBe(false);
  });

  it('signals a run living on another instance via flag + broadcast', async () => {
    const repo = createRepo();
    const cancelBus = createCancelBus();
    repo.findOne.mockResolvedValueOnce({
      runId: 'run-remote',
      sessionId: 'session-1',
      userId: 7,
      status: 'running',
    });
    const { service } = createService(repo, cancelBus);

    const cancelled = await service.cancel('session-1', 7);

    expect(cancelled).toBe(true);
    const [, patch] = repo.update.mock.calls[0] as [
      { runId: string },
      { cancelRequestedAt: Date },
    ];
    expect(patch.cancelRequestedAt).toBeInstanceOf(Date);
    expect(cancelBus.publishCancel).toHaveBeenCalledWith('run-remote');
  });

  it('does not signal a remote run owned by another user', async () => {
    const repo = createRepo();
    const cancelBus = createCancelBus();
    repo.findOne.mockResolvedValueOnce({
      runId: 'run-remote',
      sessionId: 'session-1',
      userId: 99,
      status: 'running',
    });
    const { service } = createService(repo, cancelBus);

    const cancelled = await service.cancel('session-1', 7);

    expect(cancelled).toBe(false);
    expect(cancelBus.publishCancel).not.toHaveBeenCalled();
  });

  it('returns false when no run exists for the session anywhere', async () => {
    const { service } = createService();

    await expect(service.cancel('session-1')).resolves.toBe(false);
  });

  it('aborts a locally held run when a cancel is broadcast for its runId', async () => {
    const cancelBus = createCancelBus();
    const { service } = createService(createRepo(), cancelBus);
    service.onModuleInit();
    const run = await service.startRun('session-1', 7);

    const [handler] = cancelBus.onCancel.mock.calls[0] as [
      (id: string) => void,
    ];
    handler(run.runId);

    expect(run.signal.aborted).toBe(true);
    expect(run.errorCode).toBe(RUN_REASON_USER_CANCELLED);
  });

  it('finalizes an aborted run as cancelled and is idempotent', async () => {
    const { service, repo } = createService();
    const run = await service.startRun('session-1', 7);
    await service.cancel('session-1', 7);

    await service.finalize(run);
    await service.finalize(run);

    expect(service.getActive('session-1')).toBeUndefined();
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(
      { runId: run.runId },
      expect.objectContaining({ status: 'cancelled', runningKey: null }),
    );
  });

  it('finalizes a failed run with its error code and a clean run as succeeded', async () => {
    const { service, repo } = createService();

    const failed = await service.startRun('session-1', 7);
    service.markError(failed, 'VIDEO_AGENT_ERROR');
    await service.finalize(failed);
    expect(repo.update).toHaveBeenLastCalledWith(
      { runId: failed.runId },
      expect.objectContaining({
        status: 'failed',
        errorCode: 'VIDEO_AGENT_ERROR',
      }),
    );

    const succeeded = await service.startRun('session-2', 7);
    await service.finalize(succeeded);
    expect(repo.update).toHaveBeenLastCalledWith(
      { runId: succeeded.runId },
      expect.objectContaining({ status: 'succeeded', errorCode: null }),
    );
  });

  it('looks up the running run for a session from the database', async () => {
    const repo = createRepo();
    repo.findOne.mockResolvedValueOnce({ runId: 'run-1' });
    const { service } = createService(repo);

    await expect(service.findRunningBySession('session-1')).resolves.toEqual({
      runId: 'run-1',
    });
  });
});
