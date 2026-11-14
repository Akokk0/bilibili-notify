# 抖音订阅源

订阅抖音博主的视频、图文和直播，并在群聊中将作品链接转成卡片。登录和取数使用 HTTP 请求，无需常驻抖音网页，也不需要手动复制 Cookie。

这是 BN 主仓维护的官方拓展，ID 为 `douyin`。当前源码清单版本为 `0.1.0`，需要 **API 1、修订号至少为 2** 的兼容 BN 宿主。本文说明源码和本地构建的用法，不表示该版本已经上架市场。

## 开始使用

1. 在「拓展」页安装兼容的抖音 ZIP 并启用；市场有可用版本时也可从市场安装。将源码放进主仓目录不会自动安装或启用它。
2. 打开「系统 → 账号」，在抖音一行扫码，并在手机端确认。等待 BN 显示「已登录」后再添加订阅。
3. 点击「添加订阅」，选择抖音，输入博主主页、主页分享短链、抖音号或昵称，搜索并选择候选。重名时结合头像和抖音号辨认。
4. 选择推送目标，开启需要的作品、开播、直播中或下播通知，保存订阅。

首次检查用于建立作品基线，**不会补发已有作品**。可以先确认订阅资料是否正常刷新；后续作品和直播变化按下面的轮询规则处理。

### 搜索输入

| 输入 | 用法 |
| --- | --- |
| 博主主页 | `https://www.douyin.com/user/<作者ID>`；也接受 `https://www.iesdouyin.com/share/user/<作者ID>`。 |
| 主页分享短链 | 粘贴包含 `https://v.douyin.com/.../` 的分享文字；展开后必须是博主主页。 |
| 抖音号 | 输入平台展示的抖音号，不加 `@`；优先精确匹配，未匹配时继续按昵称查找。 |
| 昵称 | 最多返回 10 位不同博主，需手动选择。 |
| 作者 ID | 可直接输入 `MS4w…` 格式的完整作者 ID。 |

作品链接用于群聊解析，直播间链接也不是添加博主的入口；添加订阅请使用博主主页。展示的抖音号可能变化，订阅关联使用稳定的作者 ID，不会因改名或修改抖音号而改变。

## 能力与通知规则

| 能力 | 当前行为 |
| --- | --- |
| 博主资料 | 读取昵称、头像、粉丝数、简介和抖音号；平台没有返回的字段保持缺省。 |
| 作品通知 | 支持视频和图文，卡片包含可取得的封面或配图、正文及原链接；不下载或发送视频文件。 |
| 直播通知 | 支持开播、直播中、下播，由轮询观测状态；投递频率和目标由 BN 的订阅设置控制。 |
| 群聊链接 | 支持视频、图文长链及抖音分享短链，解析后使用 BN 的卡片渲染和发送链路。 |

当前没有接入礼物、粉丝团、SC、会员等直播互动，也没有抖音专用私聊指令或 AI 工具。来源没有实现真实作品／直播的卡片预览取数入口；面板的样式预览可能使用示例数据，不能据此判断真实取数是否成功。

### 轮询与首次检查

- 来源启动后立即检查，每 **10 分钟**再检查启用的订阅。博主逐个处理，当前没有批量拉取多个博主资料的接口，也没有抖音专用的轮询间隔设置。新增订阅或修改通知开关会触发相应检查；手动刷新、搜索和群聊解析也可能产生请求。
- 作品首次完整检查只记录基线；后续新作品按发布时间从旧到新上报。旧置顶作品不会被当作新作品，同一秒发布的不同作品会分别判新。分页中断或列表不完整时保留上次完整基线，等待后续检查。
- 作品和直播的观测基线只在当前来源实例内存中保存。重启 BN、停用后重新启用或源码重载后都会重新建立基线；关闭再开启作品通知也会重新建立作品基线。**停止期间的作品没有补推保证。**
- 首次查询直播只同步当前状态，之后观测到状态变化才上报开播或下播；直播场次切换会结束旧场次并开始新场次。请求失败或平台要求验证时保留原观测，不把“查不到”当成下播。轮询之间的短暂开播可能无法捕获。
- 遇到限流、签名不兼容或平台验证时会退避，冷却后再尝试；冷却结束不代表立刻投递，仍取决于下一次请求及其结果。具体分类见维护指南。

### 群聊作品链接

先在 BN 配好可接收群消息的连接，并为对应群开启链接解析，再在群里粘贴作品链接。不必先订阅该作品的博主；抖音来源仍需启用，取数沿用同一登录会话和平台限制。

