# 认证 API 域名与应急回退

`api.jojokanbao.cn` 是 Supabase 项目 `hrueccyqzfzduzfmqcia` 的自定义入口域名，
承载 GoTrue 认证与 PostgREST 数据访问。本页描述它当前的接入结构、已知线路
风险，以及直连不可用时的应急回退操作。

## 当前结构（2026-10 起）

三端客户端（Web / Mobile / Desktop）**直连** Supabase 项目，不经过 EdgeOne：

```text
客户端 ──(VITE_SUPABASE_URL)──→ https://hrueccyqzfzduzfmqcia.supabase.co
```

- `VITE_SUPABASE_URL` 配置在根 `.env` 与 GitHub variable（同名）两处，
  Mobile 构建经由 `EXPO_PUBLIC_SUPABASE_URL` 回退读取同一值。
- 客户端直连依赖用户线路到 `supabase.co` 的可达性，个别线路间歇被干扰时
  会报「暂时无法连接账号服务」。这是把可用性交给用户线路的已知取舍。
- `api.jojokanbao.cn` 保留并继续指向同一 Supabase 项目（EdgeOne global
  zone `zone-3lvq1mme05le`，dnsPodAccess 接入，回源直连 supabase.co），
  作为直连异常时的传统入口与调试入口。

## 读者代理（可选）

`VITE_SUPABASE_PROXY_PATH` 未设置时，Web 客户端照旧直连项目域名。设置为
`/api/supabase` 后，直连仍是主路径，只有连接层失败（TLS 被重置、连不上）时，
同一个请求才重放到同源代理，由上海云函数代为访问项目。用路径而不是绝对域名，
是为了让同一份构建在 beta 与生产都指向各自的源。

重放只覆盖连接失败：超时或主动中断的请求可能已经送达，不能重放，否则会重复
发送验证码或重复写入。

代理按路径分流：

- `/auth/v1/*` 用 `SUPABASE_SECRET_KEY` 重签，并写入 `Sb-Forwarded-For`
  （取自 EdgeOne 的 `EO-Connecting-IP`）。Supabase 只对 secret key 采信该
  头；需在 Authentication → Rate Limits 打开 IP Address Forwarding，限流才会
  按读者地址而不是函数出口地址计数。
- `/rest/v1/*` 原样透传浏览器的 publishable key 与 JWT。这里改用 secret key
  会让未登录请求以 `service_role` 执行、绕过 RLS，因此不能重签。
- 上游返回 404 时统一应答 410：EdgeOne 会把 GET 系请求的转发 404 扣住直到
  客户端超时，410 能正常送达。

## 已知线路风险

EdgeOne 中国大陆**移动**运营商边缘节点回源 `supabase.co` 时，TLS 握手会被
跨境 SNI 阻断，EdgeOne 返回 **HTTP 525**（SSL Handshake Failed with Origin
Server）。联通、电信节点正常。该阻断按出口线路与时间波动，因此故障表现为
「部分移动网络用户登录失败、其他用户正常」。

排查方法：

```bash
# 1. 用 DoH 模拟运营商视角，拿到各运营商命中的边缘节点 IP
curl -s "https://223.5.5.5/resolve?name=api.jojokanbao.cn.eo.dnse2.com&type=A&edns_client_subnet=120.196.0.0/16"

# 2. 逐节点直测：525 = 回源被阻断；401 = Kong 正常拦 key（健康）
curl -s -o /dev/null --noproxy '*' --resolve api.jojokanbao.cn:443:<节点IP> \
  -w "%{http_code}\n" "https://api.jojokanbao.cn/auth/v1/health"
```

注意：本机开发环境若开 fake-ip 模式代理（Clash 等），DNS 解析与境外 IP
直连测试会被代理干扰，结论不可信。

## 应急回退：海外中转

若阻断导致大量移动用户无法登录（EdgeOne 侧短期无法修复时），可把
`api.jojokanbao.cn` 回源切到预置的海外中转域名，链路变为：

```text
移动节点 ──TLS(SNI=supabase-pull.jojokanbao.cn，不受阻断)──→ EdgeOne 海外节点
         ──→ supabase.co
```

中转配置已预置并保留：

- 海外 zone `zone-3ta11vwyf8to`（`jojokanbao.cn`，overseas，2026-10-02 已启用）
- 加速域名 `supabase-pull.jojokanbao.cn`，回源 `hrueccyqzfzduzfmqcia.supabase.co`，
  免费证书 `teo-3vonj4xqtlcl`（eofreecert）
- DNSPod 记录：`supabase-pull` CNAME → `supabase-pull.jojokanbao.cn.eo.dnse2.com`；
  `_dnsauth.supabase-pull` CNAME → `supabase-pull.jojokanbao.cn.eoacme0.com`（证书验证）

切换（回源 Host 必须是中转域名本身，第二跳由中转自身配置以 supabase.co
作为 Host 拉源）：

```bash
tccli teo ModifyAccelerationDomain --ZoneId zone-3lvq1mme05le \
  --DomainName api.jojokanbao.cn \
  --OriginInfo '{"OriginType":"IP_DOMAIN","Origin":"supabase-pull.jojokanbao.cn","HostHeader":"supabase-pull.jojokanbao.cn"}' \
  --OriginProtocol HTTPS --HttpsOriginPort 443
```

切回直连把 `Origin` / `HostHeader` 换回 `hrueccyqzfzduzfmqcia.supabase.co`
即可。配置下发约 2-5 分钟（域名状态 `process` → `online`），切换后用上面的
逐节点直测验证各运营商节点均为 401。

中转的代价：多一跳跨境链路，冷请求 1-5 秒且偶发数秒停滞，会撞上客户端
`@jojo/auth` 读者代号请求的 12 秒超时（该请求已有一次自动重试兜底）。
因此中转只作为阻断复发时的应急通道，不做常态。

## IPv6

Zone 的 `Ipv6.Switch` 已关闭（2026-10-02）。此前 AAAA 指向联通 IPv6 边缘
节点，移动网络（IPv6 优先）跨网不可达。客户端直连 supabase.co 不受此开关
影响；若重新开启 zone IPv6，需先确认移动 → 联通 v6 的可达性。

## 可观测性

- EdgeOne zone **未配置实时日志推送**，`EO-LOG-UUID` 无法用于逐请求检索。
  需要逐请求取证时先在控制台开启实时日志（推送 CLS）。
- 搜索服务 `flask_jojo_search` 的 CLS 日志配置见
  `infrastructure/tencent-scf/search/README.md`。
