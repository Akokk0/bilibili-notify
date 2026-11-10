# bilibili-notify extension SDK

BN拓展的公开契约与构建辅助。仅支持ESM和Node.js 24及以上；宿主兼容性按拓展清单的`apiVersion` / `apiRevision`判断，与SDK的npm版本号分开。

## 入口

- `@bilibili-notify/extension`：拓展运行代码使用的类型、`ok()` / `fail()`及中性平台描述辅助。
- `@bilibili-notify/extension/build`：只给构建配置使用的清单导出与文件复制插件。

拓展从SDK这一处获取BN契约，第三方依赖由拓展自己声明。SDK不提供宿主内部模块、MessageBus或订阅配置的写路径；副作用和收尾经宿主交给拓展的ctx执行。

```ts
import type { ExtensionContext, SourceDef } from "@bilibili-notify/extension";
import { ok } from "@bilibili-notify/extension";

const source: SourceDef = {
  start() {},
  stop() {},
  async searchCreators() {
    return ok({ candidates: [] });
  },
};

export function activate(ctx: ExtensionContext) {
  ctx.registerSource(source);
}
```

完整拓展还需根目录的`extension.json`声明来源外观与能力。`settingsSchema`和`connectionSettingsSchema`可由构建辅助生成清单设置字段。创建工程、当前1/0契约、生命周期、上报、设置、译文和发布见[作者指南](./DEVELOPMENT.md)，此文件也包含在npm包里，可在安装目录直接读取。

## Agent 开发入口

[Agent 契约指引](./AGENT_GUIDE.md)和[开发 skill](./skills/bn-extension-development/SKILL.md)随包提供。创建器会在新工程生成 `AGENTS.md`、`CLAUDE.md`，并为 Codex 与 Claude 准备共享正文的 skill 入口。手工搭建工程时，可把包里的 `skills/bn-extension-development` 复制到项目的 `.agents/skills/`，再将本包的 agent 指引接入已有项目说明。

## 源码与发行目录

仓内SDK仍是私有workspace包，源码从internal转出唯一契约定义。构建会内联所需实现和类型，并在`lib/`生成独立的公开npm清单、说明和许可证；仓外消费者不需要internal。

在主仓根执行：

```sh
vp run -F @bilibili-notify/extension build
vp -C packages/extension pm pack --out sdk.tgz
```

`publishConfig.directory`使归档使用`lib/`中的公开清单。SDK与创建器各自的版本保存在对应`package.json`，与主程序的开发占位版本、宿主API档位分开。发行前先完成仓外工程验证，再发布已验过的归档。
