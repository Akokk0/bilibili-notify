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

/**
 * `GET /api/health/details` —— 健康卡要的数据(ADR-0025 决策 12)。短版那四格不在这里重复带:
 * 版本、启动时刻只认短版。
 */
export interface HealthDetailsResponse {
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
