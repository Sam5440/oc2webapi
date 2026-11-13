# oc2webapi

**在浏览器里直接使用 OpenCode 免费模型的对话界面。** 无需注册、无需自建服务、无需数据库——打开网页即可与 OpenCode Zen 免费模型对话。

多会话管理 · 双边消息完整 Markdown 渲染 · 对话导出为文档 · 请求默认由用户浏览器发出（用户 IP）。

> 语言：[简体中文](#readme) ｜ [English](#english)

---

## ✨ 功能

- **开箱即用**：React + Vite 静态站 + 一个边缘函数，部署后打开即用，使用 OpenCode 匿名免费通道（`Bearer public`）。
- **shadcn/ui 全量组件化界面**：Radix UI 交互原语 + Tailwind CSS v4 设计令牌，亮 / 暗 / 跟随系统三档主题。
- **多会话管理**：侧栏新建 / 切换 / 重命名 / 置顶 / 删除会话，全部数据只保存在你的浏览器 `localStorage`，支持 JSON 备份导入导出。
- **完整 Markdown 渲染**：用户与助手双侧消息均渲染 GFM——标题、表格、任务列表、引用、行内代码；代码块带语法高亮（highlight.js）与一键复制。
- **思考过程**：推理模型的 `reasoning_content` 以可折叠面板流式展示。
- **对话导出**：一键导出为 Markdown（.md）、自包含 HTML 文档（.html，可直接导入 Word）、纯文本（.txt），或直接打印 / 另存为 PDF。
- **流式输出**：SSE 实时渲染，可随时停止；显示 token 用量。
- **混合请求通道**（见下文「请求通道」）：自动模式优先浏览器直连（真实用户 IP），CORS 受限时自动回退同源边缘中转；也可自建中转。
- **直连增强油猴脚本**：一键安装后直连请求改由扩展后台发出，绕过 CORS、仍是你的 IP、保持流式，无需中转。

## 🚀 快速开始

### 一键部署到 Vercel

点击下方按钮，使用你的 GitHub 账号一键克隆并部署（免费 Hobby 计划即可）：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FSam5440%2Foc2webapi&project-name=oc2webapi&repository-name=oc2webapi)

部署完成后打开分配的 `*.vercel.app` 域名即可使用。

### 本地开发

技术栈：**React 19 + Vite + Tailwind CSS v4 + shadcn/ui**（组件库含全部 UI 交互），需要 Node.js 20+：

```bash
git clone https://github.com/Sam5440/oc2webapi.git
cd oc2webapi
npm install
npm run dev     # http://localhost:5173
npm run build   # 产物输出到 dist/
```

> 本地 dev 下 `/api` 代理到 `localhost:8940`（可用 `MOCK=1 npm run dev` 代理到 8931 的 mock 中转）。
> 未运行中转时模型列表仍可用（浏览器直连 GET），推理请求需部署到 Vercel 或自建中转。

### 从源码部署到自己的 Vercel

```bash
npm i -g vercel
vercel        # 首次按提示关联项目
vercel --prod # 部署生产环境
```

## 🔀 请求通道

OpenCode 的推理接口（`POST /inference/*`）**在服务端未开放 CORS**（实测预检 404、
`access-control-allow-methods: GET, OPTIONS`），因此普通网页无法跨域读取推理响应；
而 `GET /v1/models` 等只读接口完全开放 CORS。本项目据此设计三档通道：

| 通道 | 行为 | 适用 |
| --- | --- | --- |
| **自动**（默认） | 每次请求先尝试浏览器直连（上游看到**用户真实 IP**，独享免费额度），被 CORS 拦截或额度/服务端错误时自动改走同源边缘中转并记住可用通道 | 绝大多数场景 |
| **仅直连** | 全部请求从浏览器发出。需要安装下方「直连增强」油猴脚本、浏览器禁用 CORS，或未来上游开放 CORS | 追求真实用户 IP |
| **仅中转** | 全部请求经中转函数转发，上游看到部署平台出口 IP | 直连环境不可用 |

说明：

