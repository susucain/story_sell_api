import { BadRequestException } from '@nestjs/common';
import type { Shot } from './storyboard-parser.service';

/** 单段生成时长上限（秒），与视频模型单次生成上限保持一致 */
export const DEFAULT_SEGMENT_DURATION_SEC = 15;
/** 官方最短生成时长（秒） */
export const MIN_SEGMENT_DURATION_SEC = 4;

/** 段内单个镜头：保留原始镜头序号，便于跨段保持编号连续 */
export interface SegmentShot {
  /** 原始镜头序号（storyboard 中的 shot 字段） */
  shot: number;
  /** 在整脚本镜头列表中的下标（0 基），用于按序号取回原始提示词块 */
  ordinal: number;
  scene: string;
  visual: string;
  audio: string;
  /** 该镜头由上一段延续而来（镜头被段边界切开） */
  continues: boolean;
}

export interface PlannedSegment {
  /** 段序号，从 1 开始 */
  index: number;
  startSec: number;
  endSec: number;
  duration: number;
  shots: SegmentShot[];
}

export interface PlanVideoSegmentsParams {
  shots: Shot[];
  /** 脚本总时长（秒） */
  targetDuration: number;
  /** 单段时长上限，默认 15 秒 */
  segmentDuration?: number;
  /** 最短段时长，默认 4 秒 */
  minDuration?: number;
}

interface TimelineShot {
  shot: number;
  ordinal: number;
  start: number;
  end: number;
  scene: string;
  visual: string;
  audio: string;
}

const EPSILON = 1e-6;

/** 解析 "0-3s" / "0 - 3 秒" 形式的时间区间 */
export function parseShotTime(
  time: string | undefined,
): { start: number; end: number } | null {
  if (!time) return null;
  const match = /(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-~–—]\s*(\d+(?:\.\d+)?)/.exec(
    time,
  );
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return { start, end };
}

/**
 * 解析脚本总时长：取「声明时长」与「最后一个镜头结束时间」的较大值。
 * 声明时长缺失或非法时只用镜头时间轴推算。
 */
export function resolveTargetDuration(
  shots: Shot[],
  declaredDuration?: unknown,
): number {
  const metaDuration = Number(declaredDuration);
  const lastShotEnd = (shots ?? []).reduce((max, shot) => {
    const parsed = parseShotTime(shot?.time);
    return parsed ? Math.max(max, parsed.end) : max;
  }, 0);

  return Math.max(
    Number.isFinite(metaDuration) && metaDuration > 0 ? metaDuration : 0,
    lastShotEnd,
  );
}

/**
 * 按"时长切分 + 镜头边界吸附"把脚本切成可逐段生成的段落。
 *
 * 切分原则（保证拼接不割裂）：
 * 1. 段边界优先吸附到镜头结束时间，避免把台词/连续动作切到两段；
 * 2. 单段不超过 segmentDuration，保证每段都能独立提交给视频模型；
 * 3. 单段不小于 minDuration（官方最短时长），末段过短时与上一段均分；
 * 4. 镜头确实跨越边界时按边界切开，音频（台词）只保留在起始段，后续段用 continues 标记延续。
 */
export function planVideoSegments(
  params: PlanVideoSegmentsParams,
): PlannedSegment[] {
  const segmentDuration =
    params.segmentDuration ?? DEFAULT_SEGMENT_DURATION_SEC;
  const minDuration = params.minDuration ?? MIN_SEGMENT_DURATION_SEC;
  const targetDuration = Number(params.targetDuration);

  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new BadRequestException('脚本总时长无效，无法规划分段生成');
  }
  if (segmentDuration < minDuration) {
    throw new BadRequestException('单段时长上限不能小于官方最短生成时长');
  }

  const timeline = buildTimeline(params.shots ?? [], targetDuration);
  const cuts = computeCuts(
    targetDuration,
    segmentDuration,
    minDuration,
    timeline,
  );

  return buildSegments(cuts, timeline);
}

/** 把镜头列表整理成单调递增的时间轴；时间缺失时按剩余时长比例估算 */
function buildTimeline(shots: Shot[], targetDuration: number): TimelineShot[] {
  const timeline: TimelineShot[] = [];
  let cursor = 0;

  shots.forEach((shot, ordinal) => {
    const parsed = parseShotTime(shot.time);
    let start: number;
    let end: number;

    if (parsed) {
      start = Math.max(parsed.start, cursor);
      end = Math.max(parsed.end, start);
    } else {
      const remainingShots = shots.length - ordinal;
      const estimated = Math.max((targetDuration - cursor) / remainingShots, 0);
      start = cursor;
      end = cursor + estimated;
    }

    timeline.push({
      shot: Number(shot.shot) || ordinal + 1,
      ordinal,
      start,
      end,
      scene: shot.scene ?? '',
      visual: shot.visual ?? shot.scene ?? '',
      audio: shot.audio ?? '',
    });
    cursor = end;
  });

  return timeline;
}

