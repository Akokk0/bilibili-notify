/**
 * 开发者工具(devtools)场景的中立词汇 —— 核心、B 站与拓展共用。
 *
 * 拓展从 `@bilibili-notify/extension` 拿(那里转出一道),面板经 `@bilibili-notify/contract` 拿。
 */

import type { Result } from "./result";

/**
 * 面板左栏的五组。`web` 是浏览器里跑的那半,其余四组都在服务端。
 */
export type DevScenarioGroup = "event" | "state" | "timer" | "capture" | "web" | "ext";

/**
 * 一个参数字段。七种,面板照 `kind` 画控件:
 *
 * - `sub` / `target` / `connection` —— 从站内既有列表里挑一个(订阅 / 推送目标 / 连接),
 *   值是它们的 id。**只给核心的场景**:别家认领时用了就整包拒(ADR-0031 决策 2)。
 * - `creator` —— 交这个场景的那个来源名单里的一个人,值是他的 `externalId`;名单是来源 `ctx.subscriptions()`
 *   那一份(启用的、按人去重)。给了不在名单里的,宿主回 `invalid`。
 * - 上面四种**省略时的默认值住服务端**(场景自己挑,比如第一个启用的订阅),面板不猜。
 * - `number` / `enum` / `text` —— 自带默认值。
 */
export type DevParamField =
	| { key: string; label: string; kind: "sub" }
	| { key: string; label: string; kind: "target" }
	| { key: string; label: string; kind: "connection" }
	| { key: string; label: string; kind: "creator" }
	| { key: string; label: string; kind: "number"; default: number; min?: number; max?: number }
	| {
			key: string;
			label: string;
			kind: "enum";
			options: ReadonlyArray<{ value: string; label: string }>;
			default: string;
	  }
	| { key: string; label: string; kind: "text"; default?: string; placeholder?: string };

export interface DevScenarioDescriptor {
	/**
	 * 全局唯一,两半共用一个命名空间(`core.update.state` / `bilibili.live.start` / `web.toast-flood`)。
	 * 服务端那半在场景里写不带前缀的短名,`<提供方>.` 由宿主汇总时加。
	 */
	id: string;
	/**
	 * 交这个场景的那一家:`core`、来源键或拓展 id。宿主汇总时填,场景里写了也会被盖掉;面板那半的场景没有这一格。
	 * 面板的 `creator` 选择器按它挑那个来源的人。
	 */
	provider?: string;
	group: DevScenarioGroup;
	title: string;
	/** 一句说明:它会造成什么、以及要注意什么(「按重启会真的退出」)。 */
	desc?: string;
	params: DevParamField[];
	/** 在左下角药丸上占一个快捷位 —— 只给最常按的那几个。 */
	quick?: boolean;
	/**
	 * 图标名(`@bilibili-notify/ui` 的 `IconName`),快捷位与卡片上用;不给就按分组取。
	 * 同一组里有两个快捷位时必须给 —— 开播 / 下播都画成铃铛就分不清了。
	 */
	icon?: string;
}

/** 面板交上来的参数:key → 值。缺的字段服务端按默认值补。 */
export type DevParamValues = Record<string, string | number>;

/**
 * 当前生效的一条注入(假状态 / 截流 / 单点覆盖)。事件类场景跑完即走,不在这里;
 * 状态类的一直生效到收摊,或者到那条真动作把它顶掉。
 */
export interface DevInjection {
	/** 谁造的 —— 场景 id;收摊按它找。 */
	scenarioId: string;
	/** 一句人话,「当前生效」条上念的:「更新状态 → ready 0.99.0」。 */
	label: string;
}

export interface DevScenarioDef extends DevScenarioDescriptor {
	run(params: DevParamValues): Result<{ summary?: string }> | Promise<Result<{ summary?: string }>>;
	/** 状态类场景:现在生效着的那条注入,没有就 null。事件类不写。 */
	active?(): DevInjection | null;
	/**
	 * 状态类场景:收摊。可以是异步的 —— 有的收摊要写盘(静音),写失败得能一路冒到路由,
	 * 而不是变成一个没人接的 promise 把进程带走。
	 */
	reset?(): void | Promise<void>;
}

/**
 * 一家集成交给 devtools 的那一包场景。B 站是第一个实现者(`bilibili/devtools/`),拓展经
 * 清单 `contributes.devtools` 的开发入口交它(只在开发版)。
 *
 * 场景里写**不带前缀**的 id:提供方前缀由汇总那一处统一加(`providers.scenarios()`),
 * 各家不用知道自己叫什么、也冒充不了别家(ADR-0031 决策 2)。核心自己的场景也一样,前缀是 `core`。
 */
export interface DevtoolsProvider {
	scenarios: DevScenarioDef[];
}
