jest.mock('ioredis', () => {
  const RedisMock = jest.fn().mockImplementation(() => ({
    publish: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
  }));
  return { __esModule: true, default: RedisMock };
});

import Redis from 'ioredis';
import {
  RunCancelService,
  RUN_CANCEL_CHANNEL,
} from '../../../src/video/run-cancel.service';

const RedisMockCtor = Redis as unknown as jest.Mock;

function createService(): RunCancelService {
  return new RunCancelService({ get: () => undefined } as never);
}

/** 取本次构造出的实例（[0]=publisher, [1]=subscriber） */
function instancesOf(): { publish: jest.Mock; on: jest.Mock }[] {
  return RedisMockCtor.mock.results.map(
    (result) => result.value as { publish: jest.Mock; on: jest.Mock },
  );
}

describe('RunCancelService', () => {
  beforeEach(() => {
    RedisMockCtor.mockClear();
  });

  it('publishes a cancel signal carrying the runId', async () => {
    const service = createService();
    const [publisher] = instancesOf();

    await service.publishCancel('run-1');

    expect(publisher.publish).toHaveBeenCalledWith(RUN_CANCEL_CHANNEL, 'run-1');
  });

  it('swallows publish failures so the caller is not broken', async () => {
    const service = createService();
    const [publisher] = instancesOf();
    publisher.publish.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.publishCancel('run-1')).resolves.toBeUndefined();
  });

  it('dispatches incoming cancel messages to registered handlers', () => {
    const service = createService();
    const subscriber = instancesOf()[1];
    const handler = jest.fn();
    service.onCancel(handler);

    service.onModuleInit();
    const messageCall = subscriber.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    ) as [string, (channel: string, message: string) => void];
    messageCall[1](RUN_CANCEL_CHANNEL, 'run-1');

    expect(handler).toHaveBeenCalledWith('run-1');
  });

  it('ignores messages from unrelated channels', () => {
    const service = createService();
    const subscriber = instancesOf()[1];
    const handler = jest.fn();
    service.onCancel(handler);

    service.onModuleInit();
    const messageCall = subscriber.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    ) as [string, (channel: string, message: string) => void];
    messageCall[1]('other-channel', 'run-1');

    expect(handler).not.toHaveBeenCalled();
  });

  it('stops notifying a handler after it unsubscribes', () => {
    const service = createService();
    const subscriber = instancesOf()[1];
    const handler = jest.fn();
    const unsubscribe = service.onCancel(handler);
    unsubscribe();

    service.onModuleInit();
    const messageCall = subscriber.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    ) as [string, (channel: string, message: string) => void];
    messageCall[1](RUN_CANCEL_CHANNEL, 'run-1');

    expect(handler).not.toHaveBeenCalled();
  });
});
