/**
 * 批准的像素差清单(ADR-0028 决策 2,守卫 10)。形状与判官在 `card-diff-check.ts`。
 *
 * - `baseline`:清单开张(1.0 第 2 期 ⑩,2026-10-02)时 23 个样例的出图 hash。新加的夹具在这里补一行。
 * - `approvals`:之后每一次出图变化,**只往末尾追加**,一条写清样例、变化、类别、依据和新 hash。
 *   同一样例认最后一条;旧条目不改不删,它们就是出图变迁的账。
 */

import type { CardDiffList } from "./card-diff-check";

/**
 * ㉑c 第 1 步(2026-10-05):B 站作品卡不再画头像。九个走 B 站原始数据的 `dynamic-*` 样例同一次批准,
 * 清单按样例认账,所以下面九行共用这一段说明、各带各的 hash。
 *
 * 类别写 `master-approved`:三类预批(叫法中立化 / 内联 SVG 残差 / B 站纯装饰)都不贴切 —— 头像不是装饰,
 * 是 `Creator` 里实打实的一格,只是它在中立形状里只收图库引用、B 站的头像是远端地址,3a 才交引用
 * (ADR-0021 决策 22 下 2026-10-05 的 🔗,主人当天拍板「B 站作品卡到 3a 之前不画头像」)。
 *
 * 字节上只少了三样,别的一个字没动:头像格(外层与转发框里的内层各一份)、`.bn-blk-avatar` 那段块 CSS、
 * 以及只有头像那张 `<img>` 在用的 UnoCSS 工具类(`.shrink-0`;充电专属与「暂时无法渲染」两张卡连
 * `.object-cover` 也跟着没了)。名字 / 时间格的行列没变 —— 头像本来占的第 1 列就此空着(皮肤版式的事,
 * 留给 ㉔)。`dynamic-custom-layout` 的自定义版式里没摆头像块,字节不变,不在此列。拓展作品那条路自己造 node、
 * 照旧带头像,不受影响。
 */
const B_SITE_AVATAR_DROPPED = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	change:
		"B 站作品卡不再画头像:头像格整块收起(转发框里的内层同样),块 CSS 与只有头像在用的工具类随之消失",
	basis:
		"ADR-0021 决策 22 的 2026-10-05 🔗(㉑ 开片拷问):Creator.avatar 只收图库引用,B 站 3a 才交引用,到那时不画头像",
} as const;

/**
 * ㉑c 第 2 步(2026-10-05):B 站作品卡不画 `Post` 装不下的小图标与表情图。分两组,每组各带自己的依据,
 * 每个样例的 `change` 自己写(五个样例变的东西各不相同)。
 *
 * **第一组 · `master-approved`**:到 3a 才会以图库图回来的 —— 正文里 BV / AV 号与抽奖链接前的小图标
 * (`RichText` 的 `link.icon`)、预约卡抽奖行前的图标(`Attachment.card` 的 `lines[].icon`)、表情图(`emoji.image`)。
 * 它们在中立形状里只收图库引用,B 站的要到 3a 才存进图库。三类预批都不贴切:`library-image-residue` 说的是
 * 「内联 SVG 换成图库图之后的残差」,而这里还没换、只是先不画 —— 换回来那一步才会有残差。表情不是装饰,是正文的
 * 一部分,先按定案「没图时当文字显示」画它的 `text`。
 *
 * **第二组 · `bili-decoration-removed`**:形状里压根没有位置、也不会回来的 —— 预约按钮上的铃铛
 * (`button` 只有 `text` / `enabled`)、商品卡标题前的购物袋(`goods.eyebrow` 是纯文字)。两个都是 B 站纯装饰。
 * 预约按钮那个铃铛是条件渲染(`!isEnded && …`),不画之后已结束的预约卡少一个 Vue 的 `<!---->` 占位注释。
 *
 * 两组的字节变化都只有「图标 / 表情那几样」本身,外加只有它们在用的 UnoCSS 工具类(表情 `<img>` 带的
 * `.inline` / `.w-[17px]` / `.h-[17px]` / `.align-middle`)。外面那层 `flex items-center gap-1` 的壳先留着,
 * 不动 —— 去图标之外的字节不碰,版式上的收拾留给 ㉔。依据同第 1 步:ADR-0021 决策 22 的 2026-10-05 🔗
 * 「B 站卡的字节,形状逼着变的就变」。
 */