- **模型列表始终由浏览器直连获取**（该接口 CORS 全开），任何通道下都使用用户自己的 IP。
- 中转函数只允许转发 `opencode.ai` 的 `/inference/*` 与 `/zen/*` 路径，**不是开放代理**；不存储任何请求内容。
- 直连与中转的免费额度相互独立（出口 IP 不同）。自动模式在遇到 `429/5xx` 时会自动换通道重试一次。
- 设置面板可自定义中转地址（指向任意自建中转），可选设置 `RELAY_TOKEN` 环境变量防止陌生人搭便车（请求头 `x-oc2-token` 匹配）。

### 浏览器直连增强（油猴脚本）

推理接口没开放 CORS，普通网页能发出请求却读不到响应。仓库里的
[`public/userscripts/oc2webapi-cors-bridge.user.js`](public/userscripts/oc2webapi-cors-bridge.user.js)
可以把这一点补上：

- 它在页面里替换 `fetch`，把发往 `opencode.ai` 的 `/inference/*`、`/zen/*` **POST** 请求交给油猴扩展
  （`GM_xmlhttpRequest`）在扩展后台发出——扩展请求不受 CORS 约束；
- 响应状态码、响应头、正文分块经 `postMessage` 回传，页面侧拼成真正的 `ReadableStream`，
  因此**流式输出、停止生成、429 错误解析全部照常**；
- 上游看到的是**你自己的出口 IP**，不经过任何中转服务器，数据不落入第三方。

