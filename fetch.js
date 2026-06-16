#!/usr/bin/env node
/**
 * 雷达站 · 舆情自动抓取脚本
 * 每天定时运行：从东方财富抓取「吉比特 / 雷霆游戏」相关新闻与公告，
 * 规则判定情绪，增量去重后写入 data.js，并可选推送飞书群机器人。
 * 用法：node fetch.js   （设置环境变量 LARK_WEBHOOK 后会自动推送飞书）
 */
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const DATA_FILE = path.join(DIR, "data.js");
const KEYWORDS = ["吉比特", "雷霆游戏"];
const STOCK = "603444";
const LARK_WEBHOOK = process.env.LARK_WEBHOOK || ""; // 设了才推送飞书
const SERPAPI_KEY = process.env.SERPAPI_KEY || ""; // 设了才抓社交站（SerpAPI 付费搜索，免费额度每月100次）
// 社交站配置：每站每天合并关键词抓 1 次。小红书 Google 不收录，抓不到，故不列入。
const SOCIAL_SITES = [
  { name:"知乎",  domain:"zhihu.com",   category:"社区讨论" },
  { name:"脉脉",  domain:"maimai.cn",   category:"招聘信息" },
  { name:"牛客",  domain:"nowcoder.com",category:"招聘信息" },
];
// 招聘相关词：用于把混进新闻/社区里的招聘内容也归到"招聘信息"
const RECRUIT_HINT = ["招聘","校招","秋招","春招","内推","HC","岗位","求职","面经","凉经","入职","offer","实习"];
// 给一条消息归类：财经新闻 / 公司公告 / 知乎 / 脉脉 / 牛客 / 小红书
// 财经新闻和公告按内容归类，社交平台直接按来源平台归类（保留来源辨识度）
function categorize(item){
  if(item.platform==="公司公告") return "公司公告";
  if(item.platform==="知乎") return "知乎";
  if(item.platform==="脉脉") return "脉脉";
  if(item.platform==="牛客") return "牛客";
  if(item.platform==="小红书") return "小红书";
  return "财经新闻";
}

// ===== 主题标签 topicize（横切维度，与来源 category 并行）=====
// 【重要】此块在 fetch.js / fetch-xhs.js / fetch-zhihu.js 三处各维护一份，改词表要同步三处！
// 按"讲什么内容"分 7 类，从专到泛、先命中先归类。无人值守关键词粗判，偶有误判可接受。
const TOPIC_RULES = [
  ["企业文化", ["年终奖","千万房产","豪宅","iPhone","重奖","福利","氛围","梦中情司","清流","加班","压榨","996","双休","食堂","团建","画饼","奋斗","幸福感","壕"]],
  ["理念价值观", ["理念","价值观","高风险高回报","内容开发","初心","长期主义","精品","坚持","使命","愿景","格局","创始人","CEO说","老板说"]],
  ["经营管理", ["管理","战略","版号","布局","组织","决策","转型","裁撤","架构","KPI","考核","收购","投资团队","初创","子公司","股权","治理"]],
  ["产品游戏", ["一念逍遥","问道","奥比岛","摩尔庄园","杖剑传说","地下城堡","跨越星弧","魂之诗","新游","上线","流水","玩法","版本","代理","发行","买量","手游","制作人大赛","开罗"]],
  ["招聘求职", ["招聘","校招","秋招","春招","内推","面经","凉经","实习","offer","薪资","岗位","HC","求职","入职","面试","笔试"]],
  ["股票财务", ["股价","股票","市值","分红","派现","财报","研报","净利","营收","涨停","跌停","机构","估值","603444","业绩","回购","增持","减持","一季报","年报","翻倍","新股王","茅台"]],
];
function topicize(item){
  const text = (item.title||"") + " " + (item.summary||"");
  for(const [topic, words] of TOPIC_RULES){
    if(words.some(w=>text.includes(w))) return topic;
  }
  return "公司综合"; // 兜底
}
// ===== topicize 结束 =====

// 社交站每天只抓 1 次以省额度（3 站 × 30 天 = 90 次/月，卡在免费 100 次内）。
// 设 FETCH_SOCIAL=1 的那次任务才抓社交站；不设则只抓新闻+公告（0 额度）。
const FETCH_SOCIAL = process.env.FETCH_SOCIAL === "1";