const B_SITE_ICONS_PENDING_LIBRARY = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	basis:
		"ADR-0021 决策 22 的 2026-10-05 🔗(㉑ 开片拷问):link.icon / lines[].icon / emoji.image 只收图库引用,B 站 3a 才交引用,到那时不画图标、表情当文字",
} as const;

const B_SITE_DECORATION_NO_SLOT = {
	category: "bili-decoration-removed",
	basis:
		"data-model「出图字节门」第三条(B 站纯装饰去掉)+ ADR-0021 决策 22 的 2026-10-05 🔗:Attachment 的 button / goods.eyebrow 里没有这个图标的位置",
} as const;

/**
 * ㉑c 第 4 步(2026-10-05):附加块先画成 `Attachment` 的形状装得下的样子,好让「换入口」那步十份快照一字不差。
 * 主人定的原则:**不加字段,形状装不下的就不画**(ADR-0021 决策 22 的 2026-10-05 🔗「形状逼着变的就变」)。分三组。
 *
 * **第一组 · `master-approved`**:预约卡 / 商品卡 / 引用视频卡里形状装不下的版式 ——
 * - 预约卡(→ `card`):`lines` 每行只有 `{ text, icon? }`。desc1 / desc2 / desc3 各占一行、同一个样式
 *   (不再同行并排、抽奖行不再标粉),行与行之间留 2px、最后一行不留(与通用卡共用一个画法,所以行带 `truncate`);
 *   按钮只剩文字与可用 / 不可用两态,去图标后留下的 `inline-flex` 空壳与 `<span>` 一并收掉。
 * - 商品卡(→ `goods`):按钮「去看看」与价格后的「起」不画,价格那行不再套只装一个 span 的 flex。
 * - 引用视频卡(→ `video`):标题上方 `head_text` 那一行不画,只装一张卡的外层 `<div>` 收掉。
 * 三类预批都不贴切 —— 这些是形状装不下的**内容与版式**,不是纯装饰、不是叫法、也不是图库图的残差。
 * 文字行成为一个 Vue 数组片段,所以行的两头多一对 `<!--[-->` `<!--]-->` 锚点(原来的 `<!---->` 占位随之没了)。
 *
 * **第二组 · `bili-decoration-removed`**:通用卡 desc1 前的「游戏」边框小标签 —— B 站的纯装饰,`lines` 里没有位置。
 *
 * **第三组 · `bili-decoration-removed`(连带效应,卡本身没变)**:UnoCSS 的生成器在进程里只建一个
 * (`render.ts`),它的「属性层」会把**前面渲染过的卡**用到的 `--un-*` 变量一路带进后面的卡。「游戏」标签是整个
 * 动态卡里唯一用边框颜色的地方,它不画之后 `--un-border-opacity` 不再生成,于是排在它**后面**渲染的 12 份
 * 快照(动态卡自己 3 份、上舰 / 锐评 / 醒目留言 / 词云)的属性层各少了这一个变量(正好 25 字节),别的一个
 * 字没动。出图不受影响 —— 这个变量没有任何元素在用。
 *
 * 四条共同的纪律:去掉东西之外的字节不碰;各卡之间不同的版式(预约卡没有封面与头部说明、通用卡有)
 * 不是形状逼的,先不统一,留给 ㉔。
 */
const B_SITE_ATTACHMENT_SHAPE = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	basis:
		"ADR-0021 决策 22 的 2026-10-05 🔗(形状逼着变的就变)+ data-model「作品」:card.lines 每行只有 { text, icon? }、button 只有 text / enabled、goods 与 video 没有按钮 / 后缀 / eyebrow",
} as const;

const B_SITE_GAME_TAG_DROPPED = {
	category: "bili-decoration-removed",
	basis:
		"data-model「出图字节门」第三条(B 站纯装饰去掉)+ ADR-0021 决策 22 的 2026-10-05 🔗:card.lines 里没有标签的位置",
} as const;

const UNO_PROPERTIES_LEAK = {
	category: "bili-decoration-removed",
	change:
		"卡本身没变:UnoCSS 属性层少了 --un-border-opacity(25 字节)—— 它原本是前面渲染的通用卡「游戏」标签的边框色漏进来的",
	basis:
		"通用卡「游戏」标签不画(见 dynamic-word 的记录)的连带效应:render.ts 的 UnoCSS 生成器进程内共用,属性层跨卡累积",
} as const;

