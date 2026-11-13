# 抖音项目实现对照

2026-11-13 按主人要求重新对照 GitHub 项目，先研究无需常驻浏览器的方式，暂不实施浏览器会话和远程网页控制的正式接线。浏览器原型的成功与失败仍保留在[验收记录](douyin-source-acceptance.md)，不作为必须常驻浏览器的证明。

## 阅读范围

以下四个项目均核对了当前默认分支的提交和实际代码，未执行它们的程序，也未把作者自测当成本机可用性验收。

| 项目与固定提交 | 登录／会话从哪里来 | 常规取数怎么做 | 对 BN 的参考边界 |
| --- | --- | --- | --- |
| [F2](https://github.com/Johnserf-Seed/f2/tree/f6be8c0ffba9a127075bbeafe4838716650b6325) | 当前 CLI 提供 Cookie 参数及从本机浏览器读取 Cookie 的 `--auto-cookie`；旧扫码内容仍见于历史记录，当前 CLI 不能据此视为提供扫码登录 | `httpx` 请求，Python 本地计算 A-Bogus | 说明日常取数无需浏览器常驻；不能满足 BN 已定的系统扫码登录体验。[Cookie 入口](https://github.com/Johnserf-Seed/f2/blob/f6be8c0ffba9a127075bbeafe4838716650b6325/f2/apps/douyin/cli.py#L55-L94) · [本地签名](https://github.com/Johnserf-Seed/f2/blob/f6be8c0ffba9a127075bbeafe4838716650b6325/f2/apps/douyin/utils.py#L744-L790) |
| [TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader/tree/f766a6eff25b76fe4d737f10c27258e4da65df7d) | 读取／导入 Cookie，按 Cookie 字段提示登录状态；这一提示不能代替向平台核实账号 | `curl_cffi` 发请求，本地 Python 计算 A-Bogus 和受保护接口的 WebSign | 可参考请求参数、接口签名范围与传输环境；其 Cookie 导入方式不能直接替代 BN 的扫码。[Cookie 管理](https://github.com/JoeanAmier/TikTokDownloader/blob/f766a6eff25b76fe4d737f10c27258e4da65df7d/src/module/cookie.py#L32-L84) · [HTTP 客户端](https://github.com/JoeanAmier/TikTokDownloader/blob/f766a6eff25b76fe4d737f10c27258e4da65df7d/src/tools/session.py#L17-L34) · [签名组装](https://github.com/JoeanAmier/TikTokDownloader/blob/f766a6eff25b76fe4d737f10c27258e4da65df7d/src/encrypt/douyin_params.py#L211-L256) |
| [Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/tree/3c045e11aecd58ab076562f1246931b9dd5d909b) | 支持导入会话，自动建立抖音访客会话仍使用浏览器 RPC | 默认原生签名、`wreq` HTTP 传输；浏览器用于初始化及签名回落 | 分清取数与会话初始化。该项目仍有常驻浏览器 RPC 设计，不能把“默认原生签名”说成完全不用浏览器。[原生签名](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/3c045e11aecd58ab076562f1246931b9dd5d909b/src/dtk/signing/native/signer.py#L1-L32) · [浏览器用途](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/3c045e11aecd58ab076562f1246931b9dd5d909b/src/dtk/identity/minting/client.py#L1-L15) · [传输实现](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/3c045e11aecd58ab076562f1246931b9dd5d909b/src/dtk/transport/wreq_transport.py#L114-L137) |
| [Amagi 7.0.0-beta.10](https://github.com/ikenxuan/amagi/tree/f33c1a8c10113c27a625afb0c08ee9e344e1ecfe) | Passport HTTP 扫码、设备票据和 SSO；另有通过首页 HTTP 请求初始化访客会话的实现 | Axios 请求，TypeScript 本地签名，按端点声明所需签名步骤 | 与 BN 技术栈最接近。扫码仍使用 `login.douyin.com` 的 GET 轮询，与本机观测的当前官网主站 POST 有差异，不能原样采信为已解决 2156。[扫码客户端](https://github.com/ikenxuan/amagi/blob/f33c1a8c10113c27a625afb0c08ee9e344e1ecfe/packages/core/src/platforms/douyin/passport/client.ts#L143-L176) · [访客初始化](https://github.com/ikenxuan/amagi/blob/f33c1a8c10113c27a625afb0c08ee9e344e1ecfe/packages/core/src/platforms/douyin/mint.ts#L123-L182) |

## 与 BN 当前实现的具体差距

1. **访客初始化没有接全。** BN 目前读取已有 Cookie 中的 `UIFID` 等标识；登录准备只请求一次首页并续传令牌。Amagi 则另有首页会话初始化、访客标识补齐与缓存。它也记录了服务端可能不给访客标识、补齐后作品详情仍被策略过滤的情况，不能把补齐当作风控必过。[初始化与失败边界](https://github.com/ikenxuan/amagi/blob/f33c1a8c10113c27a625afb0c08ee9e344e1ecfe/packages/core/src/platforms/douyin/mint.ts#L123-L213)
2. **不能给所有数据接口统一加同一套签名。** BN 的搜索也进入通用 A-Bogus 分支；Amagi 的搜索端点仅声明 `msToken(184)`，作品等端点另选 A-Bogus／WebSign。结合本机“只含业务参数的官网请求成功、旧参数对照失败”，应先分接口验证参数策略，尚不能认定某一个参数就是失败原因。[搜索声明](https://github.com/ikenxuan/amagi/blob/f33c1a8c10113c27a625afb0c08ee9e344e1ecfe/packages/core/src/platforms/douyin/endpoints/search.ts#L97-L117) · [各步骤的适用范围](https://github.com/ikenxuan/amagi/blob/f33c1a8c10113c27a625afb0c08ee9e344e1ecfe/packages/core/src/platforms/douyin/sign/steps.ts#L30-L74)
3. **请求环境不仅是 User-Agent。** 两个 Python 项目分别使用带浏览器配置的 `curl_cffi` 和 `wreq` 传输，而 BN 使用宿主 HTTP 客户端。这是需要对照的实现差别，尚未证明它造成了本机失败，不应直接增加跨平台原生依赖。
4. **扫码是独立待解项。** 其他项目通过 Cookie 导入或访客会话取数，并不能证明它们满足 BN 的系统扫码与二次验证要求。Amagi 的设备票据是线索，当前官网的会话校验仍须实际验证。已有 2156 失败记录继续保留。

此前固定的 Amagi `094238d5d5f8c20abba5c3e5c7d03741190e2ab1` 已含访客初始化代码，并非 beta.10 才新增。前期调研没有把这条链路追到 BN 实现里，本次纠正这一遗漏。

后续实现已先修正搜索签名策略，并补登录前的首页 nonce 协商。匿名真网实测协商后可取得访客标识、创建二维码并进入待扫状态；普通数据请求的首次初始化与本轮真人扫码仍待验证，不能将上述差距视为全部补齐。[验收进展](douyin-source-acceptance.md)

## 接下来的验证顺序

先沿现有来源入口和宿主 HTTP 出口验证访客初始化、会话一致性及分接口签名策略，正常轮询继续走 HTTP，不引入常驻网页。扫码和二次验证单独对照当前官网协议，不能以手工 Cookie 导入替换既定首版要求。只有在真实样本仍证明某部分离不开浏览器时，再讨论该部分是否需要临时浏览器辅助。

本文是实现方式调研。没有据此宣告任何第三方项目能在本机稳定取数，也未取消真实资料、作品、图文、直播、图片、历史与统计的验收范围。
