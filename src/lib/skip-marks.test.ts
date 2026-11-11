import { describe, expect, it } from 'vitest';
import {
  MAX_CONTINUOUS_STEP_SECONDS,
  MAX_ENDING_TAIL_RATIO,
  MIN_SEGMENT_GAP_SECONDS,
  endingTailSeconds,
  findActiveSegment,
  findCrossedEnding,
  migrateSkipMarks,
  nudgeSegment,
  resolveSegment,
  resolveSegments,
  skipMarkKey,
  validateSegment,
  withEndingTail,
  type SkipMark,
  type SkipSegment,
} from './skip-marks';

const mark = (...segments: SkipSegment[]): SkipMark => ({ segments, enabled: true, updatedAt: 0 });

describe('skipMarkKey', () => {
  it('空白、标点、大小写归一后指向同一个标记', () => {
    expect(skipMarkKey('摔跤吧！爸爸', 'a:1')).toBe(skipMarkKey(' 摔跤吧!爸爸 ', 'b:2'));
    expect(skipMarkKey('Hello, World!', 'a:1')).toBe(skipMarkKey('hello world', 'b:2'));
  });

  it('同剧换源共享标记：标题相同、兜底键不同也得到同一个键', () => {
    expect(skipMarkKey('庆余年', 'custom_0:123')).toBe(skipMarkKey('庆余年', 'sub_ab_1:456'));
  });

  it('标题缺失或为占位文案时退回 source:vod 兜底键', () => {
    expect(skipMarkKey(undefined, 'custom_0:123')).toBe('f:custom_0:123');
    expect(skipMarkKey('', 'custom_0:123')).toBe('f:custom_0:123');
    expect(skipMarkKey('未知视频', 'custom_0:123')).toBe('f:custom_0:123');
  });

  it('不同的剧不会互相串标记', () => {
    expect(skipMarkKey('庆余年', 'a')).not.toBe(skipMarkKey('庆余年2', 'a'));
  });
});

describe('migrateSkipMarks', () => {
  it('v3 的片头/片尾双标记转成 opening + ending', () => {
    const result = migrateSkipMarks({
      't:abc': { introEnd: 45, outroStart: 1200, updatedAt: 111 },
    });
    expect(result['t:abc']).toEqual({
      segments: [
        { type: 'opening', start: 0, end: 45 },
        { type: 'ending', start: 1200, end: -1 },
      ],
      enabled: true,
      updatedAt: 111,
    });
  });

  it('只有单边字段时只生成对应片段', () => {
    expect(migrateSkipMarks({ 't:a': { introEnd: 45, updatedAt: 1 } })['t:a']?.segments).toEqual([
      { type: 'opening', start: 0, end: 45 },
    ]);
    expect(migrateSkipMarks({ 't:b': { outroStart: 1200, updatedAt: 1 } })['t:b']?.segments).toEqual([
      { type: 'ending', start: 1200, end: -1 },
    ]);
  });

  it('已是 segments 结构直接保留', () => {
    const segments = [{ type: 'middle', start: 100, end: 200 }] as SkipSegment[];
    expect(migrateSkipMarks({ 't:x': { segments, updatedAt: 2 } })['t:x']).toEqual({
      segments,
      enabled: true,
      updatedAt: 2,
    });
  });

  it('缺省 enabled 视为开启，显式 false 时保留', () => {
    expect(migrateSkipMarks({ 't:a': { introEnd: 20 } })['t:a']?.enabled).toBe(true);
    expect(
      migrateSkipMarks({ 't:b': { segments: [], enabled: false, updatedAt: 1 } })['t:b']?.enabled
    ).toBe(false);
  });

  it('损坏条目丢弃，其余正常迁移', () => {
    const result = migrateSkipMarks({
      bad1: null,
      bad2: 'oops',
      bad3: 123,
      good: { introEnd: 30, updatedAt: 5 },
    });
    expect(Object.keys(result)).toEqual(['good']);
    expect(result.good?.segments).toEqual([{ type: 'opening', start: 0, end: 30 }]);
  });

  it('非对象输入返回空对象', () => {
    expect(migrateSkipMarks(undefined)).toEqual({});
    expect(migrateSkipMarks(null)).toEqual({});
    expect(migrateSkipMarks([])).toEqual({});
    expect(migrateSkipMarks('x')).toEqual({});
  });

  it('segments 里的损坏条目逐条剔除（面板会直接渲染原始列表）', () => {
    const result = migrateSkipMarks({
      't:a': {
        segments: [
          { type: 'middle', start: 100, end: 200 },
          { type: 'unknown', start: 1, end: 2 },
          { type: 'opening', start: 0, end: Number.NaN },
          null,
          'x',
        ],
        updatedAt: 1,
      },
    });
    expect(result['t:a']?.segments).toEqual([{ type: 'middle', start: 100, end: 200 }]);
  });

  it('缺失 updatedAt 时补当前时间', () => {
    expect(migrateSkipMarks({ 't:a': { introEnd: 20 } })['t:a']?.updatedAt).toBeGreaterThan(0);
  });

  it('保留片尾的 tail；非法 tail 与片头/中段身上的 tail 一律丢弃，退回绝对起点', () => {
    const result = migrateSkipMarks({
      't:a': {
        segments: [
          { type: 'ending', start: 1590, end: -1, tail: 30 },
          { type: 'ending', start: 1590, end: -1, tail: 0 },
          { type: 'ending', start: 1590, end: -1, tail: '-30' },
          { type: 'opening', start: 0, end: 45, tail: 30 },
        ],
        updatedAt: 1,
      },
    });
    expect(result['t:a']?.segments).toEqual([
      { type: 'ending', start: 1590, end: -1, tail: 30 },
      { type: 'ending', start: 1590, end: -1 },
      { type: 'ending', start: 1590, end: -1 },
      { type: 'opening', start: 0, end: 45 },
    ]);
  });
});