/**
 * ㉒b(2026-10-05):B 站直播卡不再画主播头像。四份直播样例里三份同一次批准(`live-streaming` / `live-ended` /
 * `live-with-fontface`),清单按样例认账,所以下面三行共用这一段说明、各带各的 hash。
 *
 * 类别写 `master-approved`,理由同 `B_SITE_AVATAR_DROPPED`:头像不是装饰,是中立形状里实打实的一格,只是它只收图库
 * 引用、B 站的头像是远端地址,3a 才交引用(ADR-0021 决策 24 下 2026-10-05 的 🔗,照决策 22 下作品卡的先例,
 * 主人当天拍板「B 站直播卡 3a 前不画头像」)。
 *
 * 四份直播夹具是 B 站形状、直接写排好的 `LiveCardView`(不经 `biliLiveCardInput`),所以夹具的 `userface` 改成空串,
 * 代表 B 站这条路今天的产物。字节上只少了三样,别的一个字没动:头像格(`data-cell="avatar"` 整格,里面的 `<img>` 一并)、
 * `.bn-blk-avatar` 那段块 CSS、以及只有头像那张 `<img>` 在用的 UnoCSS 工具类 `.shrink-0`(`.object-cover` 封面也用,留着)。
 * 名字 / 时间格的行列没变 —— 头像本来占的第 1 列就此空着(皮肤版式的事,留给 ㉔)。`live-minimal` 的自定义版式里
 * 没摆头像块,字节不变,不在此列。拓展直播那条路自己带着头像,不受影响。直播卡在基准里排最前,别的卡的字节没有被牵连。
 */
const B_SITE_LIVE_AVATAR_DROPPED = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	change:
		"B 站直播卡不再画主播头像:头像格整块收起,块 CSS 与只有头像在用的 .shrink-0 工具类随之消失",
	basis:
		"ADR-0021 决策 24 的 2026-10-05 🔗(㉒ 开片拷问):B 站直播卡 3a 前不画头像,Creator 只收图库引用、不加过渡格",
} as const;

/**
 * ㉓c 第 1 步(2026-10-05):B 站醒目留言卡与会员卡不再画观众与主播头像。五份样例同一次批准(`sc-low` / `sc-high` /
 * `guard-captain` / `guard-governor` / `guard-badge-left`),清单按样例认账,所以下面五行共用这一段说明、各带各的 hash。
 *
 * 类别写 `master-approved`,理由同 `B_SITE_AVATAR_DROPPED`:头像不是装饰,是中立形状里实打实的一格,只是它只收图库
 * 引用、B 站的头像是远端地址,3a 才交引用(ADR-0021 决策 26 下 2026-10-05 的 🔗,照决策 22、24 下作品卡与直播卡的先例,
 * 主人当天拍板「B 站这两种卡 3a 前不画头像」)。
 *
 * 夹具是 B 站形状、直接写块吃的视图,所以观众与主播的头像地址改成「没有」,代表 B 站这条路今天的产物。字节上只少了
 * 几样,别的一个字没动:观众头像格(`data-cell="avatar"` 整格,里面的 `<img>` 一并)、`.bn-blk-avatar` 那两段块 CSS、
 * 只有头像在用的 UnoCSS 工具类(醒目留言 `.h-full` `.overflow-hidden` `.object-cover`;会员 `.h-full` `.w-full` `.object-cover`),
 * 以及主播那一格小头像(会员卡主播胶囊里的 `masterAvatar`;醒目留言卡「SC to」里的那个,只有 `sc-low` 带过 —— 它另少
 * `.bg-cover` `.bg-center`)。名字 / 金额 / 档位色 / 徽章的行列没变,头像本来占的那一行 / 列就此空着(皮肤版式的事,留给 ㉔)。
 * `sc-custom-layout` 的自定义版式里没摆头像块与「SC to」,字节不变,不在此列;锐评与词云的字节没有被牵连。
 */
const B_SITE_VIEWER_AVATAR_DROPPED = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	change:
		"B 站醒目留言卡 / 会员卡不再画观众与主播头像:头像格整块收起(会员卡主播胶囊里的小头像一并),块 CSS 与只有头像在用的工具类随之消失",
	basis:
		"ADR-0021 决策 26 的 2026-10-05 🔗(㉓ 开片拷问):B 站这两种卡 3a 前不画头像,viewer.avatar / creator.avatar 只收图库引用",
} as const;

