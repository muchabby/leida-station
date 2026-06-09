# 雷达站舆情监测系统 · 搭建 SOP

> 吉比特 / 雷霆游戏厂牌舆情监测系统「雷达站」从零搭建到上云、接入飞书的标准作业流程。
> 本地目录：`C:\Users\os_lisy\Documents\舆论检测器-搭建\`
> 线上地址：https://muchabby.github.io/leida-station/
> 仓库：`muchabby/leida-station`（GitHub 公开仓库）

---

## 0. 系统全景

整套系统的数据流向：

```
数据源（东方财富接口 + SerpAPI 社交站搜索）
        │  fetch.js 抓取 + 清洗 + 情绪/分类判定
        ▼
     data.js（window.MONITOR_DATA，写死的静态数据）
        │  GitHub Actions 每天 9 点自动跑，bot commit
        ▼
   GitHub Pages 静态托管 ──► index.html 纯前端单页展示
        │                         │
        │                         ├─ Supabase（多设备星标/备注同步）
        ▼                         │
   飞书机器人推送（有新增才推）◄────┘
```

核心设计原则：

- **纯静态、零后端**：前端单页 + 写死的 `data.js`，不需要服务器，GitHub Pages 直接托管。
- **数据与展示分离**：抓取（`fetch.js`）只负责生成 `data.js`，前端只负责读 `data.js` 渲染。
- **云端无人值守**：上云后完全不依赖本地电脑，GitHub Actions 定时跑。
- **额度敏感**：SerpAPI 免费额度有限，所有抓取频率都围绕额度精算（见第 6 节）。

---

## 阶段一 · 前期网页建设（本地）

### 1.1 确定监测对象与品牌词

先把要监测的主体和关键词定下来，这是后面所有过滤逻辑的基准。

- 监测主体：吉比特 / 雷霆游戏（个股代码 `603444`）。
- 品牌词表 `keywords`：用于 `isRelevant()` 过滤泛匹配噪音。词太宽会引入无关信息，太窄会漏，需要试跑几轮调。

### 1.2 搭前端单页 `index.html`

- 纯前端单页，**数据写死在 `data.js`**，靠 `<script src="data.js">` 读取——不要用 `fetch('data.js')`，否则 `file://` 本地打开时会被浏览器 CORS 拦截。
- 页面含两个 `<script>` 块：一个引数据，一个跑渲染逻辑。
- 前端 tab：总览 / 全部消息 / 盯着他 / 已处理 / 数据源。
- 总览三块（数据驱动，非实时，`data.js` 变了需手动刷新页面）：
  - **负面预警卡**：`sentiment=negative` 置顶红色展示，无负面则隐藏。
  - **分类占比环形图**：canvas 手绘无依赖，中间显总数，点图例可跳转筛选。
  - **关键词热点**：用预设词表 `HOT_TERMS` 匹配计数（浏览器无中文分词库），标签云按热度调字号。新增重要词要手动加进 `HOT_TERMS`。

### 1.3 写抓取脚本 `fetch.js`（Node，无第三方依赖）

数据源分三类：

1. **东方财富资讯搜索接口**——全网新闻媒体聚合，免登录。
2. **东方财富个股公告接口**——`STOCK=603444`，免登录。
3. **社交站经 SerpAPI 站内搜索**——知乎 / 脉脉 / 牛客。小红书 Google 不收录、实测 0 条，放弃。

抓取后的清洗管线：

- `isRelevant()`：品牌词过滤泛匹配噪音。
- `isMeaningful()`：过滤裸标题。
- 中文时间解析 `parseZhihuDate()`：把"6天前 / 2026年4月3日"统一成 `YYYY-MM-DD HH:MM`。
- `judge()`：关键词规则粗判 `positive/negative/neutral`，无人值守用，偶有误判可人工校正。
- `categorize()`：分 4 类——公司公告 / 招聘信息（命中招聘词或脉脉牛客）/ 社区讨论（知乎）/ 财经新闻（其余）。

**时间策略（关键，踩过坑）**：新闻/公告用接口返回的真实日期；社交帖用 SerpAPI 返回的 date。**SerpAPI 没返回日期的帖子，`time` 置空串 `""`**，排序时沉底、前端显示"日期未知"——绝不用抓取时刻冒充发帖时间（早期 bug 就是兜底成当前时刻，已修并清洗历史数据）。

### 1.4 数据文件 `data.js` 约定

```js
window.MONITOR_DATA = { updatedAt, keywords, items: [] }
```

每条 `item` 字段：`id / platform / title / summary / url / sentiment / time / tags / category`。社交站条目可能多带 `lastChange + changeNote`（"盯着他"功能用）。

