# 飞书插件代理支持修改记录

## 修改目的

让飞书插件通过环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 支持网络代理，无需修改配置文件或 openclaw-shim。
覆盖两个连接：

- **HTTP API 调用**（`Lark.Client`）：飞书 REST API
- **WebSocket 长连接**（`Lark.WSClient`）：实时消息接收

## 技术原理

### 问题背景

- gost 代理以原始 TCP 模式运行时（`-L :7890`），WebSocket 通过 `HttpsProxyAgent` 尝试 CONNECT 隧道会失败
- 飞书 SDK 内部使用 `ws` 库创建 WebSocket，需要显式传入 `agent` 参数
- axios 默认会读取代理环境变量，但需要禁用其内置代理避免冲突

### HTTP API（Lark.Client）

- `Lark.Client` 构造函数可接受自定义 `httpInstance`
- 需要注入 `httpsAgent`/`httpAgent` 并设置 `proxy: false` 和 `env: {}` 禁用 axios 内置代理
- 避免代理环境变量被 axios 重复处理导致请求失败

### WebSocket（Lark.WSClient）

- `Lark.WSClient` 构造函数接受 `agent?: any`，内部直接传给 `new WebSocket(url, { agent })`
- 需要同时传入自定义 `httpInstance` 确保获取连接配置时也走代理
- 使用 `https-proxy-agent` 创建 agent 实例

## 修改方案

### 修改文件

`src/core/lark-client.ts`

### 1. 添加 import

在文件顶部添加：

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent';
```

### 2. 添加辅助函数

在 `createProxyAgent` 函数之后添加 `createTimeoutHttpInstance`：

```typescript
function createTimeoutHttpInstance(agent?: HttpsProxyAgent<string>): Lark.HttpInstance {
  const base = Lark.defaultHttpInstance as unknown as Lark.HttpInstance;

  function injectAgent<D>(opts?: Lark.HttpRequestOptions<D>): Lark.HttpRequestOptions<D> {
    const injected = { timeout: 30000, ...opts } as any;
    if (agent) {
      injected.httpsAgent = agent;
      injected.httpAgent = agent;
      injected.proxy = false;
      injected.env = {};
    }
    return injected;
  }

  return {
    request: (opts) => base.request(injectAgent(opts)),
    get: (url, opts) => base.get(url, injectAgent(opts)),
    post: (url, data, opts) => base.post(url, data, injectAgent(opts)),
    put: (url, data, opts) => base.put(url, data, injectAgent(opts)),
    patch: (url, data, opts) => base.patch(url, data, injectAgent(opts)),
    delete: (url, opts) => base.delete(url, injectAgent(opts)),
    head: (url, opts) => base.head(url, injectAgent(opts)),
    options: (url, opts) => base.options(url, injectAgent(opts)),
  };
}
```

### 3. 修改 `get sdk()` 方法（Lark.Client）

```typescript
// 修改前：
get sdk(): Lark.Client {
  if (!this._sdk) {
    const { appId, appSecret } = this.requireCredentials();
    this._sdk = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: resolveBrand(this.account.brand),
    });
  }
  return this._sdk;
}

// 修改后：
get sdk(): Lark.Client {
  if (!this._sdk) {
    const { appId, appSecret } = this.requireCredentials();
    const agent = createProxyAgent();
    this._sdk = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: resolveBrand(this.account.brand),
      httpInstance: createTimeoutHttpInstance(agent),
      ...(agent ? { agent } : {}),
    });
  }
  return this._sdk;
}
```

### 4. 修改 `startWS()` 方法（Lark.WSClient）

```typescript
// 修改前：
const { appId, appSecret } = this.requireCredentials();
// ... close existing WSClient ...
this._wsClient = new Lark.WSClient({
  appId,
  appSecret,
  domain: resolveBrand(this.account.brand),
  loggerLevel: Lark.LoggerLevel.info,
  agent: createProxyAgent(),
});

// 修改后：
const { appId, appSecret } = this.requireCredentials();
const agent = createProxyAgent();
// ... close existing WSClient ...
this._wsClient = new Lark.WSClient({
  appId,
  appSecret,
  domain: resolveBrand(this.account.brand),
  loggerLevel: Lark.LoggerLevel.info,
  httpInstance: createTimeoutHttpInstance(agent),
  ...(agent ? { agent } : {}),
});
```

## 使用方式

启动 Orange 前设置环境变量：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
# 或
export HTTPS_PROXY=http://127.0.0.1:7890
orange gateway restart
```

## 注意事项

- `https-proxy-agent` 是 `openclaw` 包的间接依赖，已存在于 pnpm 依赖树，无需修改 `package.json`
- 必须设置 30s 超时避免请求无限挂起
- 必须禁用 axios 内置代理（`proxy: false`, `env: {}`）避免重复处理导致请求失败
- 若未设置代理环境变量，`createProxyAgent()` 返回 `undefined`，行为与原来完全一致
- HTTP API 和 WebSocket 均走同一个代理地址（`HTTP_PROXY` 或 `HTTPS_PROXY`）

## gost 代理配置建议

如果遇到代理问题，可以尝试以下 gost 配置：

```bash
# 使用明确的 HTTP 代理模式
gost -L http://:7890

# 或支持 TLS 隧道
gost -L http://:7890 -F forward://+tls:7891
```

## 修改时间

2026-04-02
