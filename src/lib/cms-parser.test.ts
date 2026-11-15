import { describe, expect, it } from 'vitest';
import {
  extractEpisodesFromPlayUrl,
  extractEpisodeItemsFromPlayUrl,
  extractM3u8FromText,
  filterAdultResults,
  filterRelevantResults,
  isAdultContent,
  isMovieType,
  isRelevant,
  normalizeTitle,
  parseDetail,
  cmsDescriptionToText,
  parseDetailPageHtml,
  parseSearchList,
} from './cms-parser';

const source = { key: 'test', name: '测试源', url: 'https://api.example.com/provide/vod' };

describe('parseSearchList', () => {
  it('解析标准搜索响应并补齐源信息', () => {
    const data = {
      list: [
        { vod_id: 123, vod_name: '流浪地球', vod_pic: 'https://img/a.jpg', type_name: '科幻', vod_year: '2019', vod_remarks: 'HD' },
        { vod_id: 'abc-1', vod_name: '探<script>' },
      ],
    };
    const items = parseSearchList(data, source);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sourceKey: 'test', sourceName: '测试源', vodId: '123', name: '流浪地球',
      typeName: '科幻', year: '2019', remarks: 'HD', sourceUrl: source.url,
    });
    expect(items[1].vodId).toBe('abc-1');
  });

  it('对缺失字段健壮', () => {
    const items = parseSearchList({ list: [{}] }, source);
    expect(items[0].vodId).toBe('');
    expect(items[0].name).toBe('');
  });

  it('拒绝无效响应；list 缺失或 null 视为空结果', () => {
    expect(() => parseSearchList(null, source)).toThrow();
    expect(() => parseSearchList({ list: 'nope' }, source)).toThrow();
    // 部分源站无结果时返回 list: null（或缺失），按空结果兼容
    expect(parseSearchList({ list: null }, source)).toEqual([]);
    expect(parseSearchList({}, source)).toEqual([]);
  });
});

describe('extractEpisodeItemsFromPlayUrl', () => {
  it('保留 CMS 提供的真实集数名称，并与播放器 URL 列表保持一致', () => {
    const dollar = String.fromCharCode(36);
    const play = '第01集' + dollar + 'https://cdn/a1.m3u8#特别篇' + dollar + 'https://cdn/a2.m3u8' + dollar.repeat(3) + '备用' + dollar + 'https://x/b.m3u8';
    expect(extractEpisodeItemsFromPlayUrl(play)).toEqual([
      { title: '第01集', url: 'https://cdn/a1.m3u8' },
      { title: '特别篇', url: 'https://cdn/a2.m3u8' },
    ]);
    expect(extractEpisodesFromPlayUrl(play)).toEqual(extractEpisodeItemsFromPlayUrl(play).map((item) => item.url));
  });
});

describe('extractEpisodesFromPlayUrl', () => {
  it('解析 源$$$源 与 集$URL#集$URL 结构', () => {
    const play = '第01集$https://cdn/a1.m3u8#第02集$https://cdn/a2.m3u8$$$备用$https://x/b.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual([
      'https://cdn/a1.m3u8',
      'https://cdn/a2.m3u8',
    ]);
  });

  it('过滤无 URL 或非 http 的集', () => {
    const play = '第01集$#第02集$ftp://x#第03集$https://cdn/a3.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/a3.m3u8']);
  });

  it('第一条线路为中转页时优先取 m3u8 线路（量子/非凡类源）', () => {
    const play =
      'HD中字$https://vip.lzcdn2.com/share/abc$$$HD中字$https://vip.lzcdn2.com/20220329/1012_e9be6a92/index.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual([
      'https://vip.lzcdn2.com/20220329/1012_e9be6a92/index.m3u8',
    ]);
  });

  it('第一条线路为空时取后续有效线路', () => {
    const play = '第1集$$$第1集$https://cdn/b.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/b.m3u8']);
  });

  it('两条线路均无 m3u8 时回退第一条', () => {
    const play = '第1集$https://cdn/a.mp4$$$第1集$https://cdn2/a.mp4';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/a.mp4']);
  });

  it('空输入返回空数组', () => {
    expect(extractEpisodesFromPlayUrl('')).toEqual([]);
  });
});

