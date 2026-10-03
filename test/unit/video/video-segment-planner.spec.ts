import {
  MIN_SEGMENT_DURATION_SEC,
  planVideoSegments,
  resolveTargetDuration,
  toRequestDuration,
} from '../../../src/video/video-segment-planner';
import type { Shot } from '../../../src/video/storyboard-parser.service';

function shot(
  shotNumber: number,
  start: number,
  end: number,
  audio = '',
): Shot {
  return {
    shot: shotNumber,
    time: `${start}-${end}s`,
    scene: `场景${shotNumber}`,
    visual: `画面${shotNumber}`,
    audio,
  };
}

describe('planVideoSegments', () => {
  it('rejects an invalid target duration', () => {
    expect(() => planVideoSegments({ shots: [], targetDuration: 0 })).toThrow(
      '脚本总时长无效',
    );
  });

  it('rejects a script shorter than the official minimum duration', () => {
    expect(() =>
      planVideoSegments({
        shots: [shot(1, 0, 3)],
        targetDuration: 3,
      }),
    ).toThrow(`不足官方最短生成时长 ${MIN_SEGMENT_DURATION_SEC} 秒`);
  });

  it('keeps a short script as a single segment', () => {
    const segments = planVideoSegments({
      shots: [shot(1, 0, 7), shot(2, 7, 15)],
      targetDuration: 15,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ index: 1, startSec: 0, endSec: 15 });
  });

  it('splits a 30s script into two segments without splitting shots', () => {
    const shots = [
      shot(1, 0, 3),
      shot(2, 3, 6),
      shot(3, 6, 9),
      shot(4, 9, 12),
      shot(5, 12, 15),
      shot(6, 15, 18),
      shot(7, 18, 21),
      shot(8, 21, 24),
      shot(9, 24, 27),
      shot(10, 27, 30),
    ];

    const segments = planVideoSegments({ shots, targetDuration: 30 });

    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.duration)).toEqual([15, 15]);
    expect(segments[0].shots.map((item) => item.shot)).toEqual([1, 2, 3, 4, 5]);
    expect(segments[1].shots.map((item) => item.shot)).toEqual([
      6, 7, 8, 9, 10,
    ]);
    expect(
      segments
        .flatMap((segment) => segment.shots)
        .every((item) => !item.continues),
    ).toBe(true);
  });

  it('snaps the cut to a shot boundary so dialogue stays in one segment', () => {
    const shots = [
      shot(1, 0, 5, '第一句台词'),
      shot(2, 5, 14, '第二句很长的台词，不能被切开'),
      shot(3, 14, 20),
      shot(4, 20, 30),
    ];

    const segments = planVideoSegments({ shots, targetDuration: 30 });

    const secondShotSegments = segments.filter((segment) =>
      segment.shots.some((item) => item.shot === 2),
    );
    expect(secondShotSegments).toHaveLength(1);
    expect(
      secondShotSegments[0].shots.find((item) => item.shot === 2)?.audio,
    ).toBe('第二句很长的台词，不能被切开');
  });

  it('balances the tail when the last segment would be shorter than the minimum', () => {
    const segments = planVideoSegments({
      shots: [shot(1, 0, 15), shot(2, 15, 17)],
      targetDuration: 17,
    });

    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(segment.duration).toBeGreaterThanOrEqual(MIN_SEGMENT_DURATION_SEC);
      expect(segment.duration).toBeLessThanOrEqual(15);
    }
  });

  it('splits a shot that spans a segment boundary and keeps audio only once', () => {
    const segments = planVideoSegments({
      shots: [shot(1, 0, 20, '跨段台词')],
      targetDuration: 20,
    });

    expect(segments).toHaveLength(2);
    expect(segments[0].duration).toBe(15);
    expect(segments[1].duration).toBe(5);

    const [firstShot, secondShot] = [
      segments[0].shots[0],
      segments[1].shots[0],
    ];
    expect(firstShot.continues).toBe(false);
    expect(firstShot.audio).toBe('跨段台词');
    expect(secondShot.continues).toBe(true);
    expect(secondShot.audio).toBe('');
  });

  it('plans three segments for a 45s script', () => {
    const shots = Array.from({ length: 15 }, (_, index) =>
      shot(index + 1, index * 3, index * 3 + 3),
    );

    const segments = planVideoSegments({ shots, targetDuration: 45 });

    expect(segments).toHaveLength(3);
    expect(segments.map((segment) => segment.index)).toEqual([1, 2, 3]);
    expect(segments.at(-1)!.endSec).toBe(45);
  });

  it('falls back to even split when shots carry no parseable time', () => {
    const shots: Shot[] = [
      { shot: 1, time: '', scene: 'A', visual: 'A', audio: '' },
      { shot: 2, time: '', scene: 'B', visual: 'B', audio: '' },
    ];

    const segments = planVideoSegments({ shots, targetDuration: 30 });

    expect(segments).toHaveLength(2);
    expect(segments[0].duration).toBe(15);
    expect(segments[1].duration).toBe(15);
  });
});

describe('resolveTargetDuration', () => {
  it('prefers the larger of the declared duration and the last shot end', () => {
    expect(resolveTargetDuration([shot(1, 0, 12)], 20)).toBe(20);
    expect(resolveTargetDuration([shot(1, 0, 25)], 20)).toBe(25);
    expect(resolveTargetDuration([shot(1, 0, 12)], undefined)).toBe(12);
    expect(resolveTargetDuration([], 'abc')).toBe(0);
  });
});

describe('toRequestDuration', () => {
  it('rounds to whole seconds and clamps into the legal range', () => {
    expect(
      toRequestDuration({
        index: 1,
        startSec: 0,
        endSec: 8.5,
        duration: 8.5,
        shots: [],
      }),
    ).toBe(9);
    expect(
      toRequestDuration({
        index: 1,
        startSec: 0,
        endSec: 16,
        duration: 16,
        shots: [],
      }),
    ).toBe(15);
    expect(
      toRequestDuration({
        index: 1,
        startSec: 0,
        endSec: 2,
        duration: 2,
        shots: [],
      }),
    ).toBe(4);
  });
});
