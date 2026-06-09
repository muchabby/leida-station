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
// 给一条消息归类：财经新闻 / 公司公告 / 社区讨论 / 招聘信息
function categorize(item){
  if(item.platform==="公司公告") return "公司公告";
  const text = (item.title||"") + (item.summary||"");
  if(RECRUIT_HINT.some(w=>text.includes(w))) return "招聘信息";
  if(item.platform==="知乎") return "社区讨论";
  if(item.platform==="脉脉"||item.platform==="牛客") return "招聘信息";
  return "财经新闻";
}
// 社交站每天只抓 1 次以省额度（3 站 × 30 天 = 90 次/月，卡在免费 100 次内）。
// 设 FETCH_SOCIAL=1 的那次任务才抓社交站；不设则只抓新闻+公告（0 额度）。
const FETCH_SOCIAL = process.env.FETCH_SOCIAL === "1";

// ---- 情绪规则判定（脚本无人值守，用关键词粗判，事后可人工校正）----
const POS = ["增长","增加","预增","大增","盈利","净利","分红","派现","派发","回购","新高","中标","签约","合作","上线","获得","增持","利好","突破"];
const NEG = ["下跌","下滑","亏损","减少","下降","诉讼","处罚","警示","风险","质押","减持","退市","违规","跌停","商誉","被罚","下修","低于预期","暴跌"];
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
    return {
      id: `${site.domain.split(".")[0]}-${key}`,
      platform: site.name,
      title, summary,
      url: r.link || "",
      sentiment: judge(title + " " + summary),
      time: parseZhihuDate(r.date),  // 把"6天前/2026年4月3日"统一成 YYYY-MM-DD HH:MM
      tags: [site.name, ...KEYWORDS.filter(k=>(title+summary).includes(k))]
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

// 解析知乎/搜索结果的时间：支持 "N天前/N小时前"、"2026年4月3日"、"2026-04-03"，失败则兜底当天
function parseZhihuDate(raw){
  const p = x => String(x).padStart(2,"0");
  const fmt = d => `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  if(!raw) return fmt(now);
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
  return fmt(now);  // 实在解析不出，兜底当天，至少不破坏排序
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
async function pushLark(newItems){
  if(!LARK_WEBHOOK || !newItems.length) return;
  const lines = newItems.slice(0,10).map((i,idx)=>`${idx+1}. [${i.platform}] ${i.title}`).join("\n");
  const text = `📡 雷达站发现 ${newItems.length} 条新舆情（吉比特/雷霆游戏）\n\n${lines}`;
  try{
    await fetch(LARK_WEBHOOK, { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ msg_type:"text", content:{ text } }) });
    console.log("已推送飞书");
  }catch(e){ console.log("飞书推送失败：", e.message); }
}

// ---- 主流程 ----
(async ()=>{
  const now = new Date();
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
  if(FETCH_SOCIAL && SERPAPI_KEY){
    for(const site of SOCIAL_SITES){
      try { fetched.push(...await fetchSocial(site)); }
      catch(e){ console.log(`抓取${site.name}失败：`, e.message); }
    }
  }

  // 抓取结果内部按 id 去重
  const seen = new Set();
  fetched = fetched.filter(i => i.id && i.title && !seen.has(i.id) && seen.add(i.id));

  const existing = readExisting();
  const existMap = new Map((existing.items||[]).map(i=>[i.id, i]));
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
  merged.forEach(i=>{ i.category = categorize(i); }); // 统一打分类标签（含回填旧条目）

  writeData({ updatedAt: stamp, keywords: KEYWORDS, items: merged });
  const socialCnt = fetched.filter(i=>SOCIAL_SITES.some(s=>s.name===i.platform)).length;
  console.log(`[${stamp}] 抓取 ${fetched.length} 条（社交站 ${socialCnt} 条/${FETCH_SOCIAL?"本次抓":"本次跳过"}，Key:${SERPAPI_KEY?"已配置":"未配置"}），新增 ${fresh.length} 条，内容更新 ${changed} 条，库内共 ${merged.length} 条`);

  await pushLark(fresh);
})();