// ---- 情绪规则判定（脚本无人值守，用关键词粗判，事后可人工校正）----
// 财经类（最初盯股价用）
const POS_FIN = ["增长","增加","预增","大增","盈利","净利","分红","派现","派发","回购","新高","中标","签约","合作","上线","获得","增持","利好","突破"];
const NEG_FIN = ["下跌","下滑","亏损","减少","下降","诉讼","处罚","警示","风险","质押","减持","退市","违规","跌停","商誉","被罚","下修","低于预期","暴跌"];
// 游戏口碑类（盯产品/玩家舆情用，2字以上降低误伤）
const POS_GAME = ["好评","火爆","霸榜","登顶","出圈","爆款","热销","人气","破圈"];
const NEG_GAME = ["差评","翻车","停服","关服","停运","跑路","卡顿","闪退","崩溃","炸服","掉线","删档","退款","维权","抵制","封号","外挂","跳票","缩水","抄袭","侵权","吐槽","争议","骗氪","劝退","难玩","暴死","扑街"];
const POS = [...POS_FIN, ...POS_GAME];
const NEG = [...NEG_FIN, ...NEG_GAME];
function judge(text){
  let p = 0, n = 0;
  for (const w of POS) if (text.includes(w)) p++;
  for (const w of NEG) if (text.includes(w)) n++;
  if (p > n) return "positive";
  if (n > p) return "negative";
  return "neutral";
}

// ---- 工具 ----
const stripTags = s => String(s||"").replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
const toMin = t => String(t||"").slice(0,16); // 截到分钟："2026-06-09 09:50"
// 北京时间的"现在"（云端 GitHub Actions 跑在 UTC，统一换算到 Asia/Shanghai 保证时间戳一致）
const bjNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));

// 相关性过滤：宽词（如"雷霆游戏"会被拆成"游戏"泛匹配）召回的结果
// 必须真的提到品牌词才保留，否则全是"游戏黑产/博傻游戏"这类噪音
const BRAND = ["吉比特","雷霆游戏","雷霆网络","G-bits","603444","一念逍遥","问道","奥比岛","摩尔庄园","M72"];
const isRelevant = text => BRAND.some(b => text.includes(b));

async function getText(url){
  const res = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0", "Referer":"https://www.eastmoney.com/" } });
  return await res.text();
}

// ---- 来源1：东方财富 资讯搜索（全网新闻媒体聚合）----
async function fetchNews(keyword){
  const param = encodeURIComponent(JSON.stringify({
    uid:"", keyword, type:["cmsArticleWebOld"], client:"web", clientType:"web", clientVersion:"curr",
    param:{ cmsArticleWebOld:{ searchScope:"default", sort:"default", pageIndex:1, pageSize:20 } }
  }));
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${param}`;
  const raw = await getText(url);
  const m = raw.match(/^cb\(([\s\S]*)\)\s*;?\s*$/);
  if(!m) return [];
  let json; try { json = JSON.parse(m[1]); } catch(e){ return []; }
  const list = (json.result && json.result.cmsArticleWebOld) || [];
  return list.map(a=>{
    const title = stripTags(a.title);
    const summary = stripTags(a.content) || title;
    return {
      id: "news-" + (a.code || Buffer.from(title).toString("base64").slice(0,16)),
      platform: a.mediaName || "财经新闻",
      title, summary,
      url: a.url || "",
      sentiment: judge(title + " " + summary),
      time: toMin(a.date),
      tags: [keyword, a.mediaName].filter(Boolean)
    };
  }).filter(i => isRelevant(i.title + " " + i.summary)); // 过滤泛匹配噪音
}

// ---- 来源2：东方财富 个股公告 ----
async function fetchAnn(){
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=15&page_index=1&ann_type=A&client_source=web&stock_list=${STOCK}`;
  const raw = await getText(url);
  let json; try { json = JSON.parse(raw); } catch(e){ return []; }
  const list = (json.data && json.data.list) || [];
  return list.map(a=>{
    const title = stripTags(a.title);
    return {
      id: "ann-" + a.art_code,
      platform: "公司公告",
      title, summary: title,
      url: `https://data.eastmoney.com/notices/detail/${STOCK}/${a.art_code}.html`,
      sentiment: judge(title),
      time: toMin(a.notice_date || a.display_time),
      tags: ["公告", ...(a.columns||[]).map(c=>c.column_name)].filter(Boolean)
    };
  });
}