describe('resolveSegments', () => {
  it('合法片段按 start 升序返回，ending 的 end 用时长填充', () => {
    expect(
      resolveSegments(
        mark(
          { type: 'ending', start: 1200, end: -1 },
          { type: 'opening', start: 0, end: 45 },
          { type: 'middle', start: 500, end: 530 }
        ),
        2400
      )
    ).toEqual([
      { type: 'opening', start: 0, end: 45 },
      { type: 'middle', start: 500, end: 530 },
      { type: 'ending', start: 1200, end: 2400 },
    ]);
  });

  it('空标记、时长缺失或非法时返回空列表', () => {
    expect(resolveSegments(undefined, 2400)).toEqual([]);
    expect(resolveSegments(mark(), 0)).toEqual([]);
    expect(resolveSegments(mark(), Number.NaN)).toEqual([]);
  });

  it('本剧总开关关闭时一律返回空列表（标记保留但不生效）', () => {
    expect(
      resolveSegments({ ...mark({ type: 'opening', start: 0, end: 45 }), enabled: false }, 2400)
    ).toEqual([]);
  });

  it('越界/过短的片段被逐项剔除', () => {
    // 片头 < 3s
    expect(resolveSegments(mark({ type: 'opening', start: 0, end: 2 }), 2400)).toEqual([]);
    // 片尾贴结尾
    expect(resolveSegments(mark({ type: 'ending', start: 2399, end: -1 }), 2400)).toEqual([]);
    // 中段终点贴结尾
    expect(resolveSegments(mark({ type: 'middle', start: 2300, end: 2400 }), 2400)).toEqual([]);
  });

  it('重叠或过近时保留靠前者、丢弃后者', () => {
    const a: SkipSegment = { type: 'middle', start: 100, end: 200 };
    const b: SkipSegment = { type: 'middle', start: 100 + MIN_SEGMENT_GAP_SECONDS - 1, end: 300 };
    expect(resolveSegments(mark(a, b), 2400)).toEqual([{ ...a }]);
  });

  it('损坏的持久化数据（负数/NaN/类型不对）不会抛错', () => {
    expect(
      resolveSegments(
        {
          segments: [{ type: 'middle', start: -5, end: Number.NaN } as unknown as SkipSegment],
          enabled: true,
          updatedAt: 0,
        },
        2400
      )
    ).toEqual([]);
  });
});

