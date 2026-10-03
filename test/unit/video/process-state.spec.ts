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

describe('ProcessTracker role items', () => {
  const findRoleItem = (
    phases: ProcessState['phases'],
    roleId: string,
    itemId: string,
  ) =>
    phases
      .find((phase) => phase.id === roleId)
      ?.items?.find((item) => item.id === itemId);

  it('keeps the fixed life-service phases when nothing is dispatched', () => {
    const { tracker, lastState } = createTracker();

    tracker.start();

    expect(lastState().phases.map((phase) => phase.id)).toEqual([
      'load-guidelines',
      'generate-script',
    ]);
  });

  it('nests the role sub-agent under the script phase when dispatched', () => {
    const { tracker, lastState } = createTracker();
    tracker.start();

    tracker.markRoleDispatched('screenwriter', '编剧');

    const item = findRoleItem(
      lastState().phases,
      'generate-script',
      'role-screenwriter',
    );
    expect(item?.title).toBe('编剧');
    expect(item?.status).toBe('running');
    expect(item?.description).toContain('正在处理分派任务');
    // 角色分工不再作为顶层阶段出现，避免与阶段 2 平级错位
    expect(lastState().phases.map((phase) => phase.id)).toEqual([
      'load-guidelines',
      'generate-script',
    ]);
  });

  it('does not duplicate the role item when a role is dispatched twice', () => {
    const { tracker, lastState } = createTracker();
    tracker.start();

    tracker.markRoleDispatched('screenwriter', '编剧');
    tracker.markRoleDispatched('screenwriter', '编剧');

    const phase = lastState().phases.find(
      (entry) => entry.id === 'generate-script',
    );
    expect(
      phase?.items?.filter((item) => item.id === 'role-screenwriter'),
    ).toHaveLength(1);
  });

  it('writes a completed description when the dispatch finishes', () => {
    const { tracker, lastState } = createTracker();
    tracker.start();
    tracker.markRoleDispatched('shot-planner', '导演');

    tracker.markRoleCompleted('shot-planner');

    const item = findRoleItem(
      lastState().phases,
      'generate-script',
      'role-shot-planner',
    );
    expect(item?.status).toBe('completed');
    expect(item?.description).toContain('已完成');
    expect(item?.tag?.type).toBe('success');
  });
});
