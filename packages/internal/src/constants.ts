/**
 * 纯常量模块 —— 必须保持**零 import、零副作用**:它经 `@bilibili-notify/internal/constants`
 * 子路径直供浏览器端(apps/web / astrbot/page)运行时消费,不能把 zod 或任何 schema
 * 模块拽进前端 bundle。schema/common.ts 反向引用这里(`z.enum(FEATURE_KEYS)`)并从根
 * 入口重导出,后端消费者(koishi / sidecar / server)照旧从根入口拿 —— 两条路径同一份值。
 */

/** 全部可订阅的特性键。新增或删除会扩散到 FeatureFlags、SubscriptionRouting、Subscription.overrides。 */
export const FEATURE_KEYS = [
	"dynamic",
	"live",
	"liveEnd",
	"liveGuardBuy",
	"superchat",
	"wordcloud",
	"liveSummary",
	"specialDanmaku",
	"specialUserEnter",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** 默认全局值；resolve() 在 per-UP overrides 缺失字段时回退到这里。 */
export const DEFAULT_FEATURE_FLAGS: Record<FeatureKey, boolean> = {
	dynamic: true,
	live: true,
	liveEnd: true,
	liveGuardBuy: false,
	superchat: false,
	wordcloud: true,
	liveSummary: true,
	specialDanmaku: false,
	specialUserEnter: false,
};