> ⚠️ `data.js` 由 `fetch.js` 自动写入，**勿手改**。

### 1.5 本地试跑

- 用 `node fetch.js` 跑一轮，检查 `data.js` 生成是否正常。
- 直接双击 `index.html` 本地打开验证展示。
- 反复调品牌词和 `HOT_TERMS`，直到噪音可控。

---

## 阶段二 · 本地定时跑（上云前的过渡方案）

上云之前先在本地跑稳，用 Windows 任务计划：

- 任务名 `LeidaStation_0900 / 1300 / 1800`，每天 9/13/18 点跑。
- 9 点抓全套（新闻+公告+社交 3 站，消耗 3 次 SerpAPI 额度），13/18 点只抓新闻+公告（0 额度）。
- 脚本 `run.cmd`（13/18 点用，不抓社交）、`run-social.cmd`（9 点用，带 `FETCH_SOCIAL=1` 抓社交）。两者都 `chcp 65001` + node 全路径，日志写 `run.log`。
- SerpAPI Key 存 **Windows 用户级环境变量 `SERPAPI_KEY`**（64 字符），不写进任何明文文件。校验：跑完看 `run.log` 是否显示"Key:已配置"。

> 📌 上云后这些本地任务要 **Disable**（避免与云端双倍耗额度），但不要删，留作可恢复的兜底。

---

## 阶段三 · 上云（GitHub Pages + Actions）

> 已于 2026-06-09 完成。这套方案的好处：免费、零运维、完全不依赖本地电脑。

### 3.1 建仓库 + 开 Pages

1. `gh auth login` 登录 GitHub（当前账号 `muchabby`）。
2. 创建公开仓库 `muchabby/leida-station`，把 `index.html` / `data.js` / `fetch.js` 推上去。
3. 仓库 Settings → Pages → 选 main 分支根目录发布。
4. 访问 https://muchabby.github.io/leida-station/ 验证。

### 3.2 存密钥到 GitHub Secrets

用 `gh secret set` 存（**绝不写进仓库明文**）：

- `SERPAPI_KEY`——SerpAPI 密钥。
- `LARK_WEBHOOK`——飞书机器人 webhook（见阶段五）。

### 3.3 云端定时抓取 workflow

`.github/workflows/fetch.yml`：

- GitHub Actions 每天北京 9 点跑一次，cron 用 UTC：`'3 1 * * *'`。
- 跑全套含社交（`FETCH_SOCIAL=1`）。
- `env` 里传 `SERPAPI_KEY` 和 `LARK_WEBHOOK`（从 Secrets 注入）。
- 抓完 bot 自动 `commit data.js` → Pages 自动重新发布。
- `fetch.js` 用 `bjNow()` 统一北京时间（云端跑在 UTC，不处理会差 8 小时）。

> 已实测海外 IP（GitHub runner 在海外）能抓到东方财富 + SerpAPI。
> 早期是每天 3 次（9/13/18 点），2026-06-09 改为只 9 点 1 次，省 SerpAPI 额度。

### 3.4 关掉本地任务

云端跑通后，把本地 `LeidaStation_*` 任务计划全部 Disable，避免双倍耗额度。

---

## 阶段四 · 多设备星标同步（Supabase）

让"加星 / 已处理 / 备注"在多台设备间同步。仓库公开，所以靠 Supabase RLS 保证安全。

### 4.1 建 Supabase 项目

- 项目 ref：`rugfatciofsyydgcwpww`，URL `https://rugfatciofsyydgcwpww.supabase.co`，区域亚太。
- 前端用 **publishable key**（`sb_publishable_` 开头，新版替代 anon key，设计上可公开放前端），写死在 `index.html`。
- **绝不放 `service_role` / `secret` key。**

### 4.2 建表 `user_marks`

- 字段：`item_id`（主键，对应 `data.js` 条目 id）/ `starred` / `done` / `note` / `upd_seen` / `updated_at`。
- 开 RLS，allow anon 读写全开（仅限这一张表，靠 RLS 限制范围）。

### 4.3 前端同步逻辑（`index.html`）

- localStorage 作本地缓存 + 离线兜底，Supabase 作云端真相。
- **启动顺序很关键**：先 `await pullAllMarks()` 拉云端灌进 localStorage，**再** `renderAll()`。早期"先渲染再异步拉"会导致多设备竞态（B 设备看不到 A 设备的星），已修。
- 写操作（加星 / 已处理 / 标更新已读用 `pushMark(id)`；备注在 `focusout` 时 `pushMark`）：本地立即更新 + 异步 upsert 到云端（`POST` + `Prefer: resolution=merge-duplicates` + `on_conflict=item_id`）。
- 顶栏 `#syncStatus` 徽标显示 同步中/已同步/失败；云端连不上降级用本地缓存，不卡。

