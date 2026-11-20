export const localCostItems = [
  {id: 'lodging', label: '住宿', amount: 240},
  {id: 'food', label: '餐饮', amount: 120},
  {id: 'transfer', label: '市内交通', amount: 80},
  {id: 'tickets', label: '景点门票', amount: 80},
];

export function weekendCost(values, transport) {
  const amounts = localCostItems.map(({id}) => values[id]);
  if (amounts.some(value => !/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) > 50000)) return null;
  const localCents = amounts.reduce((total, value) => total + Math.round(Number(value) * 100), 0);
  return {
    local: localCents / 100,
    total: Number.isFinite(transport) && transport >= 0 ? (Math.round(transport * 100) + localCents) / 100 : null,
  };
}

const regions = {
  altay: '阿勒泰市', jiuzhaigou: '九寨沟县', jinghong: '西双版纳傣族自治州',
  shangrila: '香格里拉市', enshi: '恩施土家族苗族自治州',
};

const stopAliases = {
  xiamen: {'八市': '厦门第八市场', '白城沙滩': '厦大白城沙滩'},
  dali: {'人民路': '大理古城人民路'},
  huangshan: {'汤口换乘中心': '黄山风景区南大门换乘中心', '玉屏索道': '黄山玉屏索道'},
  zhangjiajie: {'武陵源镇': '武陵源城区', '武陵源东门': '张家界国家森林公园标志门',
    '武陵源南门': '张家界国家森林公园南门', '市区索道下站': '天门山索道下站'},
};

const flexibleStops = /^(?:桂林米粉|住宿.*|市区(?:市场|街巷|河岸))|或/;

export function guideMapLink(city, from, to, hint = '') {
  const alias = stop => stopAliases[city.id]?.[stop] ?? stop.replace(/(?:周边|外围|附近)$/, '');
  const region = regions[city.id] ?? city.city;
  const [origin, destination] = [alias(from), alias(to)];
  const params = new URLSearchParams({region, output: 'html', src: 'webapp.weekendaway.guide'});
  const flexibleFrom = flexibleStops.test(from);
  const flexibleTo = flexibleStops.test(to);
  if (flexibleFrom || flexibleTo) {
    const query = flexibleFrom && flexibleTo ? city.landmark : flexibleFrom ? destination : origin;
    params.set('query', query);
    return {url: 'https://api.map.baidu.com/place/search?' + params, label: `地图定位：${query}`};
  }

  const distance = hint.match(/(\d+(?:\.\d+)?)\s*(公里|米)/);
  const shortDistance = distance && Number(distance[1]) <= (distance[2] === '米' ? 2000 : 2);
  const hasTransfer = /跨江|轮渡|景区车|接驳|索道|天梯|岛内车/.test(hint);
  const walking = !hasTransfer && (shortDistance || /同一|相邻|邻近|步行/.test(hint));
  params.set('mode', walking ? 'walking' : 'transit');
  params.set('origin', city.id === 'xiamen' && from === '鼓浪屿' ? '三丘田码头' : origin);
  params.set('destination', city.id === 'xiamen' && to === '环岛路'
    ? (from === '白城沙滩' ? '胡里山炮台' : '厦大白城沙滩')
    : destination);
  return {url: 'https://api.map.baidu.com/direction?' + params, label: `地图路线：${from}到${to}`};
}