/**
 * ㉓c 第 2 步(2026-10-05):会员卡不再有「房管」那一格。夹具里只有 `guard-governor` 带过房管标记(`isAdmin: 1`),
 * 它的主播胶囊里原来把主播名换成「房管」两个字,现在写主播名;另外两份没带标记,字节不变。
 *
 * 类别写 `master-approved`:三类预批都不贴切 —— 它不是叫法、不是图库图的残差、也不是 B 站纯装饰,而是**一格内容**
 * 被删了。主人当天拍板(ADR-0021 决策 26 下 2026-10-05 的 🔗;ADR-0023 决策 3 的 🔗):各平台的房管标记都挂在聊天消息上、
 * 不在会员事件上,那段替换没有任何说明、看着是写错了位置,连同为它多调的那次接口一起删,`isAdmin` 不改成 `isModerator`。
 * 字节上只有那一个文本节点(「房管」→ 主播名),别的一个字没动。
 */
const MEMBERSHIP_ADMIN_SWAP_DROPPED = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	change: "会员卡主播胶囊里不再把主播名换成「房管」(买舰的人是房管时):写主播名",
	basis:
		"ADR-0021 决策 26 的 2026-10-05 🔗(㉓ 开片拷问):会员卡没有房管这一格,各平台房管标记都在聊天消息上、不在会员事件上",
} as const;

/**
 * ㉔c(2026-10-06):块名、挂点名与字段用同一套词,**全部改一遍**(皮肤格式版本只在 alpha 前抬一次的那一次)。块名进 HTML 的
 * `data-block`,块 id 进 `bn-blk-<id>` / `data-cell`,挂点名进 `data-bn`。默认皮肤里块 id 默认是块名的连字符写法
 * (`creatorAvatar` → `creator-avatar`;块 id 只准小写字母、数字与连字符),显式块 id 里带旧叫法的也跟着改
 * (`video-desc` → `video-description`、`forward-count` → `share-count`)。画面不变,**块 CSS 的声明一个字没动**,只有选择器
 * 与属性里的名字变了。
 *
 * 十六个走默认皮肤、没拆块的样例(`dynamic-*` 十份、醒目留言三份、会员三份)同一次批准:把变更前快照里的旧名按改名表机械替换成新名,
 * 与新快照**逐字节相同**(脚本逐样例比过)。改名表见 `docs/1.0/construction-plan.md` 的「㉔ 开片」。
 */
const BLOCK_VOCABULARY_RENAMED = {
	category: "master-approved",
	approvedOn: "2026-10-06",
	change:
		"块名、挂点名与块 id 改用同一套词(data-block / bn-blk-<id> / data-cell / data-bn 里的名字变了),画面与块 CSS 声明一字未动",
	basis: "ADR-0023 决策 3 的 2026-10-06 🔗(㉔ 开片拷问):块名、挂点名与字段用同一套词",
} as const;

/**
 * ㉔c(2026-10-06):直播卡随状态换含义的两块拆成四块(`popularity` → `currentViewers` + `likes`、`fans` → `followers` +
 * `totalViewers`),每块只画一样东西、各自只在该出现的状态下有内容,默认皮肤里摆在原来那两块的位置。别的块名与块 id 一样
 * 跟着改(`avatar` / `name` / `desc` / `area` → `creatorAvatar` / `creatorName` / `description` / `category`)。
 *
 * 字节上:没渲染的块不输出任何东西(整块收起,wrapper 与块 CSS 都不出),所以一张卡里仍只出现原来那两块位置上的那一块 ——
 * 开播 / 直播中是 `currentViewers` / `followers`,下播是 `likes` / `totalViewers`,它们的块 CSS 与原 `popularity` /
 * `fans` 的**逐字相同**。旧快照按改名表(`popularity` / `fans` 按那张卡的状态换成对应的新块)机械替换后,与新快照逐字节相同。
 * 四个直播样例同一次批准。
 */