安装：先装 Tampermonkey 或 Violentmonkey，然后打开
[`/userscripts/oc2webapi-cors-bridge.user.js`](https://oc2webapi.vercel.app/userscripts/oc2webapi-cors-bridge.user.js)
（页面「设置 → 浏览器直连增强」里也有一键安装按钮）。装好后右上角出现「直连增强」徽章即生效。

限制与注意：

- 只接管 `opencode.ai` 的 `POST /inference/*` 与 `POST /zen/*`（`@connect opencode.ai`），不是通用 CORS 破除工具。
- 部署到自己的域名时，把脚本头部的 `@match https://oc2webapi.vercel.app/*` 改成你的域名再安装。
- 页面若设置严格 CSP（`script-src` 不允许内联脚本），页面侧注入会被拦截，控制台会给出提示，此时仍可走中转通道。


## 🧩 实现说明（协议逆向）

OpenCode 免费档只接受"官方 CLI 形状"的请求，本项目在浏览器端完整复刻了该形状（细节逆向自 [opencode2api](https://github.com/jasonxu114514/opencode2api) 项目，协议资产 `prompt-v2.txt` 与 `tools-v2.json` 为官方 CLI 捕获原文）：

- **身份**：会话 ID 按官方 `Identifier.descending()` 布局铸造（`ses_` + 48 位降序时间戳 hex + 14 位 Base62），每个会话固定一枚；项目 ID 为每次请求全新的 40 位 hex（免费档按 `(项目 ID, 出口 IP)` 记账配额）。
- **请求体**：官方 CLI 键序 `model, messages, tools, stream, stream_options, max_completion_tokens`；强制 `stream: true`、`stream_options.include_usage: true`、`max_completion_tokens: 32000`。
- **System Prompt**：完整注入官方 CLI 提示词 + `<env>` 环境块 + 内置技能清单（免费档校验其标记）；用户自定义指令只能追加在其后。
- **工具整形**：追加官方 13 工具集（2.x 版），每个工具 `strict: false`；模型尝试调用工具时，客户端回写"工具不可用"并自动续轮（上限 4 轮），引导模型用纯文字回答。
- **请求头**：`x-opencode-client: cli`、`x-opencode-session(-id)`、`x-session-affinity`、`X-Session-Id`、`x-opencode-project`、`Authorization: Bearer public`（匿名凭证区分大小写）。
- **SSE 解析**：兼容 `delta.content` / `delta.reasoning_content` / `delta.tool_calls` / `usage` / 错误信封与 `[DONE]` 终止符。

代码结构：

```
api/[...path].js          # Vercel Edge Function：白名单透传中转（流式）
public/userscripts/       # 油猴「直连增强」脚本（随站点部署，一键安装）
src/lib/oc.ts             # OpenCode 协议客户端：身份铸造、请求整形、SSE 解析
src/lib/transport.ts      # 通道层：直连 / 中转 / 自动回退
src/lib/bridge.ts         # 油猴脚本检测（设置面板状态与顶部徽章）
src/lib/chat.ts           # 对话引擎：发送循环、工具降级续轮
src/lib/models.ts         # 模型目录（GET /v1/models，浏览器直连 + 缓存）
src/lib/store.ts          # localStorage 会话持久化（useSyncExternalStore 绑定）
src/lib/markdown.ts       # marked + DOMPurify + highlight.js 渲染管线
src/lib/export.ts         # 对话导出（MD / HTML / TXT / 打印）
src/components/           # React UI（shadcn/ui 组件 + 应用组件）
src/assets/oc2/           # 官方 CLI 提示词与工具集（来自 opencode2api 逆向资产）
```

## ⚙️ 配置

全部配置在页面「⚙ 设置」中，保存于本地浏览器：

| 配置 | 说明 |
| --- | --- |
| 请求通道 | 自动 / 仅直连 / 仅中转 |
| 中转地址 | 默认同源 `/api`；可指向自建中转 |
| OpenCode Key | 选填 Zen / Go Key，绕过免费额度；仅保存在本地 |
| 自定义指令 | 追加在官方提示词之后的人设与风格要求 |
| 主题 | 亮 / 暗 / 跟随系统 |

部署侧可选环境变量：`RELAY_TOKEN`（设置后中转要求请求头 `x-oc2-token` 匹配）。

## 🔒 隐私

- 对话内容、会话列表、设置**仅保存在你浏览器的 localStorage**，换浏览器 / 清缓存即消失。
- 服务器（含中转函数）**不存储任何数据**；中转仅转发字节流。
- 填入的 OpenCode Key 与对话内容一样只存本地。

## ⚠️ 限制与免责声明

- 免费额度由 OpenCode 按出口 IP 限额：换网络 / 等待可恢复；使用自己的 Zen/Go Key 可绕过。部署在 Vercel 上时，中转通道的额度由部署平台出口 IP 共享，高峰期更容易触发限流——这正是默认通道设计为"浏览器直连优先"的原因。
- 本项目与 OpenCode 官方无关，属社区逆向实现，**仅供学习研究**；请遵守 OpenCode 服务条款，勿用于滥用场景。协议随上游变化可能失效，欢迎 issue / PR。
- 网页端不执行任何工具（shell / 文件 / 联网抓取等），工具调用会被礼貌拒绝并要求模型改用文字回答。

## 📄 License

[GPL-3.0-or-later](LICENSE)。协议细节与协议资产来自 [opencode2api](https://github.com/jasonxu114514/opencode2api)（GPL-3.0），感谢原作者与 [LINUX DO](https://linux.do) 社区。

---

## English

**oc2webapi** is a browser-only chat UI for OpenCode's free models (anonymous lane, `Bearer public`). Multi-session management, full Markdown rendering on both sides (GFM + syntax highlighting + copy buttons), conversation export (Markdown / self-contained HTML / plain text / print-to-PDF), and streaming SSE responses.

**Hybrid transport**: OpenCode's inference endpoint is not CORS-enabled, so the page first tries a direct browser call (upstream sees the **user's real IP**, whose free quota is independent), and falls back to a same-origin Vercel Edge relay when CORS blocks the response. The model list (CORS-open) is always fetched directly from the browser. The relay is whitelist-limited to `opencode.ai` `/inference/*` and `/zen/*` paths and stores nothing.

**True browser-direct lane (optional userscript)**: install a userscript manager, then the bundled `public/userscripts/oc2webapi-cors-bridge.user.js`. It patches `fetch` inside the page and hands `POST /inference/*` and `POST /zen/*` requests to `GM_xmlhttpRequest`, so the request leaves from the extension (no CORS) while the upstream still sees the user's own egress IP. Response chunks are streamed back into a real `ReadableStream`, so SSE rendering, stop and 429 handling all keep working — and no relay is involved. Only those two POST path prefixes are touched, and nothing leaves the browser except to `opencode.ai`. Install it from the deployed site (`/userscripts/oc2webapi-cors-bridge.user.js`) or via Settings → 浏览器直连增强.

Deploy with the one-click Vercel button above, or `vercel --prod` from the repo. Optional env: `RELAY_TOKEN` (require an `x-oc2-token` header on relay calls). All chat data lives in your browser's localStorage only. Community reverse-engineering project for learning purposes; not affiliated with OpenCode. Protocol details and captured CLI assets come from [opencode2api](https://github.com/jasonxu114514/opencode2api) (GPL-3.0). Licensed under GPL-3.0-or-later.