describe('extractM3u8FromText', () => {
  it('从简介中提取 m3u8 链接', () => {
    const text = '正片$https://cdn.com/x/index.m3u8 更多';
    expect(extractM3u8FromText(text)).toEqual(['https://cdn.com/x/index.m3u8']);
  });
});

describe('parseDetail', () => {
  it('解析详情并提取分集', () => {
    const data = {
      list: [{
        vod_id: 1, vod_name: '三体', vod_content: '科幻剧',
        vod_play_url: '第1集$https://cdn/1.m3u8#第2集$https://cdn/2.m3u8',
      }],
    };
    const detail = parseDetail(data, source);
    expect(detail.episodes).toHaveLength(2);
    expect(detail.episodeItems).toEqual([
      { title: '第1集', url: 'https://cdn/1.m3u8' },
      { title: '第2集', url: 'https://cdn/2.m3u8' },
    ]);
    expect(detail.videoInfo.title).toBe('三体');
    expect(detail.videoInfo.sourceName).toBe('测试源');
  });

  it('仅将按 URL 精确匹配的单集 still_path / 截图字段作为剧照', () => {
    const data = {
      list: [{
        vod_name: '测试剧',
        vod_pic: 'https://img.example.com/title-poster.jpg',
        vod_play_url: '第1集$https://media.example.com/ep1.m3u8#第2集$https://media.example.com/ep2.m3u8#第3集$https://media.example.com/ep3.m3u8',
        vod_episode_list: [
          {
            url: 'https://media.example.com/ep1.m3u8',
            still_path: 'https://img.example.com/ep1-still.jpg',
            episode_name: '試播集',
            image_captured_at: '2026-11-12T09:30:00Z',
            description: '<p>第一集简介</p>',
            duration: '45分钟',
          },
          {
            url: 'https://media.example.com/ep2.m3u8',
            still_path: '/episode-2-still.jpg',
            description: '第二集简介',
          },
          {
            url: 'https://media.example.com/wrong-episode.m3u8',
            still_path: 'https://img.example.com/wrong-still.jpg',
            description: '不属于第三集',
          },
        ],
      }],
    };
    const detail = parseDetail(data, source);
    expect(detail.episodeItems?.[0]).toMatchObject({
      title: '第1集',
      url: 'https://media.example.com/ep1.m3u8',
      image: 'https://img.example.com/ep1-still.jpg',
      imageSourceUrl: 'https://img.example.com/ep1-still.jpg',
      imageSourceEpisodeUrl: 'https://media.example.com/ep1.m3u8',
      episodeName: '試播集',
      description: '第一集简介',
      duration: '45分钟',
      imageCapturedAt: '2026-11-12T09:30:00Z',
    });
    expect(detail.episodeItems?.[1]).toMatchObject({
      title: '第2集',
      url: 'https://media.example.com/ep2.m3u8',
      image: 'https://image.tmdb.org/t/p/w500/episode-2-still.jpg',
      imageSourceUrl: 'https://image.tmdb.org/t/p/w500/episode-2-still.jpg',
      imageSourceEpisodeUrl: 'https://media.example.com/ep2.m3u8',
      description: '第二集简介',
    });
    // A mismatched episode record and the title-level vod_pic must never become episode 3 artwork.
    expect(detail.episodeItems?.[2]).toEqual({
      title: '第3集',
      url: 'https://media.example.com/ep3.m3u8',
    });
  });

  it('play_url 为空时从简介兜底', () => {
    const data = { list: [{ vod_name: 'X', vod_content: '$https://cdn/fall.m3u8' }] };
    const detail = parseDetail(data, source);
    expect(detail.episodes).toEqual(['https://cdn/fall.m3u8']);
  });

  it('空列表抛错', () => {
    expect(() => parseDetail({ list: [] }, source)).toThrow();
  });
});