/** 计算段边界（含首尾），同时保证每段落在 [minDuration, segmentDuration] 内 */
function computeCuts(
  targetDuration: number,
  segmentDuration: number,
  minDuration: number,
  timeline: TimelineShot[],
): number[] {
  if (targetDuration <= segmentDuration) {
    if (targetDuration < minDuration) {
      throw new BadRequestException(
        `脚本总时长不足官方最短生成时长 ${minDuration} 秒，无法生成视频`,
      );
    }
    return [0, targetDuration];
  }

  const shotEnds = timeline
    .map((item) => item.end)
    .filter((end) => end > 0 && end < targetDuration - EPSILON)
    .sort((a, b) => a - b);

  const cuts: number[] = [0];
  let cursor = 0;

  while (targetDuration - cursor > segmentDuration + EPSILON) {
    const desired = cursor + segmentDuration;
    // 吸附到最后一个不晚于期望位置的镜头边界
    const candidate = [...shotEnds]
      .reverse()
      .find(
        (end) =>
          end > cursor + minDuration - EPSILON && end <= desired + EPSILON,
      );

    let cut = candidate ?? desired;
    if (cut <= cursor + EPSILON) {
      cut = desired;
    }

    // 切完后剩余不足最短时长时，尽量提前到更早的镜头边界
    if (targetDuration - cut < minDuration - EPSILON) {
      const earlier = [...shotEnds]
        .reverse()
        .find(
          (end) =>
            end > cursor + minDuration - EPSILON &&
            end < cut - EPSILON &&
            targetDuration - end >= minDuration - EPSILON,
        );
      if (earlier) cut = earlier;
    }

    cuts.push(cut);
    cursor = cut;
  }

  cuts.push(targetDuration);
  return balanceTail(cuts, targetDuration, segmentDuration, minDuration);
}

/** 末段过短时，把最后两段重新均分，保证都落在 [minDuration, segmentDuration] 内 */
function balanceTail(
  cuts: number[],
  targetDuration: number,
  segmentDuration: number,
  minDuration: number,
): number[] {
  const lastIndex = cuts.length - 1;
  if (lastIndex < 2) return cuts;

  const lastDuration = cuts[lastIndex] - cuts[lastIndex - 1];
  if (lastDuration >= minDuration - EPSILON) return cuts;

  const prevStart = cuts[lastIndex - 2];
  const span = targetDuration - prevStart;
  if (
    span > 2 * segmentDuration + EPSILON ||
    span < 2 * minDuration - EPSILON
  ) {
    return cuts;
  }

  const balanced = [...cuts];
  balanced.splice(lastIndex - 1, 1, prevStart + span / 2);
  return balanced;
}

/** 按段边界把时间轴切成段落，跨边界的镜头切分并保留续接标记 */
function buildSegments(
  cuts: number[],
  timeline: TimelineShot[],
): PlannedSegment[] {
  const segments: PlannedSegment[] = [];

  for (let i = 0; i < cuts.length - 1; i += 1) {
    const startSec = cuts[i];
    const endSec = cuts[i + 1];
    const shots: SegmentShot[] = [];

    for (const item of timeline) {
      const overlapStart = Math.max(item.start, startSec);
      const overlapEnd = Math.min(item.end, endSec);
      if (overlapEnd - overlapStart <= EPSILON) continue;

      const isFirstPart = item.start >= startSec - EPSILON;
      shots.push({
        shot: item.shot,
        ordinal: item.ordinal,
        scene: item.scene,
        visual: item.visual,
        // 台词只保留在镜头起始段，避免拼接后台词重复
        audio: isFirstPart ? item.audio : '',
        continues: !isFirstPart,
      });
    }

    segments.push({
      index: i + 1,
      startSec,
      endSec,
      duration: endSec - startSec,
      shots,
    });
  }

  return segments;
}

/** 段落时长转换为提交给视频模型的整数秒数（并夹在官方合法区间内） */
export function toRequestDuration(
  segment: PlannedSegment,
  segmentDuration = DEFAULT_SEGMENT_DURATION_SEC,
  minDuration = MIN_SEGMENT_DURATION_SEC,
): number {
  const rounded = Math.round(segment.duration);
  return Math.min(segmentDuration, Math.max(minDuration, rounded));
}
