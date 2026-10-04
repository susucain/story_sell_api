/**
 * 为 Agent 流里的文本 part 显式标注「属于哪个 step」以及「是过程旁白还是最终答复」。
 *
 * 背景：AI SDK 的 `toUIMessageStream` 每个 step 都会从 `txt-0` 重新编号，
 * 也不告诉客户端某段文本是「工具调用前的旁白」还是「最终答复」。前端只能靠
 * 「最后一个工具调用的下标」猜测，而这个下标在流式期间会不断右移，导致已经
 * 渲染出来的旁白被判定为非正文而消失（闪现）。
 *
 * 这里把归属与角色显式化：
 * - 文本 part 的 id 加上 step 前缀（`s2-txt-0`），前端可据此定位所属 step，
 *   同时顺带修复了跨 step id 复用（都是 `txt-0`）带来的隐患；
 * - 角色在可判定时立即广播：一旦该 step 出现工具调用，立刻标记为过程旁白；
 *   该 step 收尾（`finish-step` / `finish`）时再广播最终值。
 */

export interface TextStepMeta {
  /** 0 起的 step 序号 */
  stepIndex: number;
  /** true = 该步产生了工具调用，其文本属于过程旁白；false = 最终答复步 */
  interstitial: boolean;
}

export interface TextMetaDataPart {
  type: 'data-text-meta';
  data: TextStepMeta;
}

interface ChunkLike {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

export class StreamStepAnnotator {
  private stepIndex = -1;
  private textSeq = 0;
  private readonly idMap = new Map<string, string>();
  private stepHasTool = false;
  private settled = false;
  private lastBroadcast?: boolean;

  constructor(private readonly emitMeta: (meta: TextStepMeta) => void) {}

  /** 归一化并透传 chunk；文本 id 会带上 step 前缀，角色变化时回调 emitMeta */
  annotate<T extends ChunkLike>(chunk: T): T {
    switch (chunk?.type) {
      case 'start-step':
        this.stepIndex += 1;
        this.textSeq = 0;
        this.idMap.clear();
        this.stepHasTool = false;
        this.settled = false;
        this.lastBroadcast = undefined;
        break;
      case 'text-start': {
        if (this.stepIndex < 0) break;
        const originalId = String(chunk.id);
        const nextId = `s${this.stepIndex}-txt-${this.textSeq++}`;
        this.idMap.set(originalId, nextId);
        return { ...chunk, id: nextId };
      }
      case 'text-delta':
      case 'text-end': {
        const nextId = this.idMap.get(String(chunk.id));
        if (nextId) return { ...chunk, id: nextId };
        break;
      }
      case 'finish-step':
      case 'finish':
        this.settle();
        break;
      default:
        if (typeof chunk?.type === 'string' && chunk.type.startsWith('tool-')) {
          this.markTool();
        }
        break;
    }
    return chunk;
  }

  /** 该 step 出现工具调用，说明此前的文本是过程旁白 */
  private markTool() {
    if (this.stepIndex < 0 || this.stepHasTool) return;
    this.stepHasTool = true;
    this.broadcast();
  }

  /** step 收尾，广播该步的最终角色 */
  private settle() {
    if (this.stepIndex < 0 || this.settled) return;
    this.settled = true;
    this.broadcast();
  }

  /** 只在角色发生变化时广播，避免重复下发同一 step 的元数据 */
  private broadcast() {
    if (this.lastBroadcast === this.stepHasTool) return;
    this.lastBroadcast = this.stepHasTool;
    this.emitMeta({
      stepIndex: this.stepIndex,
      interstitial: this.stepHasTool,
    });
  }
}
