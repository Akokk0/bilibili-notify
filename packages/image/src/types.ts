import type { CardSkinKnobOverrides } from "@bilibili-notify/internal";

export type CardColorOptions = {
	// 🪦 `backgroundImage` 2026-09-20 删掉:背景图 2026-09-14 退役成皮肤自己的 `image`
	// 旋钮(`--bn-knob-wallpaper`),这一项从 2026-09-19 起已经喂不到任何 CSS。
	/** 直播卡自定义封面资产 id(或已解析 URL);缺省时用 B 站房间封面/关键帧。仅 live 卡消费。 */
	liveCoverImage?: string;
	/**
	 * 用哪套**卡片皮肤**(ADR-0014):皮肤 id,缺省 / 空串 = 内置默认皮肤。
	 *
	 * 取代了从前逐张卡传进来的 `layout` 切片 —— 版式现在住在皮肤包里,调用方只报一个
	 * 引用。宿主解析不出这个 id(皮肤被删了)时渲染器回落默认皮肤并报告警,不拒发。
	 */
	cardSkin?: string;
	/**
	 * 这位 UP 自己那层**皮肤旋钮覆盖**,按皮肤 id 分(订阅的 `overrides.cardSkinKnobs`,
	 * ADR-0014 决策 17 的 🔗,2026-09-24)。缺省 = 这位 UP 一枚都没单独拧过。
	 *
	 * 渲染时与全局那份(渲染器 config 的 `cardSkinKnobs`)**逐枚**合并,且只认这张卡实际
	 * 画的那套皮肤那一格。传的是原样的 per-UP 层、不是合好的值:全局那份随配置热更,
	 * 宿主的订阅快照里要是折进了全局值,全局再改就改不动这位 UP 了。
	 */
	cardSkinKnobs?: Readonly<Record<string, CardSkinKnobOverrides>>;
};

/** 只管「用哪套皮肤、这位 UP 怎么拧它」的那两格 —— 词云这类不收别的样式的卡用它。 */
export type CardSkinChoice = Pick<CardColorOptions, "cardSkin" | "cardSkinKnobs">;
