import { resolve } from "node:path";
import type { BilibiliAPI, BiliDataServer } from "@bilibili-notify/api";
import type { SubscriptionOp } from "@bilibili-notify/internal";
import type { CookieData } from "@bilibili-notify/storage";
// biome-ignore lint/correctness/noUnusedImports: module augmentation
import {} from "@koishijs/plugin-console";
// biome-ignore lint/correctness/noUnusedImports: module augmentation
import {} from "@koishijs/plugin-notifier";
import { type Context, h, type Schema } from "koishi";
import BilibiliNotifyDataServer from "./bridges/data-server";
import { type BilibiliNotifyConfig, BilibiliNotifyConfigSchema } from "./config";
import { installSinglePluginNotice } from "./notices/single-plugin-merge";
import BilibiliNotifyServerManager from "./runtime/bootstrap";
import type { SubscriptionOp as LegacySubscriptionOp } from "./types";

export type { LegacySubscriptionOp, SubscriptionOp };
export { type BilibiliNotifyConfig, BilibiliNotifyConfigSchema };

declare module "koishi" {
	interface Context {
		"bilibili-notify": BilibiliNotifyServerManager;
	}
	interface Events {
		"bilibili-notify/login-status-report"(data: BiliDataServer): void;
		"bilibili-notify/auth-lost"(): void;
		"bilibili-notify/auth-restored"(): void;
		"bilibili-notify/cookies-refreshed"(data: CookieData): void;
		"bilibili-notify/subscription-changed"(ops: SubscriptionOp[]): void;
		"bilibili-notify/ready"(api: BilibiliAPI): void;
		"bilibili-notify/engine-error"(source: string, message: string): void;
		"bilibili-notify/update-config"(config: BilibiliNotifyConfig): void;
	}
}

declare module "@koishijs/plugin-console" {
	namespace Console {
		interface Services {
			"bilibili-notify": BilibiliNotifyDataServer;
		}
	}

	interface Events {
		"bilibili-notify/start-login"(): void;
		"bilibili-notify/reset-key"(): void;
		// biome-ignore lint/suspicious/noExplicitAny: CORS response can be any data URL
		"bilibili-notify/request-cors"(url: string): any;
	}
}

export const inject = {
	required: ["notifier", "console"],
	optional: ["puppeteer"],
};
export const name = "bilibili-notify";

export const usage = /* html */ `
<h1>Bilibili-Notify</h1>
<p><strong>⚠️ 本插件在 Koishi 4 上暂停更新,5.2.1 是最后一版;等 Koishi 升到 v5 再跟进更新。</strong>近期会推出一个薄的 Koishi 适配插件,把 bilibili-notify 独立端(Docker / 桌面版)桥接进 Koishi,之后的新功能都在独立端上做。5.2.1 可以继续用。</p>
<p>使用问题请加群咨询 801338523</p>

---

主人好呀～我是笨笨女仆小助手哒 (〃∀〃)♡
专门帮主人管理 B 站订阅和直播推送的！
女仆虽然笨笨的，但是会尽力不出错哦～
主人，只要按照女仆的提示一步一步设置，女仆就可以乖乖帮您工作啦！

首先呢～请主人仔细阅读订阅相关的 subs 的填写说明 (>ω<)b
【主人账号部分非必填】然后再告诉女仆您的 主人账号 (///▽///)，并选择您希望女仆服务的平台～
接着，请认真填写 主人的 ID 和 群组 ID，确保信息完全正确～
这样女仆才能顺利找到您并准确汇报动态呢 (≧▽≦)

不用着急，女仆会一直在这里陪着您，一步一步完成设置～
主人只要乖乖填好这些信息，就能让女仆变得超级听话、超级勤快啦 (>///<)♡

想要重新登录的话，只需要点击控制台左侧的「扫码登录」哦～

主人～注意事项要仔细看呀 (>_<)♡
- 如果主人使用的是 onebot 机器人，平台名请填写 onebot，而不是 qq 哦～
- 如果需要更灵活的订阅配置，打开「高级订阅」开关就可以啦，不用再装别的插件哦～

乖乖遵守这些规则，女仆才能顺利帮主人工作呢 (*>ω<)b

---
`;

export function apply(ctx: Context, config: BilibiliNotifyConfig): void {
	// v5 单插件合并告知:旧的四个子插件要卸载、配置要重填。迁移期过后删掉这一行即可。
	installSinglePluginNotice(ctx, h);
	// Register DataServer (console WebSocket for login status)
	ctx.plugin(BilibiliNotifyDataServer);
	// Register ServerManager (lifecycle orchestrator). render/ai/dynamic/live
	// are constructed inside its bringUp()/tearDown() lifecycle (runtime/engines.ts),
	// not as independent ctx.plugin() registrations — see runtime/bootstrap.ts.
	ctx.plugin(BilibiliNotifyServerManager, config);
	// ctx.scope here is the bilibili-notify fork tracked by the Koishi loader.
	// Server manager emits this event to update the top-level config entry so changes persist.
	ctx.on("bilibili-notify/update-config", (newConfig) => {
		// biome-ignore lint/suspicious/noExplicitAny: Koishi scope.update typing
		(ctx.scope as any).update(newConfig, false);
	});
	// Add console UI entry
	ctx.console.addEntry({
		dev: resolve(__dirname, "../client/index.ts"),
		prod: resolve(__dirname, "../dist"),
	});
}

export const Config: Schema<BilibiliNotifyConfig> = BilibiliNotifyConfigSchema;
