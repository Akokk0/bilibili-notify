/**
 * 这种卡的**输入契约**(命名与别的卡一致,见 naming.md 的 `…Input`)。整卡模板(把块按旧版式装进外框那一层)已退役 ——
 * 出图与测试一律走皮肤渲染器,整卡模板一处都不剩了(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是这份输入,所以类型留在原地。
 */
export type WordCloudCardInput = {
	creatorName: string;
	creatorAvatarUrl?: string;
};
