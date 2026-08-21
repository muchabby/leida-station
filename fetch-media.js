// 垂媒 RSS + 版号公示抓取模块（零 SerpAPI 额度）
// 由 fetch.js 引入。两条线都做"品牌/行业"两路分流：
//   命中品牌词  → 不打 section，进品牌舆情池（会进预警/环形图/热词/飞书推送）
//   未命中品牌  → section="行业"、pushable=false，进行业动态池（静默）
// 垂媒每天几十篇，只收"与品牌相关"或"行业够格"的，泛评测/海外小作不收。
const https = require("https");
const http  = require("http");

// GameLook 的 https 证书链在本环境不通，必须走 http（2026-08-21 实测）
const FEEDS = [
  { name: "游戏陀螺", url: "https://www.youxituoluo.com/feed" },
  { name: "触乐",     url: "https://www.chuapp.com/feed" },
  { name: "GameLook", url: "http://www.gamelook.com.cn/feed/" },
];

const NPPA_LIST = "https://www.nppa.gov.cn/bsfw/jggs/yxspjg/gcwlyxspxx/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 跟随重定向的简易 GET（GameLook 的 /feed 会 301 到 /feed/）
function get(url, redirects = 0){
  return new Promise((resolve, reject) => {
    if(redirects > 4) return reject(new Error("重定向过多"));
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers:{ "User-Agent": UA, "Accept":"*/*" }, timeout: 20000 }, res => {
      if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
        res.resume();
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return get(next, redirects + 1).then(resolve, reject);
      }
      if(res.statusCode !== 200){ res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let d = ""; res.setEncoding("utf8");
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("超时")); });
  });
}

// 用字符串定位取 XML 标签内容——比正则稳，RSS 里 CDATA 和换行都不影响
function tagOf(s, name){
  const o = s.indexOf("<" + name + ">");
  if(o < 0) return "";
  const c = s.indexOf("</" + name + ">", o);
  if(c < 0) return "";
  return s.slice(o + name.length + 2, c).replace("<![CDATA[", "").replace("]]>", "").trim();
}