describe('电影类型识别与 CMS 简介清理', () => {
  it.each(['动作片', '喜剧片', '科幻片', '爱情片', '恐怖片', '剧情片'])('把 %s 等 Apple CMS 电影分类识别为电影', (typeName) => {
    expect(isMovieType(typeName, 1)).toBe(true);
  });

  it.each(['电视剧', '连续剧', '动漫', '番剧', '综艺'])('保留 %s 的分集展示', (typeName) => {
    expect(isMovieType(typeName, 12)).toBe(false);
  });

  it('未知分类根据播放地址数量安全回退', () => {
    expect(isMovieType('其他分类', 1)).toBe(true);
    expect(isMovieType('其他分类', 8)).toBe(false);
  });

  it('移除简介中的 HTML、脚本和样式，并解码常见实体', () => {
    expect(cmsDescriptionToText('<p>简介&nbsp;内容</p><script>alert(1)</script><b>科幻&amp;冒险</b>'))
      .toBe('简介 内容\n科幻&冒险');
    expect(cmsDescriptionToText('普通文本')).toBe('普通文本');
  });
});

describe('parseDetailPageHtml', () => {
  it('从 HTML 中提取去重后的 m3u8', () => {
    const html = `<h1>庆余年</h1>
      <div class="sketch">简介<b>内容</b></div>
      <script>player_aa={"url":"$https://cdn/ep1.m3u8"}</script>
      <script>player_bb={"url":"$https://cdn/ep2.m3u8"}</script>
      <script>player_cc={"url":"$https://cdn/ep1.m3u8"}</script>`;
    const detail = parseDetailPageHtml(html, source);
    expect(detail.episodes).toEqual(['https://cdn/ep1.m3u8', 'https://cdn/ep2.m3u8']);
    expect(detail.videoInfo.title).toBe('庆余年');
    expect(detail.videoInfo.desc).toBe('简介 内容');
  });

  it('非凡影视特征路径兜底', () => {
    const html = '$https://vip.ffzy.com/20231101/12345_abcdef/index.m3u8';
    const detail = parseDetailPageHtml(html, source);
    expect(detail.episodes).toContain('https://vip.ffzy.com/20231101/12345_abcdef/index.m3u8');
  });
});

describe('成人内容过滤', () => {
  it('识别敏感分类', () => {
    expect(isAdultContent('伦理片')).toBe(true);
    expect(isAdultContent('福利片')).toBe(true);
    expect(isAdultContent('科幻片')).toBe(false);
    expect(isAdultContent(undefined)).toBe(false);
  });

  it('filterAdultResults 按开关过滤', () => {
    const items = [{ typeName: '伦理片' }, { typeName: '剧情片' }];
    expect(filterAdultResults(items, true)).toEqual([{ typeName: '剧情片' }]);
    expect(filterAdultResults(items, false)).toHaveLength(2);
  });
});

describe('normalizeTitle', () => {
  it('去标点、空白并转小写', () => {
    expect(normalizeTitle('摔跤吧！爸爸')).toBe('摔跤吧爸爸');
    expect(normalizeTitle('摔跤吧!爸爸 【影视解说】')).toBe('摔跤吧爸爸影视解说');
    expect(normalizeTitle('Hello, World!')).toBe('helloworld');
  });
});

