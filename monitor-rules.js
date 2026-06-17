const KEYWORDS = ["吉比特", "雷霆游戏"];

const TOPIC_RULES = [
  ["企业文化", ["年终奖","千万房产","豪宅","iPhone","重奖","福利","氛围","梦中情司","清流","加班","压榨","996","双休","食堂","团建","画饼","奋斗","幸福感","壕"]],
  ["理念价值观", ["理念","价值观","高风险高回报","内容开发","初心","长期主义","精品","坚持","使命","愿景","格局","创始人","CEO说","老板说"]],
  ["经营管理", ["管理","战略","版号","布局","组织","决策","转型","裁撤","架构","KPI","考核","收购","投资团队","初创","子公司","股权","治理"]],
  ["产品游戏", ["一念逍遥","问道","奥比岛","摩尔庄园","杖剑传说","地下城堡","跨越星弧","魂之诗","新游","上线","流水","玩法","版本","代理","发行","买量","手游","制作人大赛","开罗"]],
  ["招聘求职", ["招聘","校招","秋招","春招","内推","面经","凉经","实习","offer","薪资","岗位","HC","求职","入职","面试","笔试"]],
  ["股票财务", ["股价","股票","市值","分红","派现","财报","研报","净利","营收","涨停","跌停","机构","估值","603444","业绩","回购","增持","减持","一季报","年报","翻倍","新股王","茅台"]],
];

// ===== 本品牌判定（舆情，section="舆情"）=====
const BRAND_HINTS = ["吉比特","雷霆游戏","雷霆网络","G-bits","603444","一念逍遥","问道","奥比岛","摩尔庄园","M72"];

function isRelevant(text) {
  const t = String(text || "");
  return BRAND_HINTS.some((b) => t.includes(b));
}

// ===== 游戏行业判定（行业动态，section="行业"）=====
// 三段式：命中行业实体词直接收；否则要"事件词 + 游戏上下文词"同时满足，避免泛词灌噪。
// 实体词：主要厂商 / 平台 / 数据机构 / 监管口（提到这些基本就是行业新闻）。
const INDUSTRY_ENTITY_HINTS = [
  "腾讯游戏","网易游戏","米哈游","三七互娱","完美世界","恺英网络","心动公司","世纪华通",
  "叠纸游戏","莉莉丝","IGG","巨人网络","祖龙娱乐","百奥家庭互动","点点互动","Nexon",
  "B站游戏","TapTap","Steam","App Store","Google Play","Epic",
  "伽马数据","Sensor Tower","七麦","点点数据","data.ai",
  "国家新闻出版署","版署","游戏工委","游戏早参",
];
// 事件词：行业里"正在发生什么"。去掉纯财务词（回购/收入/业绩/财报/上市/并购等），
// 因为游戏板块的股票行情、港股回购一览会带这些词+"游戏"上下文，造成大量金融噪音误收。
const INDUSTRY_EVENT_HINTS = [
  "版号","新游","公测","内测","首发","预约","上线","停服","停运","合服","关服",
  "出海","买量","投放","联运","代理","流水","畅销榜","免费榜",
  "裁员","扩编","侵权","过审","获批","定档","制作人","研发","立项",
];
// 上下文词：把事件锚定在"游戏"语境，过滤掉同词不同义（如"电影上线""饮料上线""出海过周末"）。
const INDUSTRY_CONTEXT_HINTS = [
  "游戏","手游","端游","网游","页游","二次元","厂商","发行商","赛道","玩家","电竞","主机","单机",
];
// 噪音排除：标题命中这些（金融行情/泛财经/无关领域）直接丢，优先级高于行业判定。
const INDUSTRY_NOISE_HINTS = [
  "ETF","指数","基金","回购","增持","减持","斥资","派现","分红","龙虎榜","涨停板","跌停",
  "评级","研报","目标价","北向资金","沪深","成交额","市值","机构调研","定增","可转债",
  "资金流出","资金流入","传媒股","股东","亿元资金","港股公司","财经早参","半导体","软信业",
  "出入境","通行证","研学","旅游","文旅","饮料","票房",
];

function isIndustryNoise(title) {
  const t = String(title || "");
  return INDUSTRY_NOISE_HINTS.some((h) => t.includes(h));
}

function isIndustryRelevant(text) {
  const t = String(text || "");
  if (INDUSTRY_ENTITY_HINTS.some((h) => t.includes(h))) return true;
  const hasEvent = INDUSTRY_EVENT_HINTS.some((h) => t.includes(h));
  const hasContext = INDUSTRY_CONTEXT_HINTS.some((h) => t.includes(h));
  return hasEvent && hasContext;
}

function isMeaningfulTitle(title) {
  const t = String(title || "").trim();
  if (t.length < 6) return false;
  if (KEYWORDS.includes(t)) return false;
  if (/^(知乎|专栏|话题|游戏行业|游戏版号|版号)$/.test(t)) return false;
  return true;
}

module.exports = {
  BRAND_HINTS,
  INDUSTRY_ENTITY_HINTS,
  INDUSTRY_EVENT_HINTS,
  INDUSTRY_CONTEXT_HINTS,
  INDUSTRY_NOISE_HINTS,
  KEYWORDS,
  TOPIC_RULES,
  isMeaningfulTitle,
  isRelevant,
  isIndustryRelevant,
  isIndustryNoise,
};