const unent = s => String(s||"")
  .replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"')
  .replace(/&#0?39;|&apos;/g,"'").replace(/&nbsp;/g," ").replace(/&amp;/g,"&");
const clean = s => unent(String(s||"")).replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();

// pubDate（RFC822）→ "YYYY-MM-DD HH:MM" 北京时间
function toBjMin(raw){
  const t = Date.parse(String(raw||"").trim());
  if(!isFinite(t)) return "";
  const d = new Date(t + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2,"0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function hash(s){
  let h = 0;
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}

// ---- 垂媒 RSS ----
// deps 由 fetch.js 注入，复用它已有的判定逻辑，避免规则两处维护：
//   isRelevant(text)          命中本品牌
//   judge(text)               情绪
//   isIndustryRelevant(text)  行业够格
//   isIndustryNoise(title)    行业噪音
async function fetchMediaFeeds(deps){
  const { isRelevant, judge, isIndustryRelevant, isIndustryNoise } = deps;
  const out = [];
  for(const feed of FEEDS){
    try{
      const xml = await get(feed.url);
      const parts = xml.split("<item>").slice(1).map(s => s.split("</item>")[0]);
      let kept = 0;
      for(const s of parts){
        const title = clean(tagOf(s, "title"));
        const url   = tagOf(s, "link");
        if(!title || !url) continue;
        // 正文可能很长，截 220 字做摘要
        const body = clean(tagOf(s, "description"));
        const summary = (body || title).slice(0, 220);
        const time = toBjMin(tagOf(s, "pubDate"));
        const text = title + " " + summary;

        const brand = isRelevant(text);
        // 非品牌内容必须过行业判定，否则丢——垂媒每天几十篇，多是评测/海外小作
        if(!brand){
          if(isIndustryNoise(title)) continue;
          if(!isIndustryRelevant(text)) continue;
        }
        const item = {
          id: "media-" + hash(url),
          platform: feed.name,
          title, summary, url,
          sentiment: judge(text),
          time,
          tags: [feed.name, brand ? "品牌相关" : "行业"].filter(Boolean),
        };
        if(!brand){ item.section = "行业"; item.pushable = false; }
        out.push(item);
        kept++;
      }
      console.log(`  垂媒[${feed.name}] ${parts.length} 篇 → 收录 ${kept} 条`);
    }catch(e){
      console.log(`  垂媒[${feed.name}] 抓取失败：${e.message}`);
    }
  }
  return out;
}

// ---- 版号公示 ----
// 两跳：栏目页拿最近的月度公示链接 → 明细页解析表格，只留出版/运营单位命中品牌的那几款。
// 每月更新一次，所以只看最新一期；已存在的 id 会被 fetch.js 的去重挡掉，不会重复入库。
async function fetchNppa(deps){
  const { isRelevant, judge } = deps;
  const out = [];
  try{
    const listHtml = await get(NPPA_LIST);
    // 形如 ./202607/t20260723_1000636.html
    const links = [...listHtml.matchAll(/href="(\.\/(\d{6})\/t(\d{8})_\d+\.html)"/g)]
      .map(m => ({ href: m[1].replace("./", NPPA_LIST), ym: m[2], date: m[3] }))
      .sort((a,b) => b.date.localeCompare(a.date));
    if(!links.length){ console.log("  版号：栏目页未解析到公示链接"); return out; }

    const latest = links[0];
    const pubDate = `${latest.date.slice(0,4)}-${latest.date.slice(4,6)}-${latest.date.slice(6,8)}`;
    const detail = await get(latest.href);

    // 表格行：序号|名称|申报类别|出版单位|运营单位|批复文号|出版物号|批准时间
    // 坑：「申报类别」那一列是 <script>document.write(...)</script> 动态生成的，静态抓不到 td。
    // 所以先把 script 块里的 var _sblb='移动、客户端' 抠出来当类别，再把 script 整块删掉再解析 td，
    // 否则该行 td 会少一列、字段错位（2026-08-21 实测）。
    const rows = [...detail.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => {
      const raw = m[1];
      const cat = (raw.match(/var\s+_sblb\s*=\s*'([^']*)'/) || [,""])[1];
      const cells = [...raw.replace(/<script[\s\S]*?<\/script>/g, "").matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
        .map(c => clean(c[1]));
      return { cells, cat };
    }).filter(r => r.cells.length >= 5 && /^\d+$/.test(r.cells[0]))
      .map(r => ({ name:r.cells[1], cat:r.cat, publisher:r.cells[2], operator:r.cells[3], doc:r.cells[4] }));

    // 只按「出版单位 / 运营单位」判自家，不看游戏名——别家游戏叫《雷霆奇迹》《雷霆无双》会撞词误判。
    // 公司名用宽口径（雷霆互动/雷霆网络/吉比特…都算），所以这里不复用 isRelevant（它含游戏名）。
    const CORP = ["吉比特","雷霆互动","雷霆网络","雷霆游戏","厦门吉比特","厦门雷霆"];
    const isMineCorp = r => CORP.some(c => (r.publisher + " " + r.operator).includes(c));
    const mine = rows.filter(isMineCorp);
    console.log(`  版号[${latest.ym}] 共 ${rows.length} 款 → 自家 ${mine.length} 款`);
    if(!mine.length) return out;

    // 自家版号汇成一条，避免几款游戏各占一条把列表冲淡
    const names = mine.map(r => `《${r.name}》${r.cat ? "（" + r.cat + "）" : ""}`).join("、");
    const title = `${latest.ym.slice(0,4)}年${parseInt(latest.ym.slice(4,6),10)}月版号：本司获批 ${mine.length} 款 — ${mine.map(r=>r.name).join("、")}`;
    const summary = `国家新闻出版署 ${pubDate} 公示当月国产网络游戏审批信息，共 ${rows.length} 款获批，其中本司相关 ${mine.length} 款：${names}。运营单位：${[...new Set(mine.map(r=>r.operator))].join("、")}。`;
    out.push({
      id: "nppa-" + latest.ym + "-brand",
      platform: "版号公示",
      title, summary,
      url: latest.href,
      sentiment: judge(title),   // 拿到版号通常是利好，交给 judge 判
      time: pubDate + " 09:00",
      tags: ["版号", "官方"],
    });
  }catch(e){
    console.log(`  版号抓取失败：${e.message}`);
  }
  return out;
}

module.exports = { FEEDS, NPPA_LIST, get, tagOf, clean, toBjMin, hash, fetchMediaFeeds, fetchNppa };
