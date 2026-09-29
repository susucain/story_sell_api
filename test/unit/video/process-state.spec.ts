import {
  buildProcessState,
  ProcessState,
} from '../../../src/video/types/process-state';
import { ProcessTracker } from '../../../src/video/process-tracker';

const createTracker = () => {
  const chunks: Array<{ type: string; data: ProcessState }> = [];
  const tracker = new ProcessTracker({
    writer: { write: (chunk) => chunks.push(chunk as never) },
    analysisAssets: [],
  });
  const lastState = () => chunks[chunks.length - 1].data;

  return { tracker, chunks, lastState };
};

describe('buildProcessState', () => {
  it('emits phase descriptors supplied by the orchestrator', () => {
    const state = buildProcessState([
      { id: 'dispatch-screenwriter', title: '编剧' },
    ]);

    expect(state.phases[0].id).toBe('dispatch-screenwriter');
    expect(state.phases[0].title).toBe('编剧');
    expect(state.phases[0].status).toBe('running');
    expect(state.status).toBe('running');
  });

  it('marks trailing phases as pending and honours explicit statuses', () => {
    const state = buildProcessState([
      { id: 'a', title: 'A', status: 'completed' },
      { id: 'b', title: 'B' },
    ]);

    expect(state.phases.map((phase) => phase.status)).toEqual([
      'completed',
      'pending',
    ]);
  });
});

describe('ProcessTracker role phases', () => {
  it('keeps the fixed life-service phases when nothing is dispatched', () => {
    const { tracker, lastState } = createTracker();

    tracker.start();

    expect(lastState().phases.map((phase) => phase.id)).toEqual([
      'load-guidelines',
      'generate-script',
    ]);
  });

  it('appends a phase when a role sub-agent is dispatched', () => {
    const { tracker, lastState } = createTracker();
    tracker.start();

    tracker.markRoleDispatched('screenwriter', '编剧');

    const phase = lastState().phases.find(
      (item) => item.id === 'dispatch-screenwriter',
    );
    expect(phase?.title).toBe('编剧');
    expect(phase?.status).toBe('running');
  });

  it('does not duplicate the phase when a role is dispatched twice', () => {
    const { tracker, lastState } = createTracker();
    tracker.start();

    tracker.markRoleDispatched('screenwriter', '编剧');
    tracker.markRoleDispatched('screenwriter', '编剧');

    const matches = lastState().phases.filter(
      (item) => item.id === 'dispatch-screenwriter',
    );
    expect(matches).toHaveLength(1);
  });

  it('marks the role phase completed when the dispatch finishes', () => {
    const { tracker, lastState } = createTracker();
    tracker.start();
    tracker.markRoleDispatched('shot-planner', '导演');

    tracker.markRoleCompleted('shot-planner');

    const phase = lastState().phases.find(
      (item) => item.id === 'dispatch-shot-planner',
    );
    expect(phase?.status).toBe('completed');
    expect(phase?.endTime).toBeDefined();
  });
});