// ---- 来源3：社交站（经 SerpAPI 站内搜索，绕过各站反爬）----
// 各站 API 需签名/登录、直爬被验证页拦，故走付费搜索 API。未设 SERPAPI_KEY 或未开 FETCH_SOCIAL 时跳过。
// 每站合并关键词为一次搜索（site:domain "吉比特 OR 雷霆游戏"），省额度。
async function fetchSocial(site){
  if(!SERPAPI_KEY) return [];
  const q = encodeURIComponent(`site:${site.domain} ${KEYWORDS.join(" OR ")}`);
  const url = `https://serpapi.com/search.json?engine=google&q=${q}&num=10&hl=zh-cn&api_key=${SERPAPI_KEY}`;
  const raw = await getText(url);
  let json; try { json = JSON.parse(raw); } catch(e){ return []; }
  if(json.error) { console.log(`  [${site.name}] SerpAPI: ${json.error}`); return []; }
  const list = json.organic_results || [];
  return list.map(r=>{
    const title = stripTags(r.title);
    const summary = stripTags(r.snippet) || title;
    // id 取链接里的数字ID（question/123、p/456、discuss/123 等），比 base64 更有区分度，避免误去重
    const idPart = (r.link||"").match(/(?:question|answer|p|discuss|detail\?fid=|feed\/main\/detail)\/?=?(\d+)/);
    const key = idPart ? idPart[1] : Buffer.from(r.link||title).toString("base64").replace(/[^a-zA-Z0-9]/g,"").slice(-20);
    // 知乎周末兜底：若能解析出 question id，用 zhihu-q{qid} 与本机 CDP 深挖(fetch-zhihu.js)同 id，
    // 这样工作日 cdp 精确数据能覆盖周末 serp 糊数据（方案A去重）。解析不出才退化为带 answer/链接 id。
    const qm = site.name==="知乎" ? (r.link||"").match(/\/question\/(\d+)/) : null;
    const id = qm ? `zhihu-q${qm[1]}` : `${site.domain.split(".")[0]}-${key}`;
    return {
      id,
      platform: site.name,
      title, summary,
      url: r.link || "",
      sentiment: judge(title + " " + summary),
      time: parseZhihuDate(r.date),  // 把"6天前/2026年4月3日"统一成 YYYY-MM-DD HH:MM
      tags: [site.name, ...KEYWORDS.filter(k=>(title+summary).includes(k))],
      ...(site.name==="知乎" ? { source:"serp" } : {})  // 知乎周末兜底标记，merge 时让 cdp 优先
    };
  }).filter(i => isRelevant(i.title + " " + i.summary) && isMeaningful(i.title));
}

// 过滤知乎话题页/人物页这类无实质内容的裸标题（如标题就是"雷霆游戏""知乎"）
function isMeaningful(title){
  const t = (title||"").trim();
  if(t.length < 6) return false;                 // 太短，多半是话题/标签页
  if(KEYWORDS.includes(t)) return false;          // 标题就是纯关键词
  if(/^(知乎|专栏|话题)$/.test(t)) return false;
  return true;
}

