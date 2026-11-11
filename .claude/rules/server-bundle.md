---
paths:
  - "packages/*/package.json"
  - "apps/server/package.json"
  - "apps/server/vite.config.ts"
  - "apps/desktop/**"
  - "apps/Dockerfile"
  - "scripts/assemble-server-bundle.mjs"
  - "scripts/server-bundle-assets.mjs"
---

# server 自包含 bundle 与四种发行形态

- **server 是自包含 bundle(入口 + hash 分块,旁边没有 node_modules)**:给 `packages/*` 加**新第三方依赖**时,凡是运行时用 `__dirname` / `require.resolve` 去磁盘上读**自己包内文件**的(jieba-wasm 读 `.wasm`;jsdom 读 `xhr-sync-worker.js` 也是这一类,3a 起运行时已不带 jsdom,只剩测试在用),内联进 bundle 后**必炸**,且**构建全绿、只在运行期炸**。要么在 `scripts/assemble-server-bundle.mjs` 里随载荷拷资源并登记进 `scripts/server-bundle-assets.mjs`(装配自检 / 升级载荷 / 桌面资源三处共用那份清单),要么在 `apps/server/vite.config.ts` 的 bundle 配方里外置。加完新依赖务必 `vp run build:update-payload` 走一遍装配自检。
- **四种发行形态吃同一份载荷**:Docker 镜像、桌面安装包、应用内更新及npm正式宿主装的都是 `apps/server/dist`(bundle + 装配好的资产)+ web dist,桌面资源目录里**没有 node_modules**。桌面产物的布局只声明在 `apps/desktop/layout.json`,别在别处再抄一份路径。

- **npm另带明确构建用途的开发宿主**：沿ADR-0046独立装配，源码加载器作为启动器的公开npm依赖保留运行资产；正式宿主仍自包含，环境变量不能把正式产物变为开发版。