支持 `www.douyin.com` 下的 `/video/`、`/note/`、`/slides/`，`www.iesdouyin.com` 下对应的 `/share/` 链接，以及 `v.douyin.com` 分享短链。短链必须展开到受支持的抖音地址。解析结果是作品卡片，群聊回卡不作为一次订阅通知记录。

## 登录与排查

扫码后需要完成平台跳转并确认账号，手机显示确认成功还不等于 BN 已完成登录。平台要求短信验证时，按面板提示输入本次尝试的验证码；提供官方验证链接时，按提示到官网处理。验证码过期或重开扫码后，旧尝试不能继续提交。

验证通过的会话由 BN 的加密机密存储保存，重启后会尝试恢复。账号头像异步下载，暂时没有头像不等于登录失败。退出登录会清除本来源保存的凭据。登录流程不依赖浏览器常驻；BN 将卡片转成图片时使用的渲染浏览器是独立功能。

| 现象 | 处理方式 |
| --- | --- |
| 工程清单无效或契约不兼容 | 核对宿主支持的 API 版本／修订号及清单；本版需要 API 1、修订号 2。先更新兼容的 BN，不要通过调低清单修订号绕过检查。开发挂载应选择含 `extension.json` 的工程根目录。 |
| 系统账号页没有抖音 | 检查拓展是否已安装、启用且运行成功，再检查宿主是否支持来源账号。 |
| 扫码返回 2156 或 4031 | 这是平台安全检查拒绝。稍后重新扫码；如官网也无法登录，先处理平台侧限制。App 不一定有额外通知，这些错误不能单独证明账号被封禁。 |
| 手机已确认，但跳转或账号确认失败 | 确认使用当前兼容版本，稍后重新扫码；持续失败时记录提示、错误码和时间。BN 不会仅凭手机确认状态保存一个未核实的账号。 |
| 要求额外验证，但没有可用入口 | 在抖音官方渠道完成账号验证后重新扫码；当前没有内嵌或远程操控官网浏览器的功能。 |
| 提示登录失效 | 到系统账号页重新扫码；不要通过提交 Cookie 到问题报告的方式排查。 |
| 提示限流、验证、签名不兼容或暂时不可用 | 查看系统状态中的问题说明，等待退避后重试，避免连续刷新。未知过滤不会被判成“作品已删除”，查询失败也不会被判成下播。 |
| 新订阅没有发送旧作品 | 首次建立基线的正常行为。需检查目标和开关时，可使用 BN 的目标测试，不要把“没有旧作品补推”当成发送失败。 |
| 群里贴链接没有卡片 | 检查来源登录状态、群消息连接、该群的链接解析开关及宿主问题提示；博主主页和直播间链接不属于作品解析范围。 |

反馈问题时请提供 BN 与拓展版本、ZIP 安装或源码挂载方式、出现时间、完整提示／错误码，以及可公开访问的博主或作品链接。日志先去掉凭据；不要附 Cookie、令牌、二维码、短信验证码或包含签名的请求地址。