describe('findActiveSegment', () => {
  const segments = resolveSegments(mark({ type: 'opening', start: 0, end: 45 }), 2400);

  it('区间内命中，收尾余量内不命中', () => {
    expect(findActiveSegment(segments, 0)?.type).toBe('opening');
    expect(findActiveSegment(segments, 43.5)?.type).toBe('opening');
    expect(findActiveSegment(segments, 44.5)).toBeUndefined(); // 距末尾 0.5s
    expect(findActiveSegment(segments, 45)).toBeUndefined();
  });

  it('非法位置或空列表返回 undefined', () => {
    expect(findActiveSegment(segments, Number.NaN)).toBeUndefined();
    expect(findActiveSegment([], 10)).toBeUndefined();
  });
});

describe('findCrossedEnding', () => {
  const segments = resolveSegments(mark({ type: 'ending', start: 1200, end: -1 }), 2400);

  it('连续小步前进越过片尾起点才触发', () => {
    expect(findCrossedEnding(segments, 1199.5, 1200.25)).toBe(true);
    expect(findCrossedEnding(segments, 1200.2, 1201)).toBe(false); // 已经越过
    expect(findCrossedEnding(segments, 1199.5, 1199.9)).toBe(false); // 尚未到达
    expect(findCrossedEnding(segments, 1201, 1200.5)).toBe(false); // 倒退
  });

  it('大跨度拖动/进度恢复不触发自动结束', () => {
    expect(findCrossedEnding(segments, 0, 1300)).toBe(false);
    expect(findCrossedEnding(segments, 1190, 1200 + MAX_CONTINUOUS_STEP_SECONDS)).toBe(false);
  });

  it('无结尾片段或时间非法时为假', () => {
    const noEnding = resolveSegments(mark({ type: 'opening', start: 0, end: 45 }), 2400);
    expect(findCrossedEnding(noEnding, 1199, 1201)).toBe(false);
    expect(findCrossedEnding(segments, Number.NaN, 1201)).toBe(false);
  });
});

describe('validateSegment', () => {
  it('接受合理的片头/片尾/中段', () => {
    expect(validateSegment({ type: 'opening', start: 0, end: 30 }, 2400)).toBeNull();
    expect(validateSegment({ type: 'ending', start: 1200, end: -1 }, 2400)).toBeNull();
    expect(validateSegment({ type: 'middle', start: 500, end: 530 }, 2400)).toBeNull();
  });

  it('拒绝过短、非法与贴结尾的片段', () => {
    expect(validateSegment({ type: 'opening', start: 0, end: 2 }, 2400)).not.toBeNull();
    expect(validateSegment({ type: 'middle', start: 500, end: 501 }, 2400)).not.toBeNull();
    expect(validateSegment({ type: 'middle', start: Number.NaN, end: 500 }, 2400)).not.toBeNull();
    expect(validateSegment({ type: 'ending', start: 2399, end: -1 }, 2400)).not.toBeNull();
  });

  it('opening 起点必须为 0，ending 无需指定终点', () => {
    expect(validateSegment({ type: 'opening', start: 5, end: 30 }, 2400)).not.toBeNull();
    expect(validateSegment({ type: 'ending', start: 1200, end: 1300 }, 2400)).not.toBeNull();
  });

  it('与已有片段重叠或过近时拒绝，刚好够间隔时接受', () => {
    const existing = [{ type: 'middle', start: 500, end: 530 } as SkipSegment];
    expect(validateSegment({ type: 'middle', start: 520, end: 560 }, 2400, existing)).not.toBeNull();
    expect(
      validateSegment({ type: 'middle', start: 530 + MIN_SEGMENT_GAP_SECONDS - 1, end: 600 }, 2400, existing)
    ).not.toBeNull();
    expect(
      validateSegment({ type: 'middle', start: 530 + MIN_SEGMENT_GAP_SECONDS, end: 600 }, 2400, existing)
    ).toBeNull();
  });
});

