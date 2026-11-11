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

import type {
	DevInjection,
	DevParamValues,
	DevScenarioDescriptor,
} from "@bilibili-notify/internal";

export type {
	DevInjection,
	DevParamField,
	DevParamValues,
	DevScenarioDescriptor,
	DevScenarioGroup,
} from "@bilibili-notify/internal";

export interface DevRunRequest {
	params?: DevParamValues;
}

/** 源码开发版拓展页的手动挂载；普通构建不提供对应路由。 */
export interface DevelopmentExtensionMountView {
	id: string;
	directory: string;
	entry: string;
	watching: boolean;
	reloads: number;
	error?: string;
}

export interface DevelopmentExtensionsResponse {
	mounts: DevelopmentExtensionMountView[];
}

/** 只读浏览BN宿主目录，不读取源码或执行挂载。 */
export interface DevelopmentDirectoriesResponse {
	directory: string;
	parent: string | null;
	hasManifest: boolean;
	entries: { name: string; path: string }[];
}

export interface DevStatusView {
	scenarios: DevScenarioDescriptor[];
	active: DevInjection[];
}

/**
 * `GET /api/dev/active`:只有生效表。面板有注入生效时每几秒看一眼的是**这个**,不是
 * `GET /api/dev` —— 那份带着整张场景表(十几 KB 的静态声明),按秒重发只是在搬同样的字节。
 */
export interface DevActiveView {
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
	connectionId: string;
	connectionName: string;
	platform: string;
	targetId: string;
	targetName: string;
	/** 目标是不是私聊会话(`target.scope === "private"`)。 */
	private: boolean;
	/** 载荷种类(`NotificationPayload["kind"]`)。 */
	kind: string;
	/** 文本摘要:纯文本 / 图说明 / 复合段拼接 / 小程序卡标题;超长截断。图集没有。 */
	text?: string;
	/** 带了几张图(内嵌 buffer 与图集 url 都算)。 */
	images: number;
}

export interface DevCapturesView {
	enabled: boolean;
	entries: DevCapturedDelivery[];
}

/** `DELETE /api/dev/captures/history`:清掉截流期间写进历史的行,回删了几行。 */
export interface DevPurgeHistoryResponse {
	deleted: number;
}