> 🔧 测试经验：REST 根路径 `/rest/v1/` 用 publishable key 会返回 401（正常），要测具体表 `/rest/v1/user_marks`。测写入用 PowerShell `Invoke-WebRequest` 比 curl 稳（curl 本机 shell 单引号 `-d` 会被吞）。

---

## 阶段五 · 接入飞书推送

> 已于 2026-06-09 接通。每天"有新增才推"。

### 5.1 建飞书自定义机器人

1. 在目标飞书群里添加「自定义机器人」，拿到 webhook URL。
2. 安全设置选 **自定义关键词**，关键词填 `雷达站`。

### 5.2 ⚠️ 最大的坑：关键词校验

飞书自定义关键词机器人要求 **推送消息文本里必须含关键词"雷达站"**，否则飞书返回 `code 19024 "Key Words Not Found"`，推送失败。所以所有推送话术开头都带"📡 雷达站"。

### 5.3 推送逻辑 `pushLark()`（在 `fetch.js` 里）

- webhook 存 GitHub Secrets（名 `LARK_WEBHOOK`），workflow `env` 注入。
- 话术结构：
  - 开头 `📡 雷达站 · 今天更新 N 条`（带关键词，过校验）。
  - 负面置顶。
  - 清理标题尾巴（去掉"XX的回答"这类后缀）。
  - 单条截断 34 字。
  - 末尾附"查看全部"链接（指向 Pages 站点）。
- 触发条件：**有新增才推**，没新增不打扰。

---

## 阶段六 · 日常运维与扩展

### SerpAPI 额度账（务必盯紧）

- 免费 **100 次搜索/月**，每个 "site:域名 关键词" 算 1 次。
- 当前策略：社交站每天只抓 1 次（9 点，`FETCH_SOCIAL=1`），3 站 × 1 次/天 × 30 天 = **90 次/月**，留 10 次余量。
- 每站合并关键词为一次搜索（`site:domain "吉比特 OR 雷霆游戏"`），不按词拆，省额度。
- **加站点或加频率前必须重算额度**，很容易超。小红书无论如何加不进（Google 不收录）。

### 常见维护动作

| 需求 | 怎么做 |
|------|--------|
| 加监测关键词 | 改 `fetch.js` 品牌词表；重要热词手动加进前端 `HOT_TERMS` |
| 改抓取频率 | 改 `.github/workflows/fetch.yml` 的 cron（注意 UTC，先算额度） |
| 数据不对 | 看 GitHub Actions 运行日志；不要手改 `data.js` |
| 页面没更新 | `data.js` 变了需手动刷新页面；确认 Actions 跑成功且 bot 已 commit |
| 飞书不推 | 查推送文本是否含"雷达站"（19024 错误）；确认当天有新增 |
| 星标不同步 | 查 `#syncStatus` 徽标；确认 `user_marks` 表 RLS 与启动顺序 |

### 关键文件清单

- `index.html` — 纯前端单页（含 Supabase 同步逻辑）。
- `data.js` — 数据文件，自动生成勿手改。
- `fetch.js` — 抓取脚本（含 `pushLark()` 飞书推送）。
- `.github/workflows/fetch.yml` — 云端定时任务。
- `run.cmd` / `run-social.cmd` — 本地任务脚本（已停用，留作兜底）。
- `data.backup-manual.js` — 早期手工版备份。
- `versions/` — 历史快照。

### 密钥存放总表

| 密钥 | 存放位置 | 说明 |
|------|----------|------|
| `SERPAPI_KEY` | GitHub Secrets（云端）/ Windows 环境变量（本地） | 绝不进明文文件 |
| `LARK_WEBHOOK` | GitHub Secrets | workflow env 注入 |
| Supabase publishable key | `index.html` 明文 | 设计上可公开，靠 RLS 保护 |
| Supabase service/secret key | **不存任何地方、不上前端** | — |

---

## 附录 · 已知局限

- **总览非实时**：`data.js` 变了需手动刷新页面，页面不自动定时刷新。
- **盯着他基于 snippet**：能感知"帖子有动静"，但拿不到精确点赞/评论数（知乎正文页直抓被 403 挡）。
- **情绪/分类是关键词粗判**：偶有误判，可人工校正。
- **热词无中文分词**：靠预设 `HOT_TERMS` 词表匹配，新词要手动加。
- **小红书抓不到**：Google 不收录，已放弃。

---

*最后更新：2026-06-09*
