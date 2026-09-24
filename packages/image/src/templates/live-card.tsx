/**
 * 这种卡的 **props 契约**。整卡模板(把块按旧版式装进外框那一层)已退役 —— 出图与测试
 * 一律走皮肤渲染器,整卡模板一处都不剩了(ADR-0014 决策 24 的 2026-09-18 🔗)。块渲染器
 * 与外框吃的仍是这份 props,所以类型留在原地。
 *
 * 直播卡有三份形状(ADR-0019 决策 68):
 * - {@link LiveCardInput}:**中立的输入**,出卡入口 `generateNeutralLiveCard` 吃它。纯数据、
 *   不带任何平台的原始结构,状态明写。B 站那头(`generateLiveCard`)是把接口数据翻成它的适配层。
 * - {@link LiveCardView}:块与皮肤契约吃的那一份 —— 全是排好的文字(数字排成「1.2万」、
 *   开播时刻算成「直播时长：…」那句)。从输入到它只有一步(`buildLiveCardView`),预览的
 *   示例数据直接写它(不读时钟)。
 * - {@link LiveCardProps}:🪦 旧的那份,见它自己的注释。
 */

/**
 * 直播卡此刻是哪一种,**明写**(从前是一个数字:一处压成角标用的 0 / 1 / 2、别处却判 3 ——
 * 下播那一支因此从来没画出来过,决策 76)。
 *
 * - `start` 开播、`streaming` 直播中:角标都是「直播中」,数据区「人气 + 当前粉丝数」;
 *   两者只差卡上那句时间(开播时间 / 直播时长)。
 * - `end` 下播:角标「已下播」,数据区「点赞 + 累计观看人数」(决策 76)。
 * - `offline` 没在播:私聊指令查询一个没开播的房间时那一种 —— 角标「未开播」。
 */
export type LiveCardStatus = "start" | "streaming" | "end" | "offline";

/**
 * **中立的直播卡输入**(ADR-0019 决策 68)。纯数据,不带任何平台的原始结构。
 *
 * 人数一类的格子交数字(BN 排成「1.2万」),也可以交平台已经排好的文字(B 站的累计观看
 * 就是接口给的成品字符串)—— 文字原样上卡。没有的格子不给,卡上对应那一行就不画。
 */
export type LiveCardInput = {
	status: LiveCardStatus;
	/** 卡上的主播。 */
	author: { name: string; face: string };
	title?: string;
	/** 分区。 */
	area?: string;
	/** 房间简介,**纯文本**(B 站那头先剥掉了富文本标签)。 */
	description?: string;
	/**
	 * **生效的**封面(远端网址或 data URL)—— 用哪一张由来源自己定(B 站:直播中用关键帧、
	 * 其余用房间封面)。主人给这条订阅设的自定义直播封面在出卡时另行覆盖在它上面。
	 */
	cover?: string;
	/**
	 * 开播时刻,**毫秒**时间戳。卡上那句「开播时间：…」(开播 / 下播)或「直播时长：…」
	 * (直播中)由它算,按北京时间写。不给就不写那句。
	 */
	startedAt?: number;
	/** 此刻在线(人气那一格,开播 / 直播中 / 没在播的卡上画)。 */
	online?: number | string;
	/** 点赞(下播卡的那一格)。 */
	likes?: number | string;
	/** 本场累计观看(下播卡的那一格)。 */
	totalViewers?: number | string;
	/** 当前粉丝数(开播 / 直播中的卡上画)。 */
	fans?: number | string;
	/**
	 * 本场粉丝数变化。**默认卡不画**(决策 76,它进下播文案),皮肤契约照给
	 * (`stats.fansChanged`),自己做皮肤的人想画就能画。数字排成带正负号的写法。
	 */
	fansChanged?: number | string;
};

/**
 * 块与皮肤契约吃的那一份:**全是排好的文字**,缺的格子是空串。由 `buildLiveCardView` 从
 * {@link LiveCardInput} 算出来(那一步读时钟算「直播时长」,所以这里不再有时间戳)。
 */
export type LiveCardView = {
	status: LiveCardStatus;
	username: string;
	userface: string;
	title: string;
	area: string;
	/** 纯文本。 */
	description: string;
	/** 生效的封面(自定义直播封面已经覆盖上去了)。空串 = 没有。 */
	cover: string;
	/** 「开播时间：…」/「直播时长：…」/「未开播」那一句。 */
	time: string;
	online: string;
	likes: string;
	totalViewers: string;
	fans: string;
	fansChanged: string;
};

/**
 * 🪦 **旧的直播卡 props**:B 站直播接口原样的 `data` + 已排好的数字 + 一个压成角标用的状态码
 * (`liveStatus`:1 直播中 / 2 已下播 / 其余未开播)。块与契约早已改吃 {@link LiveCardView};
 * 皮肤渲染器在入口处把它翻成那一份(`liveCardViewOf`)。
 *
 * 留着只因 `apps/server/src/routes/cards.ts` 的示例预览还在拼这个形状、那几行这一波不许动;
 * 那边改成拼 {@link LiveCardView}(或 {@link LiveCardInput})后,连同翻译那一步一起删。
 */
export type LiveCardProps = {
	// biome-ignore lint/suspicious/noExplicitAny: Bilibili 直播 API 返回类型
	data: any;
	username: string;
	userface: string;
	titleStatus: string;
	liveTime: string;
	liveStatus: number;
	cover: boolean;
	/** 自定义封面(已解析 URL);有值时优先于 user_cover / keyframe。 */
	coverOverride?: string;
	onlineNum: string;
	likedNum: string;
	watchedNum: string;
	fansNum: string;
	fansChanged: string;
};