真实平台验收已覆盖扫码、账号恢复、搜索、资料、视频／图文及群聊卡片链路。真实新增作品、短信二次验证和开／下播尚保留实机观察项；这些状态已有模拟回归，二者的证据边界见[验收记录](https://github.com/Akokk0/bilibili-notify/blob/dev/docs/1.0/douyin-source-acceptance.md)。

## 主仓开发与安装包

官方源码在 `extensions/douyin/`，通过 workspace 使用 SDK。仓库根目录运行：

```sh
vp install
vp run dev:apps
```

在开发版 BN 的拓展页点击「挂载开发拓展」，选择 **`extensions/douyin` 工程根目录**并启用。宿主直接加载源码，保存后自动重载；普通生产模式不提供开发挂载入口。官方工程不需要创建器的 `.bn-extension/` 配置。

在仓库根构建安装包：

```sh
vp run -F @bilibili-notify/extension-douyin build
vp exec node scripts/pack-extension.mjs --id douyin
```

当前清单对应 `dist/douyin-0.1.0.zip`，在拓展页通过「装拓展」上传并启用。构建和打包不会自动安装，也不会发布到市场。模块、接口、回归与发布细节见[维护指南](https://github.com/Akokk0/bilibili-notify/blob/dev/extensions/douyin/DEVELOPMENT.md)；官方发行沿[拓展市场流程](https://github.com/Akokk0/bilibili-notify/blob/dev/docs/agents/extension-marketplace.md)。

早期仓外验证工程使用 ID `akokko.douyin`。订阅、凭据、历史和统计按来源身份隔离；安装官方版不会自动迁移或覆盖这些数据。已有仓外工程的使用者应先决定保留原来源还是另建官方来源，不能把两个 ID 当作同一个来源直接替换。

## 第三方图形

抖音标识采用字节跳动 [IconPark 的 Tiktok（抖音）字形](https://github.com/bytedance/IconPark/blob/master/packages/react/src/icons/Tiktok.tsx)，以单色适配本面板的平台图标。原始路径保持不变，仅调整 SVG 容器与颜色。

<details>
<summary>IconPark：Apache License 2.0 原文</summary>

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2019-present Bytedance Inc.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

</details>

## 第三方软件许可

本拓展的 `index.mjs` 内联了以下代码。此 README 随拓展 ZIP 分发。

### qrcode 1.5.4（MIT）

登录二维码由 qrcode 生成。包内 `lib/core/qrcode.js` 同时保留原作与 Node.js 移植者的署名。[qrcode 1.5.4 发布包](https://registry.npmjs.org/qrcode/-/qrcode-1.5.4.tgz)。

```text
Copyright (c) 2009 Kazuhiko Arase
Copyright (c) 2011 Ryan Day
The word "QR Code" is registered trademark of DENSO WAVE INCORPORATED.
```

```text
The MIT License (MIT)

Copyright (c) 2012 Ryan Day

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### dijkstrajs 1.0.3（MIT）

qrcode 使用 dijkstrajs 选择二维码的分段方式。原文来自发布包的 `LICENSE.md`。[dijkstrajs 1.0.3 发布包](https://registry.npmjs.org/dijkstrajs/-/dijkstrajs-1.0.3.tgz)。

```text
Dijkstra path-finding functions. Adapted from the Dijkstar Python project.

Copyright (C) 2008
  Wyatt Baldwin <self@wyattbaldwin.com>
  All rights reserved

Licensed under the MIT license.

  http://www.opensource.org/licenses/mit-license.php

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### pngjs 5.0.0（MIT）

qrcode 使用 pngjs 输出可扫码的 PNG。原文来自发布包的 `LICENSE`。[pngjs 5.0.0 发布包](https://registry.npmjs.org/pngjs/-/pngjs-5.0.0.tgz)。

```text
pngjs2 original work Copyright (c) 2015 Luke Page & Original Contributors
pngjs derived work Copyright (c) 2012 Kuba Niegowski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### abogus 2.1.1（MIT）

抖音网页请求使用 abogus 生成签名。原文来自发布包的 `LICENSE`。[abogus 2.1.1 发布包](https://registry.npmjs.org/abogus/-/abogus-2.1.1.tgz)。

```text
MIT License

Copyright (c) 2024 sobird

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Base64 编解码（MIT）

abogus 中的 Base64 编解码包含与 base64-js 相同的分块、查表及尾部填充实现。下列许可证取自对应的公开实现。[base64-js 1.5.1 发布包](https://registry.npmjs.org/base64-js/-/base64-js-1.5.1.tgz)。

```text
The MIT License (MIT)

Copyright (c) 2014 Jameson Little

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### BN 拓展 SDK（MIT）

拓展内联了 `@bilibili-notify/extension` 的结果构造函数。下文为 SDK 随包提供的 `LICENSE`。[SDK 的许可证原件](https://github.com/Akokk0/bilibili-notify/blob/1f050d2b1edfa93005115b42cc330b9a59fe8966/LICENSE)。

```text
MIT License

Copyright (c) 2026 Akokko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Rolldown 运行时辅助函数（MIT）

构建器写入了 CommonJS 互操作函数。以下是 Vite+ Core 1.5.1 中 Rolldown 的许可，以及 Rolldown 为源自 esbuild 的代码保留的许可。[@voidzero-dev/vite-plus-core 1.5.1 发布包](https://registry.npmjs.org/@voidzero-dev/vite-plus-core/-/vite-plus-core-1.5.1.tgz)、[Rolldown 运行时代码](https://github.com/rolldown/rolldown/blob/6322131b0d9dd1e1a030bfbb7ea7de1c03153a74/crates/rolldown/src/runtime/runtime-base.js)、[Rolldown 第三方许可证](https://github.com/rolldown/rolldown/blob/6322131b0d9dd1e1a030bfbb7ea7de1c03153a74/THIRD-PARTY-LICENSE)。

```text
MIT License

Copyright (c) 2024-present VoidZero Inc. & Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```text
MIT License

Copyright (c) 2020 Evan Wallace

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