const LIVE_STATS_BLOCKS_SPLIT = {
	category: "master-approved",
	approvedOn: "2026-10-06",
	change:
		"直播卡数据区随状态换含义的两块拆成四块(popularity → currentViewers / likes,fans → followers / totalViewers),块名、块 id、挂点名同步改用新词;画面不变",
	basis:
		"ADR-0023 决策 3 的 2026-10-06 🔗(㉔ 开片拷问):直播卡随状态换含义的两块拆成四块;块名、挂点名与字段用同一套词",
} as const;

/**
 * ㉔d(2026-10-06):醒目留言卡与会员卡的外框(`data-bn="frame"` 那一层)和每个块的 wrapper(带 `bn-blk-<id>` 的那层 div)
 * 多一个属性 `data-rank="<档位>"`,皮肤 CSS 用 `[data-bn="self"][data-rank="3"]` 之类的属性选择器按档换色。醒目留言用视图上夹进
 * 1–6 的有效档位,会员用视图的 `rank`(没有 rank 的档不加)。六个档位卡样例同一次批准:把新快照里的 ` data-rank="N"` 全部删掉,
 * 与 ㉔c 的快照**逐字节相同**(脚本逐样例比过);别的样例(直播 / 作品 / 锐评 / 词云)零变化。
 */
const RANK_ATTR_ADDED = {
	category: "master-approved",
	approvedOn: "2026-10-06",
	change: "外框与每个块的 wrapper 多了属性 data-rank=<档位>(只多属性,别的一个字节没变)",
	basis: "ADR-0028 决策 4 的 2026-10-06 🔗(㉔ 开片拷问):按档换色的挂点是属性 data-rank",
} as const;

/**
 * ㉓c 第 3 步(2026-10-05):醒目留言卡的时长走核心统一的排版 `formatDuration`、金额走 `formatAmount`。
 * 预期只有时长文字变,金额字节不变 —— 实测正是如此:`sc-low` 的时长胶囊「60秒」→「1分」(少 1 字节),
 * `¥30` 一个字没动;`sc-high` 的「2小时」两种写法本来就一样,字节不变;`sc-custom-layout` 的版式里没摆时长块,不变。
 * 醒目留言卡原来自带一套「60秒 / 2分钟 / 5分钟 / 30分钟 / 1小时 / 2小时」的写法,现在前四档变成「1分 / 2分 / 5分 / 30分」,
 * 后两档不变(夹具里只有 `sc-low` 落在前四档)。
 *
 * 类别写 `master-approved`:这不是叫法中立化(那是平台专有词换中立词),是两种卡的时长写法合成核心里的一份。
 * 主人定的(ADR-0021 决策 26 下 2026-10-05 的 🔗):醒目留言的时长走 `formatDuration`;被否的备选是把 `formatDuration`
 * 的「分」改成「分钟」(所有直播卡跟着变)与醒目留言卡单写一个排版(多一个时长函数)。
 */
const SUPERCHAT_DURATION_FORMATTED = {
	category: "master-approved",
	approvedOn: "2026-10-05",
	change: "醒目留言卡的时长胶囊走 formatDuration:「60秒」写成「1分」(金额与别的字一个没动)",
	basis:
		"ADR-0021 决策 26 的 2026-10-05 🔗(㉓ 开片拷问):醒目留言的时长走 formatDuration,「60秒 / 2分钟 / 5分钟 / 30分钟」变成「1分 / 2分 / 5分 / 30分」",
} as const;

