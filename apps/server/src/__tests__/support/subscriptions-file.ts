import type { SubscriptionTag } from "@bilibili-notify/internal";

/**
 * 新代盘上的订阅文件内容(`config/subscriptions.json`,ADR-0034):`{ tags, subscriptions }`,标签表与订阅住
 * 同一个文件;不是 0.x 的裸数组(那个形状开机会被整个拒,改形归迁移)。
 *
 * 往新代的 config 目录直接摆订阅夹具时用它。**0.x 的输入别用** —— 迁移器的输入就是裸数组那个老样子。
 * 行收任意对象:有的用例要摆缺格 / 带坏格的行,验开机读时补默认或整份拒。
 */
export function subscriptionsFileText(
	subs: readonly object[],
	tags: readonly SubscriptionTag[] = [],
): string {
	return JSON.stringify({ tags, subscriptions: subs });
}
