const qunar = 'https://travelnews.qunar.com/';
const common = ['鼓浪屿', '八市', '中山路', '沙坡尾', '环岛路'];

export const cityGuides = {
  xiamen: {
    platform: '去哪儿',
    sources: [
      ['厦门两日步行路线', 'ugc/xiamen-2-day-walking-route', [...common, '南普陀寺', '白城沙滩']],
      ['沙坡尾和鼓浪屿先去哪个', 'ugc/xiamen-two-day-route-order', common],
      ['厦门两天一夜怎么玩', 'qa_strategy/xiamen-two-day-one-night-travel-guide-7', [...common, '南普陀寺']],
      ['厦门两天一夜路线怎么排', 'qa_strategy/xiamen-two-day-one-night-travel-itinerary', [...common, '南普陀寺', '白城沙滩']],
    ].map(([title, path, stops]) => ({title, url: qunar + path, stops})),
    days: [
      {title:'海岛与老城', stops:['鼓浪屿','八市','中山路'], tip:'上午坐船上鼓浪屿，逛龙头路和老别墅；下午回岛内去八市吃小吃，傍晚沿中山路逛骑楼。'},
      {title:'寺院与海岸', stops:['南普陀寺','沙坡尾','环岛路'], tip:'上午逛南普陀寺，再去沙坡尾看避风坞；下午从白城沙滩起步，沿环岛路走一段，按返程时间提前收尾。'},
    ],
    notes: '住宿可选中山路或镇海路一带。若周六下午才到，可先逛八市和中山路，第二天优先去鼓浪屿，再按返程时间选一个海边点。',
    travelLink: {title:'厦门轮渡：游客乘船指南', url:'https://m.xmferry.com/wx/hbjgd/index.htm'},
  },
};

export function stopMentions(guide, stop) {
  return guide.sources.filter(source => source.stops.includes(stop)).length;
}