export const APPROVED_CARD_DIFFS: CardDiffList = {
	baseline: {
		"dynamic-article": "5dc8efb7725183cd",
		"dynamic-av": "3fe2f49baa0aa630",
		"dynamic-charge-only": "3bb0aea26e823e4e",
		"dynamic-custom-layout": "9c6b31abc3668adb",
		"dynamic-draw": "d8bd91abf31eafad",
		"dynamic-draw-single": "2b71a06c8da42d0f",
		"dynamic-forward": "e9349768a41a0b63",
		"dynamic-unrenderable": "c1c4a811f19545a4",
		"dynamic-with-additional": "47ca0a2ce1b3affe",
		"dynamic-word": "1619094b9d17a1a5",
		"guard-badge-left": "4953c32520c4813f",
		"guard-captain": "9f376b5f5cc8b981",
		"guard-governor": "1a670a2d04ad14ce",
		"live-ended": "cb3cbdd6abffbde9",
		"live-minimal": "821353aa66a17c4d",
		"live-streaming": "0198f11ccd8c998e",
		"live-with-fontface": "d90b9bbf14f30c22",
		"roast-board": "f9cd965bda97fc57",
		"roast-solo": "687842993460e699",
		"sc-custom-layout": "64f3c3cfef80c2a1",
		"sc-high": "c6f9e1a451794ab7",
		"sc-low": "6a6641a7c480ee7b",
		wordcloud: "a1444fb7ddc6f1ef",
	},
	approvals: [
		{ sample: "dynamic-article", ...B_SITE_AVATAR_DROPPED, hash: "8b65ad0bc7318a34" },
		{ sample: "dynamic-av", ...B_SITE_AVATAR_DROPPED, hash: "7cde7db446c7b712" },
		{ sample: "dynamic-charge-only", ...B_SITE_AVATAR_DROPPED, hash: "f0c6cd7ddbb59ae1" },
		{ sample: "dynamic-draw", ...B_SITE_AVATAR_DROPPED, hash: "6fb6f72b370824be" },
		{ sample: "dynamic-draw-single", ...B_SITE_AVATAR_DROPPED, hash: "a66ab7ec0deee7eb" },
		{ sample: "dynamic-forward", ...B_SITE_AVATAR_DROPPED, hash: "6bd80a6f1d5c9b80" },
		{ sample: "dynamic-unrenderable", ...B_SITE_AVATAR_DROPPED, hash: "c08e2e08fe2fe9c9" },
		{ sample: "dynamic-with-additional", ...B_SITE_AVATAR_DROPPED, hash: "cd1545569872a985" },
		{ sample: "dynamic-word", ...B_SITE_AVATAR_DROPPED, hash: "e07bf2a294fde0ea" },
		// ㉑c 第 2 步:小图标与表情图。
		{
			sample: "dynamic-word",
			...B_SITE_ICONS_PENDING_LIBRARY,
			change:
				"BV 号链接前的视频图标、抽奖链接前的图标不画(链接文字与颜色照旧);表情「[doge]」由图变成文字;表情 <img> 独占的四条工具类随之消失",
			hash: "172b1d322fd9c83a",
		},
		{
			sample: "dynamic-with-additional",
			...B_SITE_ICONS_PENDING_LIBRARY,
			change:
				"预约卡抽奖行前的图标不画(文字与粉色照旧);预约按钮上的铃铛不画(铃铛属第二组 bili-decoration-removed:按钮形状里没有它的位置)",
			hash: "e650729e78006930",
		},
		{
			sample: "dynamic-draw",
			...B_SITE_DECORATION_NO_SLOT,
			change: "商品卡标题(head_text)前的购物袋图标不画,文字照旧",
			hash: "c7b600f4c294bc75",
		},
		{
			sample: "dynamic-draw-single",
			...B_SITE_DECORATION_NO_SLOT,
			change: "商品卡标题(head_text)前的购物袋图标不画,文字照旧",
			hash: "0c35fcce0c92178e",
		},
		{
			sample: "dynamic-forward",
			...B_SITE_DECORATION_NO_SLOT,
			change:
				"已结束的预约卡:预约按钮上「未结束才画」的铃铛不画了,少一个 Vue 的 <!----> 占位注释(7 字节)",
			hash: "d61e5eb90eddcfa6",
		},
		// ㉑c 第 3 步:数字先成数字、再由 internal 统一排版。九份 dynamic-* 里数字原样回得去的(「16:07」「1.8万」
		// 「129」)字节不变;会变的只有排版逼的两类 —— 时长的前导零消失、接口给整数「万」时补小数位。夹具里
		// 只有一处命中:引用视频(UGC 附加卡)的时长「00:29」排成「0:29」。「1万」→「1.0万」的那一类夹具里没有,
		// 由 `dynamic-content-numbers.test.ts` 单测钉着。
		{
			sample: "dynamic-custom-layout",
			category: "master-approved",
			approvedOn: "2026-10-05",
			change:
				"引用视频(UGC 附加卡)的时长「00:29」先解析成 29 秒、再由 formatClock 排成「0:29」(前导零消失,别的一个字没动)",
			basis:
				"ADR-0021 决策 22 的 2026-10-05 🔗:播放数与时长先解析成数字、再由核心统一排版;决策 24:计数全程是数字,只在出口由 formatCount / formatClock 排一次版",
			hash: "cdced4d16d3f40de",
		},
		// ㉑c 第 4 步:附加块先画成 Attachment 的形状装得下的样子。
		{
			sample: "dynamic-with-additional",
			...B_SITE_ATTACHMENT_SHAPE,
			change:
				"预约卡:desc1 / desc2 / desc3 各占一行、同一个样式(不再并排、抽奖行不标粉);按钮去掉空壳与 span,只剩文字",
			hash: "d44fd5cdaa43ff18",
		},
		{
			sample: "dynamic-forward",
			...B_SITE_ATTACHMENT_SHAPE,
			change:
				"已结束的预约卡:desc1 / desc2 各占一行、同一个样式(不再并排);按钮去掉空壳与 span,只剩文字",
			hash: "5a1baebc35713456",
		},
		{
			sample: "dynamic-draw-single",
			...B_SITE_ATTACHMENT_SHAPE,
			change: "单件商品卡:按钮「去看看」与价格后的「起」不画,价格单独一行(不再套 flex 空壳)",
			hash: "00df393c0a15ad8a",
		},
		{
			sample: "dynamic-custom-layout",
			...B_SITE_ATTACHMENT_SHAPE,
			change: "引用视频卡:标题上方 head_text(「相关视频」)那一行不画,只装一张卡的外层 div 收掉",
			hash: "28fe2802100726cc",
		},
		{
			sample: "dynamic-word",
			...B_SITE_GAME_TAG_DROPPED,
			change:
				"通用卡:desc1 前的「游戏」边框小标签不画;desc1 / desc2 是共用的两行(desc1 的 flex 空壳与 span 收掉);属性层少了 --un-border-opacity",
			hash: "3fae5e5d38406942",
		},
		{ sample: "dynamic-article", ...UNO_PROPERTIES_LEAK, hash: "1c918368e7ee98bd" },
		{ sample: "dynamic-charge-only", ...UNO_PROPERTIES_LEAK, hash: "e3b50821fc1adb03" },
		{ sample: "dynamic-unrenderable", ...UNO_PROPERTIES_LEAK, hash: "21473146780b5013" },
		{ sample: "guard-badge-left", ...UNO_PROPERTIES_LEAK, hash: "9816805f375d3371" },
		{ sample: "guard-captain", ...UNO_PROPERTIES_LEAK, hash: "8f0028fecb0f32ef" },
		{ sample: "guard-governor", ...UNO_PROPERTIES_LEAK, hash: "8cda21ebc2a4e087" },
		{ sample: "roast-board", ...UNO_PROPERTIES_LEAK, hash: "1e72ef89b9add0d4" },
		{ sample: "roast-solo", ...UNO_PROPERTIES_LEAK, hash: "542501d21699af79" },
		{ sample: "sc-custom-layout", ...UNO_PROPERTIES_LEAK, hash: "433969f4434c183b" },
		{ sample: "sc-high", ...UNO_PROPERTIES_LEAK, hash: "89b9f61f61ea1fe4" },
		{ sample: "sc-low", ...UNO_PROPERTIES_LEAK, hash: "4be34901324ca493" },
		{ sample: "wordcloud", ...UNO_PROPERTIES_LEAK, hash: "79a6a5d97f96ee0a" },
		// ㉒b:B 站直播卡去头像。
		{ sample: "live-streaming", ...B_SITE_LIVE_AVATAR_DROPPED, hash: "24396666be453c7e" },
		{ sample: "live-ended", ...B_SITE_LIVE_AVATAR_DROPPED, hash: "3c2be15b2f36692c" },
		{ sample: "live-with-fontface", ...B_SITE_LIVE_AVATAR_DROPPED, hash: "ad9f908681176b8a" },
		// ㉓c 第 1 步:醒目留言卡与会员卡去头像。
		{ sample: "sc-low", ...B_SITE_VIEWER_AVATAR_DROPPED, hash: "1760084be142bfa0" },
		{ sample: "sc-high", ...B_SITE_VIEWER_AVATAR_DROPPED, hash: "ed529a54d4a8fb5a" },
		{ sample: "guard-captain", ...B_SITE_VIEWER_AVATAR_DROPPED, hash: "78bdc179edba8a71" },
		{ sample: "guard-governor", ...B_SITE_VIEWER_AVATAR_DROPPED, hash: "4a27508e5c8b57fc" },
		{ sample: "guard-badge-left", ...B_SITE_VIEWER_AVATAR_DROPPED, hash: "f7b0213183433dbd" },
		// ㉓c 第 2 步:会员卡删房管那一格。
		{ sample: "guard-governor", ...MEMBERSHIP_ADMIN_SWAP_DROPPED, hash: "c6046af40cdb3746" },
		// ㉓c 第 3 步:醒目留言卡的时长 / 金额走核心的统一排版。
		{ sample: "sc-low", ...SUPERCHAT_DURATION_FORMATTED, hash: "c9155605556417e8" },
		// ㉔c:块名、挂点名与块 id 改用同一套词。
		{ sample: "dynamic-article", ...BLOCK_VOCABULARY_RENAMED, hash: "c4d925ddb89c44b5" },
		{ sample: "dynamic-av", ...BLOCK_VOCABULARY_RENAMED, hash: "cdbfc71d73730c3c" },
		{ sample: "dynamic-charge-only", ...BLOCK_VOCABULARY_RENAMED, hash: "9ed916665e49ad1f" },
		{ sample: "dynamic-custom-layout", ...BLOCK_VOCABULARY_RENAMED, hash: "d08c0e6075fa52a9" },
		{ sample: "dynamic-draw-single", ...BLOCK_VOCABULARY_RENAMED, hash: "0205801e97f06d9d" },
		{ sample: "dynamic-draw", ...BLOCK_VOCABULARY_RENAMED, hash: "4a38fe9500087ef8" },
		{ sample: "dynamic-forward", ...BLOCK_VOCABULARY_RENAMED, hash: "d291f3b6905be44d" },
		{ sample: "dynamic-unrenderable", ...BLOCK_VOCABULARY_RENAMED, hash: "e52a5afe684ea5d5" },
		{ sample: "dynamic-with-additional", ...BLOCK_VOCABULARY_RENAMED, hash: "384cdf3298cd7501" },
		{ sample: "dynamic-word", ...BLOCK_VOCABULARY_RENAMED, hash: "015120578aaefea9" },
		{ sample: "guard-badge-left", ...BLOCK_VOCABULARY_RENAMED, hash: "bb046499f81d892b" },
		{ sample: "guard-captain", ...BLOCK_VOCABULARY_RENAMED, hash: "8194193e29d3eb69" },
		{ sample: "guard-governor", ...BLOCK_VOCABULARY_RENAMED, hash: "2687d90e60dc6c4f" },
		{ sample: "sc-custom-layout", ...BLOCK_VOCABULARY_RENAMED, hash: "b90b32246bd52667" },
		{ sample: "sc-high", ...BLOCK_VOCABULARY_RENAMED, hash: "c5eeddec7b251038" },
		{ sample: "sc-low", ...BLOCK_VOCABULARY_RENAMED, hash: "fd994311c43241cb" },
		// ㉔c:直播卡随状态换含义的两块拆成四块。
		{ sample: "live-ended", ...LIVE_STATS_BLOCKS_SPLIT, hash: "e33076cdcfe5924a" },
		{ sample: "live-minimal", ...LIVE_STATS_BLOCKS_SPLIT, hash: "757474e9ae300ea1" },
		{ sample: "live-streaming", ...LIVE_STATS_BLOCKS_SPLIT, hash: "7b364adbfb42801c" },
		{ sample: "live-with-fontface", ...LIVE_STATS_BLOCKS_SPLIT, hash: "17b6355ef07a2733" },
		// ㉔d:档位卡的外框与块 wrapper 多了 data-rank。
		{ sample: "guard-badge-left", ...RANK_ATTR_ADDED, hash: "a66d72d9a2374557" },
		{ sample: "guard-captain", ...RANK_ATTR_ADDED, hash: "0b13b8d5a5aa5eff" },
		{ sample: "guard-governor", ...RANK_ATTR_ADDED, hash: "64d5def3b6a060f8" },
		{ sample: "sc-custom-layout", ...RANK_ATTR_ADDED, hash: "5198152ee2a52e61" },
		{ sample: "sc-high", ...RANK_ATTR_ADDED, hash: "52403a0490276fe2" },
		{ sample: "sc-low", ...RANK_ATTR_ADDED, hash: "6b9739af41b95f2e" },
	],
};
