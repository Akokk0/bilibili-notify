import type { CardSkinKnobOverrides } from "@bilibili-notify/internal";

export type Dynamic = {
	/**
	 * `is_only_fans` = 该动态是充电专属内容。未充电用户拉取时接口会把整个
	 * `module_dynamic` 清空(desc/major/topic/additional 全 null)—— `buildDynamicNode`
	 * 据此渲染占位提示,而非空白正文(见 dynamic-content.tsx)。
	 */
	basic: { is_only_fans?: boolean } & Record<string, unknown>;
	id_str: string;
	modules: {
		module_author: {
			avatar: object;
			decorate?: {
				card_url: string;
				fan: { num_str: number; color: string };
			};
			face: string;
			face_nft: boolean;
			following: boolean;
			/** 充电专属徽标(仅该 UP 开通充电计划的动态可能带);缺省时占位提示用固定文案兜底。 */
			icon_badge?: { text: string; icon?: string };
			jump_url: string;
			label: string;
			mid: number;
			name: string;
			pub_action: string;
			pub_action_text: string;
			pub_location_text: string;
			pub_time: string;
			pub_ts: number;
			type: string;
			vip: { type: number };
		};
		module_dynamic: {
			// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回多样化的 additional 类型
			additional?: any;
			desc?: {
				rich_text_nodes: RichTextNode;
				text: string;
			};
			major?: {
				opus?: {
					fold_action: string[];
					jump_url: string;
					pics?: Array<{
						height: number;
						url: string;
						width: number;
						size: number;
						live_url: string;
					}>;
					summary?: { rich_text_nodes: RichTextNode; text: string };
					title?: string;
				};
				archive?: {
					badge: { text: string };
					cover: string;
					duration_text: string;
					title: string;
					desc: string;
					/** 接口给的是格式化后的字符串("6.5万");模板原样渲染,不做算术。 */
					stat: { play: number | string; danmaku: number | string };
					bvid: string;
					jump_url: string;
				};
				// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回多样化的 draw 类型
				draw?: any;
				type: string;
			};
			// biome-ignore lint/suspicious/noExplicitAny: Bilibili API 返回多样化的 topic 类型
			topic?: any;
		};
		module_stat: {
			comment: { count: number };
			forward: { count: number };
			like: { count: number };
		};
	};
	orig?: Dynamic;
	type: string;
	visible: boolean;
};

export type RichTextNode = Array<{
	emoji?: { icon_url: string; size: number; text: string; type: number };
	orig_text: string;
	text: string;
	type: string;
}>;

export type LiveData = {
	watchedNum?: string | number;
	likedNum?: string | number;
	fansNum?: string | number;
	fansChanged?: string | number;
};

export type CardColorOptions = {
	// 🪦 `backgroundImage` 2026-09-20 删掉:背景图 2026-09-14 退役成皮肤自己的 `image`
	// 旋钮(`--bn-knob-wallpaper`),这一项从 2026-09-19 起已经喂不到任何 CSS。
	/**
	 * 字体家族名;缺省时回退渲染器全局 config。
	 *
	 * 这一项此前**整个漏在外面**:设置页允许给单个 UP / 单类卡另设字体,schema 存得下、
	 * resolve 也算得出,唯独没人把它交给渲染器 —— 于是选了等于没选。
	 */
	font?: string;
	/** 自带字体文件的资产 id;设了就优先于 `font`,缺省时回退渲染器全局 config。 */
	fontAsset?: string;
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
