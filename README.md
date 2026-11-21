# GCP 赠金轮询（gcp-credit-rotator）

一个 SillyTavern / TauriTavern 前端扩展：为 **Google Vertex AI** 渠道的服务账号凭据做自动轮换，
让多个 GCP 项目（例如两份赠金）被均匀使用，减少撞上 429 的次数。

---

## 它做什么 / 不做什么

**做：**

- 在酒馆后端 secrets 中保存的多条 Vertex 服务账号之间切换
- 每条回复结束后自动切换到下一条
- 请求撞上上游额度类错误时，立刻换另一个账号把同一请求补发一次
- 在面板里查看当前生效账号、每个账号的额度报错次数与切换次数
- **默认关闭**：装好后不自动启用，需要你在面板右上角手动打开总开关
- **只在你使用 Vertex 渠道时工作**：切到其它源会自动静默，不读凭据、不拦请求、不切账号

**不做：**

- 不修改任何 API 接入设置：区域、模型、认证模式、连接字段一概不碰
- 不做反向代理，不做网关层，不接管请求转发的中间环节
- 不读取、不保存、不上传服务账号私钥内容

---

## 原理

酒馆把 Vertex 服务账号存在后端 `secrets.json` 的 `vertexai_service_account_json` 键下。
同一个键可以有多条记录，但只有一条是 `active`。

前端 `/scripts/openai.js` 在每次请求前会执行：

```js
const activeSecret = secret_state[key].find(s => s.active);
if (activeSecret) generate_data.secret_id = activeSecret.id;
```

后端按 `secret_id` 取出对应的服务账号 JSON 完成鉴权。

所以本扩展只做一件事：**切换哪一条是 active**。
请求体结构、模型、区域、认证方式全部保持酒馆原样。

切换走 `POST /api/secrets/rotate`，再调用宿主导出的 `readSecretState()` 刷新内存状态。
不使用宿主的 `rotateSecret()`，因为后者内部会触发 `#main_api` 的 change 事件，
在生成过程中会打断界面状态。

### 怎么判断「额度报错」

只看 HTTP 状态码并不可靠：酒馆后端对 Vertex 的非流式分支会把上游非 2xx
统一包成 `500`，`429` 被吞掉，body 里才留着上游原文。

因此判定分两层：

1. 状态码是 `402` / `429` → 直接认定
2. 状态码是 `400` / `403` / `5xx` → 用 `response.clone()` 读响应体前 2KB，
   命中 `RESOURCE_EXHAUSTED`、`quota_exceeded`、`insufficient_quota`、
   `rate_limit_exceeded`、`BILLING_DISABLED` 等关键字也算
3. 其它状态码（含 `200`）→ 一律透传，不解析 SSE 流内错误

`clone()` 出来的分支不会影响宿主继续消费原响应，所以不换号的请求行为完全不变。

---

## 安装

### TauriTavern

1. 把 `gcp-credit-rotator` 整个目录放进数据目录的 `extensions/` 下：
   `.../default-user/extensions/gcp-credit-rotator/`
2. 刷新页面（或重启客户端）
3. 打开「扩展程序」，会看到一行 `GCP 赠金轮询`

### SillyTavern

1. 把目录放进 `public/scripts/extensions/third-party/gcp-credit-rotator/`
2. 刷新页面
3. 在「扩展程序」中确认已出现

> 纯前端扩展，没有后端组件，不需要 Node 依赖，不需要安装任何包。

---

## 使用

1. 先在「API 连接设置 → Chat Completion → Google Vertex AI」里配好第一个服务账号（Full 模式），
   确认能正常出字
2. 打开「扩展程序 → GCP 赠金轮询」，点开那一行
3. 展开「导入服务账号」，粘贴第二份 service account JSON 或选择文件，点「导入」
4. 列表里出现两条后，轮换开始自动工作

### 策略选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 总开关 | 开 | 关掉后只保留手动切换，不做任何自动动作 |
| 每条回复后轮换 | 开 | 一轮生成结束后切到下一条；一轮内的多次请求（工具调用等）保持同一账号 |
| 额度报错换号补发一次 | 开 | 撞上上游额度/计费类错误时换另一个账号重发同一请求，只补一次 |
| 冷却时长 | 10 分钟 | 被额度拒绝的账号在这段时间内不再被优先选中 |

---

## 默认关闭，并跟随当前渠道

