export type ProcessStatus = 'pending' | 'running' | 'waiting_for_user' | 'completed' | 'error' | 'skipped';

export interface ProcessItem {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  /** 小标签，如「已解析」 */
  tag?: { text: string; type: 'success' | 'info' };
  /** 额外元信息，用于前端展示时长、平台等 */
  meta?: Record<string, string | number | undefined>;
}

export interface ProcessCard {
  id: string;
  icon: string;
  iconColor: string;
  iconBg: string;
  title: string;
  description: string;
}

export interface ProcessAction {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'running' | 'waiting_for_user' | 'completed' | 'error';
}

export interface ProcessOutput {
  title: string;
  tags: string[];
}

export interface ProcessPhase {
  /** 阶段标识。life-service 使用固定三阶段，多 Agent 场景使用 `dispatch-<role>` */
  id: string;
  title: string;
  description: string;
  status: ProcessStatus;
  startTime?: number;
  endTime?: number;
  /** 阶段 1 使用：素材子项列表 */
  items?: ProcessItem[];
  /** 阶段 2 使用：能力规范卡片 */
  cards?: ProcessCard[];
  /** 阶段 3 使用：已完成的动作 */
  actions?: ProcessAction[];
  /** 阶段 3 使用：产出预览 */
  outputs?: ProcessOutput[];
}

export interface ProcessState {
  status: ProcessStatus;
  startTime?: number;
  endTime?: number;
  phases: ProcessPhase[];
}

export interface ProcessStateDataPart {
  type: 'data-process-state';
  data: ProcessState;
}

/** 过程阶段描述：由业务侧（含多 Agent 编排）声明，代替固定的阶段联合类型 */
export interface ProcessPhaseDescriptor {
  id: string;
  title: string;
  description?: string;
  status?: ProcessStatus;
}

export interface BuildProcessStateOptions {
  status?: ProcessStatus;
  startTime?: number;
  endTime?: number;
}

/** 用阶段描述列表构建过程状态：首个阶段默认 running，其余 pending */
export function buildProcessState(
  descriptors: ProcessPhaseDescriptor[],
  options: BuildProcessStateOptions = {},
): ProcessState {
  const phases: ProcessPhase[] = descriptors.map((descriptor, index) => {
    const status = descriptor.status ?? (index === 0 ? 'running' : 'pending');
    return {
      id: descriptor.id,
      title: descriptor.title,
      description: descriptor.description ?? '',
      status,
      startTime: status === 'running' ? options.startTime : undefined,
    };
  });

  return {
    status: options.status ?? 'running',
    startTime: options.startTime,
    endTime: options.endTime,
    phases,
  };
}
