# 应用内自主升级

独立端(Docker + Desktop)可以在应用内换版本,不必重拉镜像或重下安装包。
koishi / AstrBot **不在范围内** —— 那两端由各自宿主管更新。

## 一句话机制

发版时打一个**自包含载荷 zip**、签一份清单挂到 GitHub Release;客户端验签、下载、
解进 `<dataDir>/versions/<版本>/`,**重启时由 `boot.mjs` 选中它**。安装包 / 镜像
自带的那份永远不动,所以随时能退回去。

```
镜像 /app/                        用户数据 <dataDir>/versions/
├── boot.mjs   ← CMD 跑的是它      ├── boot-state.json   选版记账 + 回退钉子
├── index.mjs                     └── 0.9.0/
├── package.json                      ├── index.mjs      ← 被选中就加载它
└── web-dist/                         ├── package.json
                                      └── web-dist/
```

`boot.mjs` 是**单独一个 bundle 入口**,只牵 node 内建 + 选版那一小块。塞进
`index.mjs` 顶上不行:ESM 的 import 是提升的,那样会先把镜像那份服务端的整张模块图
加载完,再加载一遍载荷那份,内存直接翻倍。

选中之后是**同进程 `import()`**,不是 spawn:少一个常驻进程、不用转发信号,而且
载荷里的 `import.meta.url` 指向它自己的目录 —— dashboard 资源与版本号因此自动跟着走。

## 密钥(**发版前必须先做这一步**)

签名是代理站能被放进链路的**唯一**理由:有签名,代理站最多只能拒绝服务;没签名,
它可以换掉任意一段将要被执行的代码。

**两把**,且必须**从第一个发出去的版本起就都在信任列表里**:

| | 用途 | 放哪 |
|---|---|---|
| A 主用 | 每次发版签清单 | CI secret `BN_UPDATE_SIGNING_KEY` + 离线备份 |
| B 备用 | A 泄露时的唯一退路 | **只在离线备份里,永远不进 CI** |

信任列表是**冻在已经发出去的那些安装里**的。A 泄露那天,唯一的办法是用 B 签一版、
把 A 踢出列表 —— 而事后再加公钥救不了任何存量用户,他们的客户端只认出厂时带的那几把。
所以 B 只有在第一版就在场才有意义。

### 生成

```bash
# 各生成一把(A、B 各跑一次,分别存好)
openssl genpkey -algorithm ed25519 -out bn-update-A.pem
openssl genpkey -algorithm ed25519 -out bn-update-B.pem

# 取公钥的 SPKI DER(base64)—— 这一串填进代码
openssl pkey -in bn-update-A.pem -pubout -outform DER | base64
openssl pkey -in bn-update-B.pem -pubout -outform DER | base64
```

把两串公钥填进 `apps/server/src/update/trusted-keys.ts` 的 `TRUSTED_UPDATE_KEYS`。
**空列表 = 功能关着**(客户端会明说「本构建未启用」,不会报成验签失败),fork 出去自己
构建的人默认就落在这一档。

私钥 A 进 repo secret(PEM 换行在 secret 里容易丢,所以脚本也收 base64 包过一层的):

```bash
base64 < bn-update-A.pem | gh secret set BN_UPDATE_SIGNING_KEY
```

两把私钥离线各存一份(密码管理器 / 冷存储)。**丢了 A 还能用 B 顶上;两把都丢,
存量用户就再也收不到能验过签的更新了。**

## 渠道入口

清单挂在一个**滚动的** `update-channel` release 上:

- `https://github.com/Akokk0/bilibili-notify/releases/download/update-channel/stable.json`
- `…/update-channel/alpha.json`

不用 `releases/latest/download/` 是因为它按定义指向最新的**正式**发布,预发布渠道就
永远拿不到自己那份。也**不碰 `api.github.com`** —— 代理站不代理 API,而且 API 的回答
上没有我们的签名。清单和载荷同域同前缀,用户填**一条**加速前缀就同时管住两者。

正式版发布同时刷 `stable.json` 与 `alpha.json`(预发布渠道的用户也该拿到更新的正式版,
否则会卡在某个旧 alpha 上);预发布只刷 `alpha.json`。

## 发版流程

`v<VERSION>` tag 触发 `update-payload.yml`,与 Docker / Desktop 两条路**互不阻塞**。
它做四件事:

1. `vp run build:update-payload` —— 构建 web + server 自包含 bundle + 装配资产
2. `node scripts/build-update-payload.mjs` —— 打 zip,交出 sha256 / size
3. `node scripts/sign-update-manifest.mjs` —— 生成并签署清单信封
4. 上传到 `v<VERSION>` release,并覆盖 `update-channel` 上对应渠道的清单

没配 `BN_UPDATE_SIGNING_KEY` 时**整条跳过并打 warning**,不让发版红着 —— 但那次发版
的用户也就没有应用内更新。

## 撤回一个坏版本

两道闸,缺一不可:

- **服务端撤回**:在下一份清单的 `revoked` 里列上坏版本号。这只拦得住**还没升的人**。
- **客户端自愈**:已经中招的那批靠 `boot.mjs` —— 连续起不来到上限就把那一版判死,
  自动退回上一版。这条路**压过用户手动钉的版本**,否则退到一个也起不来的版本就是
  死局(进不去面板 = 拔不掉钉子)。

## 几条不许动的约定

- **`startStandaloneServer` 这个导出是向前兼容契约。** 镜像里的 `boot.mjs` 是冻住的,
  它得能启动任何未来版本的载荷。改名 = 老镜像上的用户更新完打不开。
- **清单以字符串放进信封,信封本身从不被签。** 展开成对象就要求验签时重新序列化,
  而 JSON 的重新序列化不唯一(键序/空白/数字写法/unicode 转义)—— 两边差一点就验不过,
  且完全查不出原因。
- **`webDistDir` / `--web-dist` 一旦写死,前端就不跟着升级走了。** 两端都已经改成
  「相对载荷入口就近解析」,别再加回显式路径。
- **只保留当前 + 上一版**,回退只退一步,不给版本列表。用户想要更老的版本,自己去下
  老镜像 / 老安装包,风险自负。
- **清理只碰长得像版本号的目录**。`/data` 是用户挂出来的,他真的会往里丢东西。

## 相关文件

| 位置 | 干什么 |
|---|---|
| `apps/server/src/boot.ts` | 选版 + 同进程加载载荷,回落镜像 |
| `apps/server/src/update/` | 验签 / 决策 / 落盘 / 镜像站 / 选版自愈 / 清理 / 编排 |
| `apps/server/src/routes/update.ts` | `GET /api/update` 与 check/download/apply/rollback |
| `apps/web/src/components/update/` | 系统页那一节 |
| `scripts/build-update-payload.mjs` | 打载荷 zip |
| `scripts/sign-update-manifest.mjs` | 生成 + 签署清单 |
| `.github/workflows/update-payload.yml` | 发版侧 |