describe('withEndingTail', () => {
  it('记录片尾时换算出「距结尾多长」：27 分钟那集在 26:30 按下 = 最后 30 秒', () => {
    expect(withEndingTail({ type: 'ending', start: 1590, end: -1 }, 1620)).toEqual({
      type: 'ending',
      start: 1590,
      end: -1,
      tail: 30,
    });
  });

  it('片头/中段原样返回；时长未知或起点已在结尾之后时不换算', () => {
    const opening: SkipSegment = { type: 'opening', start: 0, end: 45 };
    expect(withEndingTail(opening, 1620)).toBe(opening);
    const seg: SkipSegment = { type: 'ending', start: 1590, end: -1 };
    expect(withEndingTail(seg, 0)).toBe(seg);
    expect(withEndingTail(seg, Number.NaN)).toBe(seg);
    expect(withEndingTail({ type: 'ending', start: 1600, end: -1 }, 1600)).toEqual({
      type: 'ending',
      start: 1600,
      end: -1,
    });
  });
});

describe('片尾按距结尾长度倒算', () => {
  // 27 分钟（1620s）那一集的 26:30 记录的 30 秒片尾
  const tailMark = mark({ type: 'ending', start: 1590, end: -1, tail: 30 });

  it('26 分钟的下一集从 25:30 起跳，而不是整条标记失效', () => {
    expect(resolveSegments(tailMark, 1560)).toEqual([{ type: 'ending', start: 1530, end: 1560 }]);
  });

  it('30 分钟的下一集从 29:30 起跳，而不是一路多跳 3 分半', () => {
    expect(resolveSegments(tailMark, 1800)).toEqual([{ type: 'ending', start: 1770, end: 1800 }]);
  });

  it('倒算出的起点同样只在连续越过时结束本集', () => {
    const segments = resolveSegments(tailMark, 1560);
    expect(findCrossedEnding(segments, 1529.5, 1530.25)).toBe(true);
    expect(findCrossedEnding(segments, 1520, 1530.25)).toBe(false); // 大跨度 seek
  });

  it('长度超过本集时长上限时整条不生效：宁可不跳，也不切掉大半集正片', () => {
    const seg: SkipSegment = { type: 'ending', start: 1500, end: -1, tail: 120 };
    expect(endingTailSeconds(seg)).toBe(120);
    const twoMinutes = mark(seg);
    // 120s 对 30 分钟只是 6.7%，对 8 分钟正好卡在上限（25%），对 5 分钟特辑就是 40%
    expect(resolveSegments(twoMinutes, 1800)).toHaveLength(1);
    expect(resolveSegments(twoMinutes, 480)).toHaveLength(1);
    expect(resolveSegments(twoMinutes, 300)).toEqual([]);
  });

  it('长度过短（没有跳过价值）时不生效', () => {
    expect(resolveSegments(mark({ type: 'ending', start: 100, end: -1, tail: 2 }), 1620)).toEqual([]);
  });

  it('上限边界取「等于」：正好等于比例的长尾仍然生效', () => {
    const duration = 1000;
    const limit = duration * MAX_ENDING_TAIL_RATIO;
    const atLimit: SkipSegment = { type: 'ending', start: duration - limit, end: -1, tail: limit };
    expect(resolveSegments(mark(atLimit), duration)).toHaveLength(1);
    expect(resolveSegments(mark({ ...atLimit, tail: limit + 0.1 }), duration)).toEqual([]);
  });

  it('历史「绝对起点」片尾保持旧语义：等长/更长的集照常，短集不生效', () => {
    const legacy = mark({ type: 'ending', start: 1590, end: -1 });
    expect(resolveSegments(legacy, 1620)).toEqual([{ type: 'ending', start: 1590, end: 1620 }]);
    expect(resolveSegments(legacy, 1800)).toEqual([{ type: 'ending', start: 1590, end: 1800 }]);
    expect(resolveSegments(legacy, 1560)).toEqual([]);
  });

  it('tail 损坏（0/负数/NaN/字符串）时退回绝对起点，不抛错', () => {
    const resolvedWith = (tail: unknown) =>
      resolveSegments(mark({ type: 'ending', start: 1000, end: -1, tail } as SkipSegment), 1620);
    const legacy = [{ type: 'ending', start: 1000, end: 1620 }];
    expect(resolvedWith(0)).toEqual(legacy);
    expect(resolvedWith(-30)).toEqual(legacy);
    expect(resolvedWith(Number.NaN)).toEqual(legacy);
    expect(resolvedWith('30')).toEqual(legacy);
  });

  it('resolveSegment 在时长未知时不解析（面板据此退回记录值展示）', () => {
    expect(resolveSegment({ type: 'ending', start: 1590, end: -1, tail: 30 }, 0)).toBeNull();
    expect(resolveSegment({ type: 'middle', start: 100, end: 200 }, Number.NaN)).toBeNull();
    expect(resolveSegment({ type: 'middle', start: 100, end: 200 }, 2400)).toEqual({
      type: 'middle',
      start: 100,
      end: 200,
    });
  });
});

