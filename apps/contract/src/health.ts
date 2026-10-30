import type {
	ExtensionProvides,
	ExtensionRunState,
	Failure,
	Identity,
	Result,
	SourceDescriptor,
} from "@bilibili-notify/internal";

/**
 * `GET /api/health` —— 存活探测。面板每 5 秒问一次判断后端通不通,应用内更新与重启靠它
 * 认新进程,桌面外壳与 CI 冒烟只看它回不回 200 / `status`。
 *
 * ADR-0025 决策 12:短版只留这四格;各模块开没开与核心包版本住 `/api/health/details`
 * ({@link HealthDetailsResponse})。
 */
export interface HealthResponse {
	status: "ok";
	/** 这份载荷的版本(`apps/server/package.json#version`,发版时按 tag 同步)。 */
	version: string;
	/** 进程跑了多少秒。 */
	uptime: number;
	/** 这个进程的启动时刻(ISO)。换了进程才会变 —— 面板靠它认「真的重启完了」。 */
	startedAt: string;
}

/** 宿主确认的运行状态;没有可靠结论时明确未知。 */
export type SourceRunStatus = ExtensionRunState | "unknown";

/**
 * `GET /api/health/details` —— 健康卡要的数据(ADR-0025 决策 12)。短版那四格不在这里重复带:
 * 版本、启动时刻只认短版。
 */
export type HealthDetailsResponse = StartupHealthDetailsResponse | RunningHealthDetailsResponse;

/** 数据还没就位时只交开机进度,不伪造运行中的模块与配置分区。 */
export interface StartupHealthDetailsResponse {
	phase: "migrating" | "starting";
	/** 首次迁移回调之前与 starting 阶段为 null。 */
	progress: {
		/** 当前步骤位置,从 1 开始;跳过的布局项也占位置,不是文件完成比例。 */
		step: number;
		total: number;
		label: string;
	} | null;
}

/** 完整 app 接管后的健康详情。 */
export interface RunningHealthDetailsResponse {
	/** 核心问题只能可靠归到组头,不分摊给五格。 */
	core: { items: CoreHealthView[]; problemCount: number };
	integrations: IntegrationHealthView[];
	identityDuplicates: IdentityDuplicateView[];
	/** 包括已无对应集成格的问题;同一次问题表读取的总数。 */
	problemCount: number;
	phase: "running";
	/** 各核心包自己的 `package.json#version`,启动期一次读出。 */
	moduleVersions: Record<"storage" | "subscription" | "push" | "image" | "ai", string>;
	modules: ModuleState;
	/** 配置仓三个分区的文件在不在、最后一次写的时刻;订阅与推送目标另带条数。 */
	configScopes: {
		globals: ConfigScopeMeta;
		subscriptions: ConfigScopeMeta & { count: number };
		targets: ConfigScopeMeta & { count: number };
	};
}

/** 各引擎模块开没开。 */
export interface ModuleState {
	/** 动态轮询接上了。运行时起来之后恒为 true。 */
	dynamic: boolean;
	/** 至少有一条订阅会开直播监听。 */
	live: boolean;
	/** 卡片渲染接上了(有浏览器)且 `cardStyle.enabled`。 */
	image: boolean;
	/** 评论生成接上了(apiKey 与 baseUrl 都有)且 `ai.enabled`。 */
	ai: boolean;
}

/** 配置仓一个分区的文件:在不在盘上、最后一次写的时刻(没写过是 null)。 */
export interface ConfigScopeMeta {
	exists: boolean;
	lastUpdatedAt: string | null;
}

export type HealthLightStatus = "green" | "orange" | "red" | "gray";

export interface CoreHealthView {
	key: "storage" | "subscription" | "push" | "image" | "ai";
	status: "running" | "not-ready" | "unknown";
	light: HealthLightStatus;
	version: string;
	count?: number;
}

export interface IntegrationHealthView {
	key: string;
	kind: "builtin-source" | "builtin-adapter" | "extension";
	descriptor: Pick<SourceDescriptor, "label" | "shortLabel" | "color" | "icon">;
	/** 清单读不出时缺省,表示未知,不是没有口子。 */
	provides?: ExtensionProvides[];
	status: SourceRunStatus;
	light: HealthLightStatus;
	problemCount: number;
	connectionCount: number;
	sourceKey?: string;
	adapterKey?: string;
	/** 摘要读取结果独立于启动状态;没有摘要能力时缺省。 */
	health?: Result<{ summary: string }>;
	failure?: Failure;
}

export interface IdentityDuplicateView {
	identity: Identity;
	subscriptionIds: string[];
	name?: string;
}
