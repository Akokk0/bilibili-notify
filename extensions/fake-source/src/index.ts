/**
 * 假源 —— **开发用**的订阅源拓展(ADR-0019 决策 34 的「devtools 假源」)。
 *
 * 真平台接进来之前,让主人在真机上把订阅源那条路走一遍:平台选择里多一档「假源」、输入框的提示、
 * 解析门的候选(有头像 / 没头像、有粉丝 / 没粉丝)、空 / 超时 / 出错 / 形状不对四种失败、拓展页上的
 * 视图,以及页上那几颗上报按钮(作品 / 开播 / 下播 / 资料 / 直播状态,外加两颗报坏的)。它走的是
 * **正式的注册口**,与以后的抖音拓展同一条路,不在核心里手写第二份。
 */

import type { ExtensionContext } from "@bilibili-notify/extension";
import { wireReportButtons } from "./buttons.js";
import { fakeLookup } from "./lookup.js";
import { fakeSourceView } from "./view.js";

export function activate(ctx: ExtensionContext): void {
	const source = ctx.registerSubscriptionSource({ lookup: fakeLookup });
	const buttons = wireReportButtons(ctx, source);
	// 视图是现取的:订阅名单每次现读,不缓存。
	ctx.publishView(() => fakeSourceView(source.subscriptions(), buttons.blocks()));
	// 订阅一动就喊一声,面板当场重取视图 —— 不然加完一条,切回拓展页那个数还是旧的。
	source.onSubscriptionsChanged(() => ctx.statusChanged());
}
