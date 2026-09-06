/**
 * 开发者工具(devtools)的 wire 契约 —— `GET /api/dev` 列场景、`POST /api/dev/run/:id` 跑一个、
 * `POST /api/dev/reset(/:id)` 收摊。
 *
 * **只在开发版载荷上存在**(`0.0.0-dev` / `dev`,见 server 的 `isDevBuild`;alpha 也不给)。
 * 门是版本号而不是环境变量:环境变量能在生产镜像里被设上,版本号不能。面板那半由
 * `import.meta.env.DEV` 挡着,生产 bundle 里连组件都没有。
 *
 * 场景分**两半合一份**:服务端这半由这条契约列出来、在服务端执行;面板那半同形状、
 * `run` 在浏览器里跑(涌 toast、装不可达壳),面板把两半并成一张表。声明是纯数据 ——
 * 参数由 schema 驱动,面板照 `params` 画控件,不必认识每个场景。
 */

/**
 * 面板左栏的五组。`web` 是浏览器里跑的那半,其余四组都在服务端。
 */
export type DevScenarioGroup = "event" | "state" | "timer" | "capture" | "web";

/**
 * 一个参数字段。六种,面板照 `kind` 画控件:
 *
 * - `sub` / `target` / `adapter` —— 从站内既有列表里挑一个(订阅 / 推送目标 / 适配器),
 *   值是它们的 id。**省略时的默认值住服务端**(`sub` = 第一个启用的订阅),面板不猜。
 * - `number` / `enum` / `text` —— 自带默认值。
 */
export type DevParamField =
	| { key: string; label: string; kind: "sub" }
	| { key: string; label: string; kind: "target" }
	| { key: string; label: string; kind: "adapter" }
	| { key: string; label: string; kind: "number"; default: number; min?: number; max?: number }
	| {
			key: string;
			label: string;
			kind: "enum";
			options: ReadonlyArray<{ value: string; label: string }>;
			default: string;
	  }
	| { key: string; label: string; kind: "text"; default?: string; placeholder?: string };

export interface DevScenario {
	/** 全局唯一,两半共用一个命名空间(`update.state` / `web.toast-flood`)。 */
	id: string;
	group: DevScenarioGroup;
	title: string;
	/** 一句说明:它会造成什么、以及要注意什么(「按重启会真的退出」)。 */
	desc?: string;
	params: DevParamField[];
	/** 在左下角药丸上占一个快捷位 —— 只给最常按的那几个。 */
	quick?: boolean;
}

/** 面板交上来的参数:key → 值。缺的字段服务端按默认值补。 */
export type DevParamValues = Record<string, string | number>;

export interface DevRunRequest {
	params?: DevParamValues;
}

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

export interface DevStatusDTO {
	scenarios: DevScenario[];
	active: DevInjection[];
}

export interface DevRunResponse {
	/** 跑完的一句回执(「已发一条开播事件」);状态类场景可省略。 */
	summary?: string;
	/** 跑完之后的生效表 —— 面板拿它刷「当前生效」条,不必再 GET 一次。 */
	active: DevInjection[];
}

export interface DevResetResponse {
	active: DevInjection[];
}