describe('nudgeSegment', () => {
  it('片头调终点、中段整段平移', () => {
    expect(nudgeSegment({ type: 'opening', start: 0, end: 45 }, 1, 1620)).toEqual({
      type: 'opening',
      start: 0,
      end: 46,
    });
    expect(nudgeSegment({ type: 'middle', start: 500, end: 530 }, -1, 1620)).toEqual({
      type: 'middle',
      start: 499,
      end: 529,
    });
  });

  it('片尾边界推后 1 秒 = 长度少 1 秒，起点同步平移（start + tail 不变）', () => {
    const seg: SkipSegment = { type: 'ending', start: 1590, end: -1, tail: 30 };
    expect(nudgeSegment(seg, 1, 1620)).toEqual({ type: 'ending', start: 1591, end: -1, tail: 29 });
    expect(nudgeSegment(seg, -1, 1620)).toEqual({ type: 'ending', start: 1589, end: -1, tail: 31 });
  });

  it('历史绝对起点片尾：有时长可参照时顺手换算成距结尾长度', () => {
    expect(nudgeSegment({ type: 'ending', start: 1590, end: -1 }, -1, 1620)).toEqual({
      type: 'ending',
      start: 1589,
      end: -1,
      tail: 31,
    });
  });

  it('时长未知时无法换算，只能继续改绝对起点', () => {
    expect(nudgeSegment({ type: 'ending', start: 1590, end: -1 }, 1, 0)).toEqual({
      type: 'ending',
      start: 1591,
      end: -1,
    });
  });
});

describe('validateSegment 的片尾长度', () => {
  it('接受合理长度，拒绝过短、超过上限与非法值', () => {
    expect(validateSegment({ type: 'ending', start: 1590, end: -1, tail: 30 }, 1620)).toBeNull();
    expect(validateSegment({ type: 'ending', start: 1590, end: -1, tail: 2 }, 1620)).not.toBeNull();
    expect(validateSegment({ type: 'ending', start: 1500, end: -1, tail: 120 }, 300)).not.toBeNull();
    expect(validateSegment({ type: 'ending', start: 1590, end: -1, tail: Number.NaN }, 1620)).not.toBeNull();
    expect(validateSegment({ type: 'ending', start: 1590, end: -1, tail: 0 }, 1620)).not.toBeNull();
  });

  it('时长未知时不做长度上限校验（写入前会再换算一次）', () => {
    expect(validateSegment({ type: 'ending', start: 1590, end: -1, tail: 30 }, 0)).toBeNull();
  });

  it('与其它片段的重叠判定用「本集解析后的区间」', () => {
    const existing: SkipSegment[] = [{ type: 'ending', start: 1590, end: -1, tail: 30 }];
    // 本集 26 分钟 → 片尾起点是 25:30（1530s），不是记录那集的 26:30
    expect(validateSegment({ type: 'middle', start: 1520, end: 1535 }, 1560, existing)).not.toBeNull();
    expect(validateSegment({ type: 'middle', start: 1490, end: 1524 }, 1560, existing)).toBeNull();
  });
});
