import type {
	FeatureKey,
	PushTarget,
	PushTargetPlatform,
	Subscription,
	SubscriptionRouting,
} from "../../types/domain";
import { DEFAULT_FEATURE_FLAGS, FEATURE_KEYS } from "../../types/domain";

/**
 * UP 主配色住在 `@bilibili-notify/internal`,不在这里 —— 服务端渲染周报图片时
 * 要用同一套色,同一位 UP 在页面上和推到群里的图片上必须是同一个颜色。这里
 * re-export 只是让页面侧的既有引用点不用改。调色板的取舍见那边的说明。
 *
 * **必须走 `/constants` 子路径**,不能从根入口拿:根入口带 zod,而这是页面里唯一
 * 一处从 internal 做**运行时**导入的地方 —— 曾经写成根入口,于是整个 zod(300+ 处
 * 引用)被拖进浏览器 bundle,只为一个调色板。其余对 internal 的引用一律 `import type`
 * (编译后擦除),见 `types/domain.ts` 开头那段。
 */
export { colorFromUid, UP_COLORS } from "@bilibili-notify/internal/constants";

export function displayName(sub: Subscription): string {
	return sub.cachedProfile?.name?.trim() || `UID ${sub.uid}`;
}

/**
 * 该平台是否支持「@全体成员」。QQ 官方机器人在群聊 @全体需特殊权限,后端适配器对
 * at-all 段是 best-effort 跳过(apps/server/src/platforms/qq-official.ts 的
 * `qqPayloadToParts`),故前端在其 @全体 开关上提示并禁用;onebot / webhook 正常支持。
 */
export function platformSupportsAtAll(platform: PushTargetPlatform): boolean {
	return platform !== "qq-official";
}

/**
 * 该订阅「实际开启」的推送特性 = `overrides.features` 覆写值,缺省继承
 * DEFAULT_FEATURE_FLAGS。等同 UpDialog「订阅项 · 默认推送内容」里的主开关。
 * routing(per-target 路由)是正交的另一根轴,不参与此判断 —— follow 模式加
 * 推送目标会灌满全部 routing,据 routing 判定会让卡片恒显全部特性。
 */
export function subscribedFeatures(sub: Subscription): FeatureKey[] {
	return FEATURE_KEYS.filter((k) => sub.overrides.features?.[k] ?? DEFAULT_FEATURE_FLAGS[k]);
}

export function targetsById(targets: PushTarget[]): Map<string, PushTarget> {
	const m = new Map<string, PushTarget>();
	for (const t of targets) m.set(t.id, t);
	return m;
}

export function relativeTime(iso: string | undefined): string {
	if (!iso) return "—";
	const ts = new Date(iso).getTime();
	if (Number.isNaN(ts)) return "—";
	const delta = Date.now() - ts;
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * 切到「自定义」推送模式时,target 的 routing 初始化为 = 订阅项生效特性集:
 * subscribedFeatures 命中的 feature 收该 target,未命中的把它剔除;其余 target
 * 原样保留。让「自定义」从「跟随订阅项现状」起步,而非默认全部特性全开。
 */
export function routingAlignedToFeatures(sub: Subscription, targetId: string): SubscriptionRouting {
	const want = new Set<FeatureKey>(subscribedFeatures(sub));
	const out = {} as SubscriptionRouting;
	for (const k of FEATURE_KEYS) {
		const cur = sub.routing[k];
		const has = cur.includes(targetId);
		if (want.has(k)) {
			out[k] = has ? cur : [...cur, targetId];
		} else {
			out[k] = has ? cur.filter((id) => id !== targetId) : cur;
		}
	}
	return out;
}