describe('isRelevant', () => {
  it('命中完整关键词（忽略标点差异）', () => {
    expect(isRelevant('摔跤吧！爸爸', '摔跤吧！爸爸')).toBe(true);
    expect(isRelevant('摔跤吧!爸爸【影视解说】', '摔跤吧！爸爸')).toBe(true);
    expect(isRelevant('摔跤吧 爸爸', '摔跤吧！爸爸')).toBe(true);
  });

  it('标题不含关键词时不相关（模糊分词场景）', () => {
    expect(isRelevant('爸爸去哪儿第三季', '摔跤吧！爸爸')).toBe(false);
    expect(isRelevant('爸爸当家 第五季', '摔跤吧！爸爸')).toBe(false);
  });

  it('子串命中视为相关', () => {
    expect(isRelevant('爸爸去哪儿第三季', '爸爸去哪儿')).toBe(true);
  });

  it('多词查询放宽为每个词都命中', () => {
    expect(isRelevant('钢铁侠', '钢铁侠 2008')).toBe(false);
    expect(isRelevant('钢铁侠 Iron Man 2008', '钢铁侠 2008')).toBe(true);
  });

  it.each([
    ['赛博朋克：边缘行者第二季', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者 2', '赛博朋克：边缘行者第二季'],
    ['赛博朋克：边缘行者第2季', '赛博朋克：边缘行者第二季'],
    ['示例剧 第十二季', '示例剧 12'],
    ['示例剧 第二十季', '示例剧 第20季'],
    ['赛博朋克：边缘行者第二季 花絮', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第二季【影视解说】', '赛博朋克：边缘行者 2'],
  ])('匹配明确的季数别名：%s / %s', (name, query) => {
    expect(isRelevant(name, query)).toBe(true);
  });

  it.each([
    ['赛博朋克：边缘行者第三季', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第十二季', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第20季', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第十二季 花絮', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第20季【影视解说】', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者第二季', '赛博朋克：边缘行者第二季 花絮'],
    ['赛博朋克：边缘行者 20', '赛博朋克：边缘行者 2'],
    ['赛博朋克：边缘行者12', '赛博朋克：边缘行者 2'],
    ['电影2', '电影第二季'],
    ['钢铁侠 第二季', '钢铁侠 2008'],
    ['钢铁侠 12008', '钢铁侠 2008'],
    ['别的剧 第二季', '赛博朋克：边缘行者 2'],
    ['10月17日 足球联赛', '赛博朋克：边缘行者 2'],
  ])('拒绝无关标题、不同季数或数字的部分命中：%s / %s', (name, query) => {
    expect(isRelevant(name, query)).toBe(false);
  });

  it('查询侧的末尾数字可以没有空格：庆余年2 应命中第二季', () => {
    // 与「庆余年2」同构：用户很少在季数前敲空格，查询侧一律按季数理解。
    // 标题侧仍然要求空格（见上一条「电影2 / 电影第二季」），避免片名自带数字被误判。
    expect(isRelevant('庆余年第二季', '庆余年2')).toBe(true);
    expect(isRelevant('庆余年 第二季', '庆余年2')).toBe(true);
    expect(isRelevant('电影第二季', '电影2')).toBe(true);
  });

  it('空关键词不参与过滤，但空标题不能命中非空关键词', () => {
    expect(isRelevant('任意标题', '')).toBe(true);
    expect(isRelevant('', '任意')).toBe(false);
    expect(isRelevant(' ！ ', '任意')).toBe(false);
  });
});

describe('filterRelevantResults', () => {
  const wd = '摔跤吧！爸爸';
  const items = [
    { name: '摔跤吧！爸爸' },
    { name: '爸爸去哪儿第三季' },
    { name: '摔跤吧!爸爸【影视解说】' },
  ];

  it('丢弃与关键词无关的结果', () => {
    const out = filterRelevantResults(items, wd);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.name)).toEqual(['摔跤吧！爸爸', '摔跤吧!爸爸【影视解说】']);
  });

  it('全部不相关时返回空列表，不能把源站的默认目录当成搜索结果', () => {
    const junk = [{ name: '爸爸当家' }, { name: '爸爸别走' }];
    expect(filterRelevantResults(junk, wd)).toEqual([]);
  });

  it('过滤缺失标题，同时保留匹配的第二季而不保留无关体育目录', () => {
    const relevant = { name: '赛博朋克：边缘行者第二季' };
    expect(filterRelevantResults([
      { name: '10月17日 足球联赛' }, {}, { name: '' }, relevant,
    ], '赛博朋克：边缘行者 2')).toEqual([relevant]);
  });
});
