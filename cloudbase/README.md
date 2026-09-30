# Rippleshe · CloudBase 后端

当前唯一正式架构：

```text
访客浏览器
→ https://rippleshe.cyou
→ 同源 /api/guestbook/*
→ EdgeOne Edge Function
→ CloudBase Email Auth（首次注册验证码 + 后续邮箱密码）/ PostgreSQL RPC
→ auth.uid() / auth.email() / RLS / PostgreSQL 事务
```

CloudBase **不再负责正式前端 Hosting**。正式前端只发布到 EdgeOne Makers。

## 1. 当前环境

```text
EnvId   rippleshe-blog-d0gdjxo8tc4ebc075
Region  ap-shanghai
DB      PostgreSQL
```

当前登录策略：邮箱登录开启、用户名/密码登录开启；手机号和匿名登录关闭。

普通访客只在**第一次创建账号**时收一次邮箱 6 位验证码，并同时设置密码；注册完成后，后续登录固定使用 **邮箱 + 密码**，不再反复发邮件。主人页继续使用邮箱验证码 + owner UID 白名单作为管理入口。浏览器仍只访问 EdgeOne 同源 API，不直连 CloudBase。

## 2. 安全边界

- 浏览器不直连 CloudBase 网关；
- 浏览器 bundle / HTML 不包含 CloudBase SDK、PG 网关 URL 或 Publishable Key；
- Publishable Key 只在构建时注入 EdgeOne Edge Function；
- 不存在 service-role Key；
- 不存在正式 Cloud Function；
- 业务表不给 `anon` / `authenticated` 原始表权限；
- 公开读、本人资料、留言和主人操作全部通过 PostgreSQL RPC；
- 身份只信任 `auth.uid()` / `auth.email()`；
- EdgeOne 写操作要求同源 Origin；
- access / refresh token 只存 `HttpOnly; Secure; SameSite=Lax` Cookie，页面 JS 读取不到。

## 3. 数据库真源

```text
cloudbase/schema.sql
cloudbase/web-rpc.sql
```

应用 schema：

```bash
pnpm cloudbase:schema
```

脚本会先检查 SQL 函数分隔符和关键 RPC，再调用 `ExecutePGSql`。所有 DDL / RPC 都应保持幂等。

正式设置保存在：

```text
rippleshe_guest_settings
```

当前正式状态为长期开放：

```text
registration_open = true
registration_until = null
writing_open = true
writing_until = null
```

临时测试仍可使用数据库级 TTL：

```bash
pnpm cloudbase:gate registration on 30m
pnpm cloudbase:gate writing on 5m
pnpm cloudbase:gate registration off
pnpm cloudbase:gate writing off
pnpm cloudbase:gate registration status
```

规则：

- `registration on` 未写 TTL 时默认 30 分钟；
- `writing on` 未写 TTL 时默认 5 分钟；
- 可显式使用 `10m`、`1h`，上限 24 小时；
- 只有明确写 `permanent` 才允许无过期时间的长期开放；
- 到达 `registration_until / writing_until` 后，公开 config 与新注册入口会自动视为关闭，不依赖本机脚本继续运行；
- `registration` 只控制“能否开始新的邮箱注册验证”；已经在开放窗口里完成邮箱认证的来客，即使 TTL 随后关闭，也允许补完来客签，避免半注册状态；
- `off` 会同时清掉对应 TTL。

`pnpm audit:cloudbase` 会在回滚事务中攻击“已过期 TTL 必须 fail closed”这一性质。

主人白名单：

```text
rippleshe_guest_owners
```

## 4. 主人初始化

不要开放公网注册来创建主人账号。

使用：

```bash
pnpm cloudbase:owner <主人邮箱>
```

行为：

```text
按邮箱精确查询 CloudBase 用户
→ 已存在：复用
→ 不存在：创建无密码邮箱用户
→ 再次查询真实 UID
→ UID 幂等写入 rippleshe_guest_owners
→ 不修改 registration_open / writing_open
```

然后访问：

```text
https://rippleshe.cyou/visitors/
```

输入主人邮箱，收 6 位验证码。主人页本身带 `noindex,nofollow,noarchive`，数据库层仍以 UID 白名单作为最终授权。

## 5. EdgeOne 同源 API

源码：

```text
edge-functions-src/guestbook.js
```

构建时：

```text
scripts/package-edgeone.mjs
```

会生成：

```text
dist/edge-functions/api/guestbook/[[path]].js
```

公开只读：

```text
GET /api/guestbook/health
GET /api/guestbook/config
GET /api/guestbook/messages
GET /api/guestbook/me
GET /api/guestbook/owner/status
```

认证：

```text
POST /api/guestbook/auth/send      # 首次注册 / 主人验证码
POST /api/guestbook/auth/verify    # 首次注册 / 主人验证码确认
POST /api/guestbook/auth/password  # 普通访客邮箱 + 密码登录
POST /api/guestbook/logout
```

来客：

```text
POST /api/guestbook/profile
POST /api/guestbook/post
```

主人：

```text
GET  /api/guestbook/owner/visitors
GET  /api/guestbook/owner/messages
POST /api/guestbook/owner/delete-user
POST /api/guestbook/owner/delete-message
```

注册关闭时，`auth/send` 的 register 模式会在发送邮件之前直接拒绝，因此不会因为误点而寄注册验证码。

## 6. 本地与生产严格分开

本地开发：

```text
127.0.0.1:4173  Astro
127.0.0.1:4175  添一页
127.0.0.1:4185  SQLite Guestbook
```

本地仍使用邮箱 + 密码和 owner key，方便本机开发与手动验收；这些 UI / key 都不会进入正式站。

生产：

```text
EdgeOne + CloudBase Email Auth（首次验证码 + 后续密码）+ CloudBase PG
```

## 7. 发布门禁

只检查，不上传：

```bash
pnpm release:check
```

顺序：

```text
Astro check + build
→ Edge Function 打包
→ 轻量静态 production audit
```

CloudBase schema/RPC/auth 有改动时再单独跑 `pnpm audit:cloudbase`；依赖有改动时再跑 `pnpm audit:deps`。普通内容/样式修改不重复跑这些无关审计。

真正发布：

```bash
pnpm release:site
```

真正上传前，`release.mjs` 会从公网 `/api/guestbook/config` 再读一次开关。**永久开放**（`*_open=true` 且 `*_until=null`）可以正常发布；只有临时 TTL 测试窗口仍有效时才拒绝发布，避免把测试状态混进正式部署。

额外执行：

```text
EdgeOne Makers direct upload ./dist
→ https://rippleshe.cyou
→ 真实公网 Chrome audit
```

发布命令不会修改 PG schema、注册开关、写字开关或主人白名单。

## 8. 自动审计

```bash
pnpm audit:cloudbase
pnpm audit:prod
pnpm audit:edgeone
```

`audit:edgeone` 只保留高价值公网检查：

- Guestbook health/config/messages 正常；
- 公开留言不含邮箱；
- 错 Origin POST 返回 403；
- 浏览器不直连 CloudBase；
- 注册按钮状态与真实 gate 一致；
- 普通访客登录控件完整；
- 主人页无 owner key 且带 noindex；
- console 0 error。

## 9. 当前正式状态

生产链已经完成真实注册、密码重登、留言、主人查看、删除留言、移出来客和公开隐私验收。当前长期开放：

```text
registration_open = true
registration_until = null
writing_open = true
writing_until = null
```

临时测试时仍可使用 TTL；正式开放不要设置 `*_until`。