插件装好之后**默认是关闭的**，不会做任何事：不读凭据、不解析请求、不切账号、不写文件。
需要时在面板右上角把总开关打开。

打开之后，行为还跟随当前渠道：

| 当前源 | 插件状态 |
| --- | --- |
| Google Vertex AI | 工作：读凭据、按策略轮换、拦截额度错误 |
| 其它任意源 | 静默：不读 secrets、不解析请求体、不切账号，请求原样透传 |

切换源时即时生效，不需要刷新页面。收起行的摘要会分别显示
「未启用（总开关关闭）」或「未启用（非 Vertex 渠道）」。

插件不会修改你的连接设置，也不会把谁强制拉到 Vertex 上。

---

## 界面

默认只占扩展列表的一行：左边名称，右边当前生效项目号与凭据数量，最右是总开关。
点击这一行才展开详情。

展开后只有「当前账号」与「凭据列表」常显，导入、策略、记录三块各自折叠，默认全部收起。

---

## 常见问题

**切了账号，但请求里的项目号没变？**
切的是 secrets 的 active 状态，下一次请求才生效；已经在进行中的请求不受影响。

**补发会不会重复消耗额度？**
额度类错误表示上游拒绝了这次请求、没有产出内容，补发不会重复计费。
如果补发仍然失败，扩展会直接把第二次的结果交给酒馆，不会再试第三次。

**能用在 Google AI Studio 上吗？**
不能。本扩展只处理 Vertex AI 的 `vertexai_service_account_json`。

**会不会和 ST-Vertex-PayGo 之类的层级插件冲突？**
不会。本扩展只切换凭据，不改变服务层级、模型或区域。
两者都会包装 `fetch`，本扩展会确保自己在最外层，不重复处理别人的请求。

**删掉一条凭据后统计还在吗？**
统计按凭据 id 记在浏览器 localStorage，删掉该条凭据后对应记录也不再使用。

---

## 隐私与安全

这一节把扩展能碰什么、不能碰什么写清楚，方便任何人对着源码核对。

### 从不读取凭证内容

- 读取凭据列表时只取每条记录的 `id` / `label` / `active`，**连 `value` 字段都不读**
- 代码里没有任何地方把服务账号 JSON 存进变量、日志或 localStorage
- 唯一一次接触完整 JSON，是你在面板点「导入」的那一瞬间：内容只在内存里做结构校验，
  通过后直接交给酒馆的 `writeSecret` 写进后端 secrets，随后立刻清空输入框

### 只请求本机两个端点

| 地址 | 用途 |
| --- | --- |
| `POST /api/secrets/read` `write` `rotate` `delete` `rename` | 读列表、切换生效项、增删改名 |
| `POST /api/backends/chat-completions/generate` | 只做拦截判断，不主动发起 |

没有外部域名、没有统计上报、没有远程配置下发、没有 WebSocket。

### 不执行远程代码

没有 `eval`、没有 `new Function`、没有从网络加载脚本。全部源码可读，无混淆、无压缩。

### 日志只有计数

localStorage 只存两类内容：

- 每个凭据的切换次数、额度报错次数、最后使用时间
- 最近 200 条操作记录（label、状态码、时间）

不存请求体、不存提示词、不存凭证。

### 读请求体，但只用于判断

生成请求的 body 会被 `JSON.parse` 一次，用于确认 `chat_completion_source === 'vertexai'`，
以及在换号时替换 `secret_id`。这份数据不落盘、不上报，处理完即丢弃。

### 零硬编码凭据

仓库里没有任何密钥、令牌、项目号、服务账号邮箱或本机路径。
所有凭据都在**部署之后**从你实机上酒馆的 secrets 里读取。

---

## 边界与免责

- 多账号轮换属于个人额度管理手段，请遵守 Google Cloud 与 Vertex AI 的服务条款
- 是否触发风控取决于上游策略，本扩展不包含任何规避检测的设计
- 赠金余额无法通过 API 查询，扩展只统计请求次数与额度报错次数，不代表剩余额度

---

## 目录结构

```
gcp-credit-rotator/
├── manifest.json
├── index.js
├── style.css
└── src/
    ├── constants.js
    ├── secrets-bridge.js
    ├── credential-validator.js
    ├── rotator.js
    ├── request-guard.js
    ├── panel.js
    └── log.js
```

---

## 协议

[MIT](LICENSE)
