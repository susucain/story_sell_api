import {
  StreamStepAnnotator,
  TextStepMeta,
} from '../../../src/video/stream-step-annotator';

describe('StreamStepAnnotator', () => {
  const create = () => {
    const metas: TextStepMeta[] = [];
    const annotator = new StreamStepAnnotator((meta) => metas.push(meta));
    return { annotator, metas };
  };

  it('prefixes text ids with the step index so cross-step ids stay unique', () => {
    const { annotator } = create();

    annotator.annotate({ type: 'start-step' });
    const firstStart = annotator.annotate({ type: 'text-start', id: 'txt-0' });
    const firstDelta = annotator.annotate({
      type: 'text-delta',
      id: 'txt-0',
      delta: '旁白',
    });
    annotator.annotate({ type: 'text-end', id: 'txt-0' });

    annotator.annotate({ type: 'start-step' });
    const secondStart = annotator.annotate({ type: 'text-start', id: 'txt-0' });

    expect(firstStart.id).toBe('s0-txt-0');
    expect(firstDelta.id).toBe('s0-txt-0');
    expect(secondStart.id).toBe('s1-txt-0');
  });

  it('marks a step as interstitial as soon as a tool call appears', () => {
    const { annotator, metas } = create();

    annotator.annotate({ type: 'start-step' });
    annotator.annotate({ type: 'text-start', id: 'txt-0' });
    annotator.annotate({ type: 'text-delta', id: 'txt-0', delta: '我需要先' });
    expect(metas).toEqual([]);

    annotator.annotate({ type: 'tool-input-start', toolCallId: 'call-1' });

    expect(metas).toEqual([{ stepIndex: 0, interstitial: true }]);
  });

  it('reports the final answer step as non-interstitial when it closes', () => {
    const { annotator, metas } = create();

    annotator.annotate({ type: 'start-step' });
    annotator.annotate({ type: 'text-start', id: 'txt-0' });
    annotator.annotate({ type: 'text-delta', id: 'txt-0', delta: '已完成' });
    annotator.annotate({ type: 'finish-step' });

    expect(metas).toEqual([{ stepIndex: 0, interstitial: false }]);
  });

  it('settles the open step when the stream ends', () => {
    const { annotator, metas } = create();

    annotator.annotate({ type: 'start-step' });
    annotator.annotate({ type: 'tool-input-available', toolCallId: 'call-1' });
    annotator.annotate({ type: 'finish' });

    expect(metas).toEqual([{ stepIndex: 0, interstitial: true }]);
  });

  it('leaves chunks untouched when no step boundary was seen', () => {
    const { annotator, metas } = create();

    const chunk = annotator.annotate({ type: 'text-start', id: 'txt-0' });

    expect(chunk.id).toBe('txt-0');
    expect(metas).toEqual([]);
  });
});
