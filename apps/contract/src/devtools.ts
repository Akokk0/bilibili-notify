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
	/**
	 * 图标名(`@bilibili-notify/ui` 的 `IconName`),快捷位与卡片上用;不给就按分组取。
	 * 同一组里有两个快捷位时必须给 —— 开播 / 下播都画成铃铛就分不清了。
	 */
	icon?: string;
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

/**
 * `GET /api/dev/active`:只有生效表。面板有注入生效时每几秒看一眼的是**这个**,不是
 * `GET /api/dev` —— 那份带着整张场景表(十几 KB 的静态声明),按秒重发只是在搬同样的字节。
 */
export interface DevActiveDTO {
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

// ---- 截流(D1) ----------------------------------------------------------------

/**
 * 截流期间被拦下的一条推送。只留摘要:载荷本体里有图片 buffer,整个交给面板既没必要也
 * 太重;历史那边照记 `delivered`(不为调试改 history schema),这份列表才是对照。
 */
export interface DevCapturedDelivery {
	/** 进程内递增的序号,面板当 key。 */
	id: string;
	/** 拦下的时刻(ms)。 */
	at: number;
	adapterId: string;
	adapterName: string;
	platform: string;
	targetId: string;
	targetName: string;
	/** 强制私聊那条路(`sendPrivate`)。 */
	private: boolean;
	/** 载荷种类(`NotificationPayload["kind"]`)。 */
	kind: string;
	/** 文本摘要:纯文本 / 图说明 / 复合段拼接 / 小程序卡标题;超长截断。图集没有。 */
	text?: string;
	/** 带了几张图(内嵌 buffer 与图集 url 都算)。 */
	images: number;
}

export interface DevCapturesDTO {
	enabled: boolean;
	entries: DevCapturedDelivery[];
}

/** `POST /api/dev/captures/purge-history`:清掉截流期间写进历史的行,回删了几行。 */
export interface DevPurgeHistoryResponse {
	deleted: number;
}