// 解析知乎/搜索结果的发帖时间：支持 "N天前/N小时前"、"2026年4月3日"、"2026-04-03"。
// 解析不出（SerpAPI 没返回日期）则返回空串 ""，排序时沉底、前端显示"日期未知"，绝不冒充抓取时间。
function parseZhihuDate(raw){
  const p = x => String(x).padStart(2,"0");
  const fmt = d => `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = bjNow();
  if(!raw) return "";   // 无日期 → 空，不兜底当天
  const s = String(raw).trim();
  let m;
  if((m = s.match(/(\d+)\s*天前/)))   { const d=new Date(now); d.setDate(d.getDate()-(+m[1])); return fmt(d); }
  if((m = s.match(/(\d+)\s*小时前/))) { const d=new Date(now); d.setHours(d.getHours()-(+m[1])); return fmt(d); }
  if((m = s.match(/(\d+)\s*分钟前/))) { const d=new Date(now); d.setMinutes(d.getMinutes()-(+m[1])); return fmt(d); }
  if(/昨天/.test(s))                  { const d=new Date(now); d.setDate(d.getDate()-1); return fmt(d); }
  if((m = s.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/)))
    return `${m[1]}-${p(m[2])}-${p(m[3])} 00:00`;
  const t = Date.parse(s);
  if(!isNaN(t)) return fmt(new Date(t));
  return "";   // 实在解析不出 → 空，沉底
}

// ---- 读取现有 data.js，拿到已有 items 做去重 ----
function readExisting(){
  if(!fs.existsSync(DATA_FILE)) return { items:[] };
  const src = fs.readFileSync(DATA_FILE, "utf8");
  const m = src.match(/window\.MONITOR_DATA\s*=\s*([\s\S]*?);\s*$/);
  if(!m) return { items:[] };
  try { return eval("(" + m[1] + ")"); } catch(e){ return { items:[] }; }
}

function writeData(obj){
  const banner = "// 舆情数据文件 —— 由 fetch.js 自动写入，请勿手动编辑\n"
    + "// 页面通过 <script src=\"data.js\"> 读取，避免 file:// 下 fetch 被浏览器拦截\n";
  fs.writeFileSync(DATA_FILE, banner + "window.MONITOR_DATA = " + JSON.stringify(obj, null, 2) + ";\n", "utf8");
}

// ---- 飞书推送 ----
// newItems: 本次新增条目；allItems: 库内全部（用于"无新增也推今日概况"）；daily: 是否强制推送（每日固定推送模式）
async function pushLark(newItems, allItems, daily){
  // 只在每日固定推送（早班 DAILY_PUSH=1）时推，一天一条；兜底班 daily=0 一律不推，避免重复打扰
  if(!LARK_WEBHOOK || !daily) return;
  // 行业板块条目静默更新、不推飞书：推送只看 pushable!==false 的（即舆情）
  newItems = (newItems||[]).filter(i=>i.pushable!==false);
  allItems = (allItems||[]).filter(i=>i.pushable!==false);
  const SITE = "https://muchabby.github.io/leida-station/";
  // 清理标题：去掉知乎"- XX的回答/- 知乎用户的回答"等尾巴，去多余空白，过长截断
  const clean = t => {
    let s = String(t||"").replace(/\s*[-–—]\s*[^-–—]{0,20}的回答\s*$/,"")  // 去"- 翟健的回答"
                         .replace(/\s*[-–—]\s*知乎.*$/,"")                  // 去"- 知乎用户..."
                         .replace(/\s+/g," ").trim();
    return s.length > 34 ? s.slice(0,34)+"…" : s;
  };
  const today = (new Date(new Date().toLocaleString("en-US",{timeZone:"Asia/Shanghai"}))).toISOString().slice(0,10);
  let text;
  if(newItems.length){
    // 有新增：负面置顶，列最多10条
    const sorted = newItems.slice().sort((a,b)=> (a.sentiment==="negative"?-1:0) - (b.sentiment==="negative"?-1:0));
    const negCount = newItems.filter(i=>i.sentiment==="negative").length;
    const lines = sorted.slice(0,10).map(i=>`· ${clean(i.title)}`).join("\n");
    const more = newItems.length>10 ? `\n… 还有 ${newItems.length-10} 条` : "";
    let head = `📡 雷达站 · 今天更新 ${newItems.length} 条`;
    if(negCount) head += `（含 ${negCount} 条负面 ⚠️）`;
    text = `${head}\n\n${lines}${more}\n\n👉 查看全部：${SITE}`;
  } else {
    // 无新增但每日固定推送：报当日概况 + 最新动态，保持存在感
    const all = allItems || [];
    const totalNeg = all.filter(i=>i.sentiment==="negative").length;
    // 按时间倒序取最新3条（有日期的）
    const latest = all.filter(i=>i.time).sort((a,b)=> a.time<b.time?1:-1).slice(0,3);
    const latestLines = latest.length ? "\n\n最新动态：\n" + latest.map(i=>`· ${clean(i.title)}`).join("\n") : "";
    text = `📡 雷达站 · ${today} 日报\n今日暂无新增舆情，库内共 ${all.length} 条（负面 ${totalNeg} 条）。${latestLines}\n\n👉 查看全部：${SITE}`;
  }
  try{
    const res = await fetch(LARK_WEBHOOK, { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ msg_type:"text", content:{ text } }) });
    const r = await res.json().catch(()=>({}));
    if(r.code && r.code!==0) console.log("飞书推送返回异常：", JSON.stringify(r));
    else console.log("已推送飞书");
  }catch(e){ console.log("飞书推送失败：", e.message); }
}

// ---- 主流程 ----
(async ()=>{
  const now = bjNow();
  const pad = n => String(n).padStart(2,"0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  let fetched = [];
  for(const kw of KEYWORDS){
    try { fetched.push(...await fetchNews(kw)); }
    catch(e){ console.log(`抓取新闻[${kw}]失败：`, e.message); }
  }
  try { fetched.push(...await fetchAnn()); }
  catch(e){ console.log("抓取公告失败：", e.message); }

  // 社交站：仅在开了 FETCH_SOCIAL 的那次任务抓（每天1次，省额度）
  // 方案A：知乎只在周末由 SerpAPI 兜底抓；工作日由本机 fetch-zhihu.js 经 CDP 深挖（更精确）。
  // 脉脉/牛客不受影响，照常每天（开了FETCH_SOCIAL时）抓。
  const dow = bjNow().getDay(); // 0=周日,6=周六
  const isWeekend = (dow===0 || dow===6);
  if(FETCH_SOCIAL && SERPAPI_KEY){
    for(const site of SOCIAL_SITES){
      if(site.name==="知乎" && !isWeekend) continue; // 工作日知乎交给本机CDP，云端不抓
      try { fetched.push(...await fetchSocial(site)); }
      catch(e){ console.log(`抓取${site.name}失败：`, e.message); }
    }
  }

  // 抓取结果内部按 id 去重
  const seen = new Set();
  fetched = fetched.filter(i => i.id && i.title && !seen.has(i.id) && seen.add(i.id));

  const existing = readExisting();
  const existMap = new Map((existing.items||[]).map(i=>[i.id, i]));

  // 方案A去重：周末 serp 知乎条目，若库里已有同 id 的本机 cdp 精确版，丢弃 serp（cdp 永远优先，不被糊数据覆盖）。
  fetched = fetched.filter(i => {
    if(i.source==="serp"){ const old=existMap.get(i.id); if(old && old.source==="cdp") return false; }
    return true;
  });

  const fresh = fetched.filter(i => !existMap.has(i.id));

  // 「盯着他」：对库里已存在、这次又抓到的条目，比对标题+摘要快照。
  // 变了就更新内容并记 lastChange / changeNote（前端据此在该条下提示"有更新"）。
  let changed = 0;
  for(const it of fetched){
    const old = existMap.get(it.id);
    if(!old) continue;
    const noteParts = [];
    if((old.title||"") !== (it.title||"")) noteParts.push("标题");
    if((old.summary||"") !== (it.summary||"")) noteParts.push("摘要");
    if(noteParts.length){
      it.lastChange = stamp;
      it.changeNote = noteParts.join("、") + "有更新";
      changed++;
    } else {
      // 内容没变：沿用旧的变更标记（不清除，由前端"已读"控制）
      if(old.lastChange) it.lastChange = old.lastChange;
      if(old.changeNote) it.changeNote = old.changeNote;
    }
  }

  // 合并：这次抓到的（新+已更新内容）优先，再补上库里未被重新抓到的旧条目，按时间倒序
  const fetchedIds = new Set(fetched.map(i=>i.id));
  const untouched = (existing.items||[]).filter(i=>!fetchedIds.has(i.id));
  const merged = [...fetched, ...untouched].sort((a,b)=> (a.time<b.time?1:-1));
  merged.forEach(i=>{
    i.category = categorize(i);
    i.topic = topicize(i);
    // section：舆情(本品牌 吉比特/雷霆) / 行业(游戏行业大盘)。当前只抓本品牌，缺省一律"舆情"。
    if(!i.section) i.section = "舆情";
    // pushable：是否推飞书。行业条目静默更新不推；舆情条目默认可推。
    if(i.pushable === undefined) i.pushable = (i.section !== "行业");
  }); // 统一打来源分类+主题标签+板块归属（含回填存量）

  writeData({ updatedAt: stamp, keywords: KEYWORDS, items: merged });
  const socialCnt = fetched.filter(i=>SOCIAL_SITES.some(s=>s.name===i.platform)).length;
  console.log(`[${stamp}] 抓取 ${fetched.length} 条（社交站 ${socialCnt} 条/${FETCH_SOCIAL?"本次抓":"本次跳过"}，Key:${SERPAPI_KEY?"已配置":"未配置"}），新增 ${fresh.length} 条，内容更新 ${changed} 条，库内共 ${merged.length} 条`);

  await pushLark(fresh, merged, process.env.DAILY_PUSH === "1");
})();

