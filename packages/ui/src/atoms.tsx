/**
 * Atoms — Tailwind/JSX ports of `.bn-design/shared.jsx`. Inline-style escapes
 * are kept where Tailwind utilities can't take dynamic hex (per-UP color rings,
 * gradients keyed off props, stat colors).
 *
 * Source-of-truth: shared.jsx — when a design tweak lands there, mirror here.
 */

import type { CSSProperties, MouseEventHandler, ReactNode, SVGProps } from "react";
import { Icon, type IconName } from "./icons";

// ── Avatar ──────────────────────────────────────────────────────────────────

export interface AvatarProps {
	name: string;
	color: string;
	size?: number;
	ring?: boolean;
	status?: "live" | "living" | "off";
	/** Real avatar URL — if provided renders <img> instead of the initial-letter fallback. */
	url?: string;
}

export function Avatar({ name, color, size = 44, ring = false, status, url }: AvatarProps) {
	const inner: CSSProperties = {
		width: size,
		height: size,
		background: url
			? "var(--color-bn-surface)"
			: `linear-gradient(135deg, ${color}, color-mix(in srgb, ${color} 87%, transparent))`,
		fontSize: Math.round(size * 0.4),
		border: ring ? "3px solid var(--color-bn-surface)" : "2px solid var(--color-bn-surface)",
	};
	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			{/* 皮肤挂点在圆形元素上:hook 语义是「圆头像」,border/box-shadow 必须跟圆走,
			    挂外层方形定位容器会画出方框(踩过)。 */}
			<div
				data-bn="avatar"
				className="flex items-center justify-center overflow-hidden rounded-full font-bold text-bn-on-solid shadow-bn-card"
				style={inner}
			>
				{url ? (
					<img
						src={url}
						alt={name}
						className="h-full w-full object-cover"
						referrerPolicy="no-referrer"
					/>
				) : (
					(name?.[0] ?? "?")
				)}
			</div>
			{status === "live" ? (
				<span
					className="absolute -bottom-0.5 -right-0.5 rounded-md border-2 border-bn-surface bg-bn-pink px-1 text-bn-micro font-bold tracking-wider text-bn-on-solid"
					style={{ lineHeight: 1 }}
				>
					LIVE
				</span>
			) : null}
			{status === "living" ? (
				<span className="bn-anim-pulse absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-bn-surface bg-bn-pink" />
			) : null}
		</div>
	);
}

// ── Btn ─────────────────────────────────────────────────────────────────────

type BtnVariant =
	| "primary"
	| "ghost"
	| "outline"
	| "danger"
	| "danger-outline"
	| "danger-solid"
	| "blue";
type BtnSize = "sm" | "md" | "lg";

export interface BtnProps {
	children?: ReactNode;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	variant?: BtnVariant;
	size?: BtnSize;
	icon?: ReactNode;
	full?: boolean;
	disabled?: boolean;
	type?: "button" | "submit";
	title?: string;
	/** 下拉/弹层触发器的无障碍标注:透传到底层 <button>。 */
	ariaHasPopup?: boolean;
	ariaExpanded?: boolean;
}

/**
 * 每档的皮肤与外观。
 *
 * `solid` 与 `cls` **必须住在一起** —— 它就是「这档有没有实心语义底」这一件事,
 * 而实心底决定 `data-bn` 挂不挂 `btn-primary`(理由见下面那段)。分成两张表时,
 * 加一档要记得改两处,漏掉第二处的症状是**按钮在皮肤下整个隐形、而构建全绿** ——
 * 那正是 About 爱发电按钮当年的车祸。同一张表就没有漏的余地。
 */
const VARIANTS: Record<BtnVariant, { cls: string; solid?: true }> = {
	primary: { cls: "bg-bn-pink text-bn-on-solid border-transparent hover:opacity-90", solid: true },
	blue: { cls: "bg-bn-blue text-bn-on-solid border-transparent hover:opacity-90", solid: true },
	ghost: {
		cls: "bg-transparent text-bn-text-tertiary border-transparent hover:bg-bn-hover-muted",
	},
	outline: {
		cls: "bg-bn-surface text-bn-text-primary border-bn-border hover:bg-bn-surface-muted",
	},
	danger: { cls: "bg-transparent text-bn-danger border-transparent hover:bg-bn-danger/10" },
	/**
	 * `outline` 的危险语义兄弟 —— 带红描边的小钮(删除服务商 / 清除失效字体)。
	 *
	 * 与 `danger` 的区别只在**那圈边**:纯红字钮在一行文字里认不出是可点的,而这两处
	 * 都紧挨着说明文字。底仍是透明的 —— 行内小钮不该有实心底的分量;要实心红去用
	 * `danger-solid`。
	 */
	"danger-outline": {
		cls: "bg-transparent text-bn-danger-text border-bn-danger-border hover:bg-bn-danger-soft",
	},
	/**
	 * 确认弹窗里的「确认销毁」主钮 —— 实心红底,分量与 `primary` 对等。
	 *
	 * 实心语义底曾是禁区(会逼出皮肤够不着的写死白字,规矩记在 `Toast`),两个前提
	 * 变了才放行:① 前景走 `--color-bn-on-solid` token,皮肤管得着;② 实心档一律入
	 * 主按钮池(`solid: true` → 挂 `btn-primary`),皮肤会把强调实底盖回来,不会落进
	 * 「中性浅底 + 实底前景」的隐形组合。行内小删除钮别用它,那是 `danger` /
	 * `danger-outline` 的地盘。
	 */
	"danger-solid": {
		cls: "bg-bn-danger text-bn-on-solid border-transparent hover:opacity-90",
		solid: true,
	},
};

const SIZE_CLS: Record<BtnSize, string> = {
	sm: "h-[26px] px-2.5 text-xs",
	md: "h-[30px] px-3.5 text-bn-base",
	lg: "h-9 px-4 text-sm",
};

export function Btn({
	children,
	onClick,
	variant = "primary",
	size = "md",
	icon,
	full = false,
	disabled = false,
	type = "button",
	title,
	ariaHasPopup,
	ariaExpanded,
}: BtnProps) {
	return (
		<button
			type={type}
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-haspopup={ariaHasPopup}
			aria-expanded={ariaExpanded}
			// 实心语义底一律双挂 `btn btn-primary`:皮肤给 `btn` 刷中性底,只有
			// `btn-primary` 档会把强调实底盖回来 —— 单挂 `btn` 的实心钮在皮肤下就是
			// 当年 About 爱发电按钮那辆隐形车(skin-hook-coverage 盯着同一条规矩)。
			data-bn={VARIANTS[variant].solid ? "btn btn-primary" : "btn"}
			className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${SIZE_CLS[size]} ${VARIANTS[variant].cls} ${full ? "w-full" : "w-auto"}`}
		>
			{icon ? <span className="inline-flex shrink-0">{icon}</span> : null}
			{children}
		</button>
	);
}

// ── IconButton ──────────────────────────────────────────────────────────────

/**
 * 只装一枚图标的方钮/圆钮 —— 关闭、移除、展开、翻页箭头那一类。
 *
 * 收编前站内手写了 23 处,高度漂成 `h-4 / 4.5 / 5 / 5.5 / 6 / 7 / 7.5 / 8.5 / 9 /
 * [34px]` **十档**,而真正的语义只有五档;hover 六种写法、语义只有四种;挂点更是
 * 各挂各的、大半没挂。这十档不是设计,是一路 copy-paste 时各改各的。
 *
 * `size` 收命名档而不是像 {@link Avatar} 那样收数字:数字只是把漂移换个地方放。
 * 真要一个档位表里没有的尺寸,先问是不是该有第六档。
 *
 * `tone` 只管 **hover 语义**,静态字色一律 `text-bn-text-tertiary` —— 图标钮平时
 * 就该是安静的,红/粉只在指上去时出现。这跟 {@link ToneChip} 是同一条道理:让
 * 颜色去承担静态可读性,亮色下红字图标只有 3 点几的对比度。
 *
 * `className` 只收**定位这类不冲突的**工具类(`absolute right-1 top-1`、
 * `opacity-0 group-hover:opacity-100`)。仓库没装 tailwind-merge,同名工具类谁赢
 * 由生成顺序定,想覆盖本体样式是覆盖不住的 —— 要改本体就加档,别在调用点硬掰。
 */

type IconButtonSize = "xs" | "sm" | "md" | "lg" | "xl";
type IconButtonTone = "neutral" | "danger" | "accent";

export interface IconButtonProps {
	icon: ReactNode;
	/** 读屏器名字。图标本身没有文字,这个必填。 */
	label: string;
	/**
	 * tooltip。不给就跟着 `label` —— 两者**刻意可以不同**:侧栏删除钮的 tooltip
	 * 只写「删除这个对话」,读屏器那句要念出是哪个对话。
	 */
	title?: string;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	size?: IconButtonSize;
	tone?: IconButtonTone;
	/** 默认小方角;`pill` 给正圆那一档(翻页箭头、头像角标)。 */
	shape?: "square" | "pill";
	/**
	 * 背景处理。缺省无底,只在悬停时染一下。
	 *
	 * - `filled` —— 描边 + 面底色,需要从背景里「浮」出来时用(滚动箭头、附件角标)。
	 * - `scrim` —— 半透明遮罩 + 磨砂 + 实底上的前景色,给**压在图片 / 渐变上**的那种
	 *   (UP 弹窗封面上的关闭钮、壁纸缩略图上的删除钮)。那底下是任意内容,常规的
	 *   `text-tertiary` 字色一律不可读,所以这一档连静态字色一起换掉 —— 仓库没装
	 *   tailwind-merge,两个 `text-*` 同时出现只会由生成顺序决定谁赢。
	 */
	surface?: "filled" | "scrim";
	disabled?: boolean;
	/** 下拉/弹层触发器的无障碍标注,同 {@link BtnProps}。 */
	ariaHasPopup?: boolean;
	ariaExpanded?: boolean;
	className?: string;
}

const ICON_BUTTON_SIZE: Record<IconButtonSize, string> = {
	xs: "h-4 w-4",
	sm: "h-5 w-5",
	md: "h-6 w-6",
	lg: "h-7 w-7",
	xl: "h-9 w-9",
};

const ICON_BUTTON_TONE: Record<IconButtonTone, string> = {
	neutral: "text-bn-text-tertiary hover:bg-bn-hover-muted hover:text-bn-text-primary",
	danger: "text-bn-text-tertiary hover:bg-bn-danger-soft hover:text-bn-danger-text",
	accent: "text-bn-text-tertiary hover:bg-bn-pink/10 hover:text-bn-pink",
};

const ICON_BUTTON_SURFACE = {
	filled: "border border-bn-border-subtle bg-bn-surface shadow-bn-card",
	scrim: "bg-bn-overlay text-bn-on-solid backdrop-blur-sm",
} as const;

/**
 * `scrim` 档的 hover —— 静态字色由遮罩那一档定死,这里只管悬停反馈。
 *
 * `accent` 目前**没有调用点**(站里三处 `surface="scrim"` 都是 neutral),但它
 * 不是死码:类型是 `Record<IconButtonTone, …>`,三档必须齐 —— 这一条是「万一
 * 有人写 accent + scrim,该长什么样」的**预先回答**。删掉就得把类型改成
 * `Partial`,那是拿一个编译期保证换一个静默的空档(悬停毫无反馈,而且不会红)。
 */
const ICON_BUTTON_SCRIM_TONE: Record<IconButtonTone, string> = {
	neutral: "hover:opacity-80",
	danger: "hover:bg-bn-danger-text",
	accent: "hover:bg-bn-pink",
};

export function IconButton({
	icon,
	label,
	title,
	onClick,
	size = "sm",
	tone = "neutral",
	shape = "square",
	surface,
	disabled,
	ariaHasPopup,
	ariaExpanded,
	className,
}: IconButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title ?? label}
			aria-label={label}
			aria-haspopup={ariaHasPopup}
			aria-expanded={ariaExpanded}
			data-bn="btn"
			className={`grid shrink-0 cursor-pointer place-items-center transition disabled:cursor-not-allowed disabled:opacity-50 ${
				shape === "pill" ? "rounded-bn-pill" : "rounded-bn-xs"
			} ${ICON_BUTTON_SIZE[size]} ${
				surface === "scrim" ? ICON_BUTTON_SCRIM_TONE[tone] : ICON_BUTTON_TONE[tone]
			} ${surface ? ICON_BUTTON_SURFACE[surface] : ""} ${className ?? ""}`}
		>
			{icon}
		</button>
	);
}

// ── AddButton / AddCard ─────────────────────────────────────────────────────

/**
 * 「这里还能再加一个」的虚线语汇 —— 虚线边=空位,指上去变粉=点我。
 *
 * 收编前站内九处手写,圆角在 `rounded-md / lg / xl / bn-sm / bn-pill` **五种**
 * 之间漂、字号四种、字重三种、hover 五种写法,而它们说的是同一件事。
 *
 * 拆成两个组件而不是一个带 `variant` 的:{@link AddCard} 连内部结构(＋ / 标题 /
 * 副标题)一起给,这里收自由 children,塞进同一个壳只会得到一个两幅面孔的东西。
 *
 * **刻意不挂 `data-bn="btn"`**(同 MenuItem 的理由):虚线边**就是**这对组件的
 * 语义 —— 「这里是个空位」。皮肤给按钮写的实底描边 + 底色一落上来,空位就长成了
 * 一颗按钮,和真按钮再分不出来(2026-08-23 主人真机指出「新建推送目标」整个变实框)。
 * 挂点词表里也没有「空位」这一档;虚线语汇对所有皮肤保持原样,像 avatar 永远是圆的一样。
 */

/** 两者共用的虚线语汇。改这里等于同时改两个组件 —— 它们本来就该一起动。 */
const ADD_LANGUAGE =
	"border border-dashed border-bn-border text-bn-text-secondary transition hover:border-bn-pink hover:text-bn-pink disabled:cursor-not-allowed disabled:opacity-60";

export interface AddButtonProps {
	children: ReactNode;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	/** 占满一整行(列表末尾那种)。默认是行内短钮。 */
	block?: boolean;
	disabled?: boolean;
	className?: string;
}

export function AddButton({ children, onClick, block, disabled, className }: AddButtonProps) {
	// 行内走药丸(跟同排的 Pill / ToneChip 一个形状),占整行的走卡片圆角 ——
	// 一条横贯整行的药丸不像按钮,像进度条。
	const shape = block
		? "flex w-full items-center justify-center rounded-lg px-3 py-2 text-bn-sm"
		: "inline-flex items-center rounded-bn-pill px-2.5 py-1 text-bn-xs";
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`gap-1.5 font-semibold ${shape} ${ADD_LANGUAGE} ${className ?? ""}`}
		>
			{children}
		</button>
	);
}

export interface AddCardProps {
	/** 卡片中间那行标题(「添加 UP 主」)。 */
	label: string;
	/** 标题下的一行小字(「UID / 名称搜索」)。 */
	hint: string;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	disabled?: boolean;
	/** 只收**不冲突**的追加项:底色、最小高度、焦点环。覆盖本体是覆盖不住的。 */
	className?: string;
}

/**
 * 网格里的「再加一格」卡片。`h-full` 是要紧的:栅格同行取最高那张卡,不撑满的话
 * 这一格会比同排的矮一截。
 */
export function AddCard({ label, hint, onClick, disabled, className }: AddCardProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`flex h-full flex-col items-center justify-center rounded-xl px-4 py-5 text-center hover:bg-bn-pink/5 ${ADD_LANGUAGE} ${className ?? ""}`}
		>
			<span className="text-bn-xl leading-none text-bn-text-tertiary">＋</span>
			<span className="mt-1 text-bn-sm font-semibold text-bn-text-primary">{label}</span>
			<span className="mt-0.5 text-bn-2xs text-bn-text-tertiary">{hint}</span>
		</button>
	);
}

export interface AddFileButtonProps {
	/** `<input type="file">` 的 accept 串。 */
	accept: string;
	uploading?: boolean;
	uploadingLabel?: string;
	onFile: (file: File | undefined) => void;
	/** 形状(图格 aspect / 行内钮 padding / 字号字重)由摆放处给 —— 布局不同不是漂移。 */
	className?: string;
	children: ReactNode;
}

/**
 * 「点这里挑个文件上传」—— {@link AddButton} 的 file-input 变体:同一份虚线空位
 * 语汇,壳是 `<label>` 裹一个隐藏的 `<input type="file">`。收编前图库格与字体钮
 * 各手写一份,hover 组合逐字符相同。上传中把内容换成一句话,input 同时禁用。
 */
export function AddFileButton({
	accept,
	uploading,
	uploadingLabel = "上传中…",
	onFile,
	className,
	children,
}: AddFileButtonProps) {
	return (
		<label className={`cursor-pointer ${ADD_LANGUAGE} ${className ?? ""}`}>
			{uploading ? uploadingLabel : children}
			<input
				type="file"
				accept={accept}
				className="hidden"
				disabled={uploading}
				onChange={(e) => onFile(e.target.files?.[0] ?? undefined)}
			/>
		</label>
	);
}

// ── MenuItem ────────────────────────────────────────────────────────────────

/**
 * 弹层(下拉、右键菜单、附件菜单)里的一整行。
 *
 * 收编前站内七行手写:padding 四种、gap 两种、圆角三种、hover 三种、字号三种,
 * 而它们说的都是「一个浮层里、占满宽、指上去有底色的一行」。选中态只有主题下拉
 * 写了、danger 只有右键菜单写了 —— 收成一份之后这两种态对所有菜单都在。
 *
 * **刻意不挂 `data-bn="btn"`**:皮肤给按钮写的实底落到每一行菜单上会很难看,而
 * 挂点词表里没有 `menu-item` 这一档。浮层本体自己挂了 `glass-strong`,皮肤能改
 * 的是那层。给菜单行开新挂点是产品决定,不该顺手塞进重构里。
 */

type MenuItemRole = "menuitem" | undefined;

export interface MenuItemProps {
	children: ReactNode;
	/** 行首图标。**不给就不留空槽** —— 留了的话没图标那几行的文字会莫名缩进。 */
	icon?: ReactNode;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	/** 当前项(主题下拉那种「现在用的是这个」)。 */
	active?: boolean;
	/** 销毁性动作,整行连图标一起转红。 */
	danger?: boolean;
	disabled?: boolean;
	/** 容器真的是 `role="menu"` 时传 `"menuitem"`,否则留空走默认的 button。 */
	role?: MenuItemRole;
	/**
	 * 行内有副标题时**必须给** —— 读屏器默认把整行的文字连起来念,「浅色」加上
	 * 那行小字会变成「浅色 一直亮着」。只有一段文字的行不用管。
	 */
	ariaLabel?: string;
}

export function MenuItem({
	children,
	icon,
	onClick,
	active = false,
	danger = false,
	disabled,
	role,
	ariaLabel,
}: MenuItemProps) {
	const state = danger
		? "text-bn-danger-text hover:bg-bn-danger-soft"
		: active
			? "bg-bn-pink/12 font-bold text-bn-pink"
			: "text-bn-text-primary hover:bg-bn-hover-muted";
	return (
		<button
			type="button"
			role={role}
			aria-label={ariaLabel}
			onClick={onClick}
			disabled={disabled}
			// 候选行的词。**不挂 btn** —— 皮肤给按钮写的实底落到每一行菜单上,一屏
			// 就成了一摞按钮(这正是这一族从前宁可零挂点的原因)。
			data-bn={active ? "option option-active" : "option"}
			className={`flex w-full cursor-pointer items-center gap-2.5 rounded-bn-xs px-3 py-2 text-left text-bn-base transition disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${state}`}
		>
			{icon ? (
				<span className={`shrink-0 ${danger ? "text-bn-danger-text" : "text-bn-text-secondary"}`}>
					{icon}
				</span>
			) : null}
			{children}
		</button>
	);
}

// ── Pill ────────────────────────────────────────────────────────────────────

export interface PillProps {
	children: ReactNode;
	color?: string;
	subtle?: boolean;
	size?: "sm" | "md";
	className?: string;
}

export function Pill({
	children,
	color = "var(--color-bn-pink)",
	subtle = false,
	size = "md",
	className,
}: PillProps) {
	const sizeCls = size === "sm" ? "text-bn-2xs px-1.5 leading-4" : "text-bn-xs px-2 leading-[18px]";
	// `--bn-tint` 同 ToneChip 那条:皮肤盖不动徽章的语义色,但描边时得引用得到它。
	// 两档都给 —— 实底那档的边也该跟着底走,而不是罩一圈别的颜色。
	const style: CSSProperties = {
		...(subtle
			? { background: `color-mix(in srgb, ${color} 12%, transparent)`, color }
			: { background: color, color: "var(--color-bn-on-solid)" }),
		"--bn-tint": color,
	} as CSSProperties;
	return (
		<span
			// 与顶栏那个状态胶囊同族,共用 `badge` 挂点 —— 皮肤买到的只是造型:底色与
			// 字色走行内样式(`color` 是调用方传的语义色:平台色、推送类型色),盖不动。
			// 那正是想要的,改掉等于让徽章说谎。
			data-bn="badge"
			className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-bold tracking-wide ${sizeCls} ${className ?? ""}`}
			style={style}
		>
			{children}
		</span>
	);
}

// ── ToneChip ────────────────────────────────────────────────────────────────

export interface ToneChipProps {
	children: ReactNode;
	/**
	 * 选中态的语义色。收十六进制**或** `var(--color-bn-*)` —— 透明度用 `color-mix()`
	 * 现调,不走 `${tone}1f` 那种十六进制 alpha 后缀(后缀只对 6 位 hex 生效,
	 * 传 var() 会静默变成一条废样式)。
	 *
	 * 只在 `active` 时用得上,所以可选:没有开关态的纯操作钮不必填一个用不上的颜色。
	 */
	tone?: string;
	/** 选中 / 开启。缺省 false = 中性描边态。 */
	active?: boolean;
	onClick?: () => void;
	disabled?: boolean;
	/** 内容按大写渲染(日志等级那排要,类型筛选不要)。 */
	uppercase?: boolean;
}

/**
 * 「一排里选一个 / 开一个」的可点胶囊 —— 选中时 `tone` 上底(12%)与描边(实色)、
 * 字走正文色,未选中时退回中性描边。
 *
 * 与 {@link Pill} 的分工:Pill 是不可点的徽章(`<span>`,无描边),这个是可点的
 * 胶囊(`<button>`,挂 `data-bn="chip"` 跟着换肤走造型 —— 它改的是某个值,不是
 * 执行动作,所以不挂 btn)。**别拿 Pill 套 onClick** —— 徽章语义混进胶囊语义,
 * 挂点也就无处可挂了。
 *
 * `tone` 是**内容语义色**(error 红 / 直播粉 / 暂停橙),刻意不跟主强调色换肤:
 * 换个皮肤不该把「error」染成别的颜色。
 *
 * **tone 不承担可读性** —— 它只上底与边,文字恒走正文色 token。让 tone 当字色
 * 时,字与底同色相,对比度受限于 tone 与主题背景的明度差:亮色下 warn 1.90:1、
 * info 2.22:1,暗色下深调的紫 2.84:1、灰 2.45:1,七档里过不了 AA 的有五档 / 两档。
 *
 * 皮肤能改的是造型那一半(圆角、描边样式、阴影、字重),走 `chip` 挂点;
 * 选中态额外挂 `chip-active`,但那一档**只买得到造型** —— 底与边是 tone 的行内
 * 样式,皮肤盖不动。这是**刻意的**,不是挂点漏了:见下面 `style` 那段。
 */
export function ToneChip({
	children,
	tone = "var(--color-bn-pink)",
	active = false,
	onClick,
	disabled,
	uppercase,
}: ToneChipProps) {
	// 底与边**刻意留在 inline**,不像候选行那样拆成 `--bn-tint` + @utility(那条路
	// 是 7e8a00e 给服务商卡与适配器行走的)。原因是这排胶囊**能同时亮好几颗**:
	// 日志页的等级筛选是多选(`levels.has(l)` + toggleLevel),DEBUG/INFO/WARN/ERROR
	// 四档可以一起选中。底一旦挪出 inline,皮肤一句 `chip-active{background:…}` 就
	// 把四档抹成同一个颜色 —— 而「严重度是产品语言、皮肤重上色会让 warn 和 error
	// 撞成一色」正是 `config/log-levels.ts` 那张色表立下的规矩。候选行不同:那儿
	// 一次只选中一个,盖掉品牌色只是少了一条身份信息,不会让一组东西塌成一坨。
	//
	// **字色不用 tone**,走正文色 token ——
	// 字与底同色相时对比度受限于 tone 与主题背景的明度差,亮色下 warn 只有
	// 1.90:1、暗色下深紫 2.84:1(7 档里 5 档 / 2 档不过 AA)。改由实色边框承担
	// 色彩识别,真机上比 12% 淡底更醒目,识别度不降反升。
	// 未选中态整个是静态的,走 class —— inline 没有 `:hover`,写进去这颗胶囊就
	// 永远没有悬停反馈。
	// `--bn-tint` 是**给皮肤读的**,不是给这里用的:皮肤盖不动这个底(见上面那段),
	// 但描边时得引用得到它 —— 否则只能挑一个固定色,而固定色会把语义色整个盖掉
	// (2026-08-24 真机:四档日志等级被同一圈紫框抹平)。只在选中态给:未选中是
	// 中性档,染上语义色等于把这一档取消了。
	const style: CSSProperties | undefined = active
		? ({
				background: `color-mix(in srgb, ${tone} 12%, transparent)`,
				borderColor: tone,
				"--bn-tint": tone,
			} as CSSProperties)
		: undefined;
	const toneCls = active
		? "text-bn-text-primary"
		: "bg-transparent text-bn-text-tertiary border-bn-border hover:text-bn-text-primary";
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			data-bn={active ? "chip chip-active" : "chip"}
			className={`inline-flex items-center gap-1 rounded-bn-pill border px-3 py-1 text-bn-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${toneCls} ${uppercase ? "uppercase" : ""}`}
			style={style}
		>
			{children}
		</button>
	);
}

// ── StatusDot ───────────────────────────────────────────────────────────────

export type StatusDotKind = "live" | "living" | "off" | "ok" | "warn" | "err" | "pending";

/**
 * 七档语义色。**全部走 token** —— 同 {@link Toggle} 那条:写死的话皮肤配了
 * accent / success / warning / danger 四把刷子也刷不到这颗点上,整站换装后
 * 只有这一排小点还是原来的配色。
 *
 * 收编前那七个字面量还和语义 token 对不齐:`ok` 是 green-500 而 success 是
 * emerald-500、`warn` 是 amber-500 而 warning 是更深的 amber-600、`live` 是
 * `#FF6699`(`push-kinds.ts` 点名过的那条粉色漂移,正主是 `#fb7299`)。
 *
 * 两档灰**不能并成一个**:`off` 走 textDisabled(浅)、`pending` 走 textTertiary
 * (深),原本是 `#cccccc` / `#94a3b8` 的深浅关系,靠它分「关着的」与「等着的」。
 */
const STATUS_COLORS: Record<StatusDotKind, string> = {
	live: "var(--color-bn-pink)",
	living: "var(--color-bn-pink)",
	off: "var(--color-bn-text-disabled)",
	ok: "var(--color-bn-success)",
	warn: "var(--color-bn-warning)",
	err: "var(--color-bn-danger)",
	pending: "var(--color-bn-text-tertiary)",
};

export type StatusDotProps = (
	| { kind: StatusDotKind; color?: undefined }
	| {
			kind?: undefined;
			/**
			 * 逐项动态的图例色(模块 tone、版式 accent、锐评亮点色)—— 与 `kind` 二选一。
			 * 同 {@link ToneChip} 的 `tone`:内容语义色走行内是站规允许的那一种动态,
			 * 但**能用语义档就用 `kind`**,color 只给档位表说不出来的逐项色。
			 */
			color: string;
	  }
) & {
	/** `md`(默认)= 8px 状态点;`sm` = 6px,给行内图例(模块色标、版式圆点)那一档。 */
	size?: "sm" | "md";
	/** 只收定位/外边距这类不冲突的工具类(`mt-1.5` 对齐行首之类),覆盖本体是覆盖不住的。 */
	className?: string;
};

export function StatusDot({ kind, color, size = "md", className }: StatusDotProps) {
	const blink = kind === "live" || kind === "living";
	const style: CSSProperties = {
		background: color ?? (kind ? STATUS_COLORS[kind] : undefined),
		// 光晕从强调色现调,别写死那圈粉 rgba —— 点变了色而光晕没变,是最难看的一种脱节。
		boxShadow: blink
			? "0 0 0 3px color-mix(in srgb, var(--color-bn-pink) 18%, transparent)"
			: undefined,
	};
	return (
		<span
			className={`inline-block shrink-0 rounded-full ${size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"} ${blink ? "bn-anim-pulse" : ""} ${className ?? ""}`}
			style={style}
		/>
	);
}

// ── Toggle ──────────────────────────────────────────────────────────────────

export interface ToggleProps {
	value: boolean;
	onChange: (next: boolean) => void;
	size?: "sm" | "md";
	disabled?: boolean;
	/**
	 * 给读屏器的名字。不传时这颗开关念出来就是「一个按钮」—— 旁边有文字说明的
	 * 场合还能靠上下文猜,单独摆着的就完全不知道它管什么。
	 */
	ariaLabel?: string;
}

export function Toggle({ value, onChange, size = "md", disabled, ariaLabel }: ToggleProps) {
	const sz = size === "sm" ? { w: 28, h: 16, dot: 12 } : { w: 36, h: 20, dot: 16 };
	// **只留运行时几何量**。宽高是每档不同的尺寸,留在行内还有一层好处:行内压过
	// 一切 author 样式,皮肤写 width/height 掰不坏这颗开关。
	const trackStyle: CSSProperties = { width: sz.w, height: sz.h };
	// 底色走 token 而不是字面值 —— `--color-bn-pink` 正是皮肤 `colors.accent` 的落点。
	// 写死 #FB7299 的后果是全站每一颗开关的「开」都还是 B 站粉,皮肤换了主强调色也
	// 搬不动。关闭态同理走 `textDisabled`(默认装 #d1d5db,与从前写死的 #d8d8d8 几乎
	// 同色)—— 语义正好是「这一档是关着的」,而每套皮肤都配了它。
	//
	// 走 class 而不是行内:行内没得覆盖,`switch-on` 那一档就只剩描边加影可写。
	const trackTone = value ? "bg-bn-pink" : "bg-bn-text-disabled";
	const dotStyle: CSSProperties = {
		width: sz.dot,
		height: sz.dot,
		left: value ? sz.w - sz.dot - 2 : 2,
		top: 2,
		transition: "left 0.18s",
	};
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				if (!disabled) onChange(!value);
			}}
			disabled={disabled}
			aria-label={ariaLabel}
			aria-pressed={ariaLabel ? value : undefined}
			// **不挂 `btn`**:皮肤给按钮写的实底会盖掉轨道背景,开关的开/关当场看不
			// 出来。开关有自己的词,而且「开」单分一档 —— 皮肤要重画轨道得两档分别写。
			data-bn={value ? "switch switch-on" : "switch"}
			// 禁用态除了淡下去,指针也得跟着变 —— 只淡不换指针的话,鼠标一悬停
			// 仍是「可点」的手型,点下去却毫无反应,像坏了而不像被禁用。
			// 圆角走 class 上的 pill 轴,**不能写进 style** —— inline 压过一切 author
			// 样式,皮肤把 radius.pill 调到 0 求一身硬直角也掰不直这一颗。
			className={`relative shrink-0 cursor-pointer rounded-bn-pill border-none transition disabled:cursor-not-allowed disabled:opacity-50 ${trackTone}`}
			style={trackStyle}
		>
			<span
				// 滑块跟着轨道走:只掰直轨道的话,方轨道里滚着个圆球 —— 所以它也得有
				// 挂点,不然皮肤只够得到轨道那一半。
				data-bn="switch-dot"
				className="absolute rounded-bn-pill bg-bn-surface shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
				style={dotStyle}
			/>
		</button>
	);
}

// ── Input ──────────────────────────────────────────────────────────────────

export interface InputProps {
	value: string;
	onChange: (next: string) => void;
	placeholder?: string;
	icon?: ReactNode;
	size?: "sm" | "md";
	full?: boolean;
	type?: string;
}

export function Input({
	value,
	onChange,
	placeholder,
	icon,
	size = "md",
	full = false,
	type = "text",
}: InputProps) {
	const sz = size === "sm" ? "h-7 text-xs" : "h-8 text-bn-base";
	return (
		<div
			data-bn="input"
			className={`inline-flex items-center gap-1.5 rounded-md border border-bn-border bg-bn-field px-2.5 ${sz} ${full ? "w-full flex-1" : "w-auto"}`}
		>
			{icon ? (
				<span className="inline-flex h-3.5 w-3.5 shrink-0 text-bn-text-secondary">{icon}</span>
			) : null}
			<input
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="min-w-0 flex-1 border-0 bg-transparent text-bn-text-primary outline-none placeholder:text-bn-text-secondary"
			/>
		</div>
	);
}

// ── Spinner ────────────────────────────────────────────────────────────────

export interface SpinnerProps {
	/** 直径(px)。 */
	size?: number;
	/** 环粗(px)。 */
	thickness?: number;
	className?: string;
}

/** 品牌色圆环加载指示:淡粉底环 + 粉色顶弧旋转。 */
export function Spinner({ size = 32, thickness = 2, className }: SpinnerProps) {
	return (
		<div
			className={`bn-anim-spin rounded-full border-solid border-bn-pink/30 border-t-bn-pink ${className ?? ""}`}
			style={{ width: size, height: size, borderWidth: thickness }}
		/>
	);
}

// ── CheckRow ────────────────────────────────────────────────────────────────

export interface CheckRowProps {
	checked: boolean;
	onChange: (next: boolean) => void;
	children: ReactNode;
}

/** 多选列表的选项行:粉色勾选方块 + 文本,checkbox 本体 sr-only。 */
export function CheckRow({ checked, onChange, children }: CheckRowProps) {
	return (
		<label
			// 多选列表的一行 = 候选行。是 `<label>` 而不是 `<button>`(覆盖守卫扫不到
			// 它),但形态与下拉菜单行、搜索结果同族,共用 option 不新造词。
			data-bn={checked ? "option option-active" : "option"}
			className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-bn-base transition ${
				checked
					? "border-bn-pink/60 bg-bn-pink/10 font-semibold text-bn-text-primary"
					: "border-bn-border bg-bn-surface text-bn-text-secondary hover:border-bn-pink/40 hover:bg-bn-surface-muted"
			}`}
		>
			<input
				type="checkbox"
				checked={checked}
				onChange={() => onChange(!checked)}
				className="sr-only"
			/>
			<span
				className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition ${
					checked ? "border-bn-pink bg-bn-pink text-bn-on-solid" : "border-bn-border bg-bn-surface"
				}`}
			>
				{checked ? <Icon.check size={11} /> : null}
			</span>
			<span className="truncate">{children}</span>
		</label>
	);
}

// ── ErrorNote ───────────────────────────────────────────────────────────────

export interface ErrorNoteProps {
	children: ReactNode;
	/**
	 * 左侧图标(通常是 `Icon.warning`)。给了才排成两列,不给就不套 flex 壳 ——
	 * 一行字塞进两列布局只会白白多一层。
	 */
	icon?: ReactNode;
	/**
	 * 同 {@link EmptyNote},**三档不是可选项而是三种位置**:
	 * `sm` 挤在密集卡片里(UpCard 整张卡的字号只有 10~11px,12px 的错误行会成为
	 * 全卡最大的字),`md`(默认)给表单与面板,`lg` 给整条消息流里的横幅
	 * (AI 聊天的正文是 13px,内边距也对齐气泡)。除此之外别再加档。
	 */
	size?: "sm" | "md" | "lg";
	className?: string;
}

/**
 * 提示盒三兄弟(`ErrorNote` / `WarnNote` / `EmptyNote`)**共用**的尺寸阶梯。
 *
 * 它们说的是同一类话,所以只该差颜色、不该差形状。收编前三个各写各的:红盒
 * `rounded-md` 12px、黄盒 `rounded-lg` 11.5px、空态盒又是另外两档 —— 同一个弹窗里
 * 「保存失败」与「有几处没照办」当场长成两种控件。`note-family.test.tsx` 钉着这条。
 *
 * **只管圆角与字号**。内边距不在这儿:空态盒要撑满整块面板的留白、红盒挤在表单
 * 字段之间,那是位置决定的,不是漂移,各组件自己配。
 */
const NOTE_SIZE = {
	sm: "rounded-md text-bn-xs",
	md: "rounded-lg text-bn-sm",
	lg: "rounded-xl text-bn-base",
} as const;

const ERROR_NOTE_SIZE = {
	sm: `${NOTE_SIZE.sm} px-2 py-1.5 leading-snug`,
	md: `${NOTE_SIZE.md} p-2.5 leading-relaxed`,
	lg: `${NOTE_SIZE.lg} px-4 py-3 leading-relaxed`,
} as const;

/** 图标与首行文字的基线对齐量,随字号走。 */
const ERROR_NOTE_ICON_NUDGE = { sm: "mt-px", md: "mt-0.5", lg: "mt-0.5" } as const;

/**
 * 错误/失败提示盒 —— 「XX 失败:…」这类红字盒子的唯一写法。
 * 外边距(mt-3 / mb-3 …)交给调用方 className,盒子本体样式不许各处漂。
 *
 * `role="alert"` 是**恒定**的,不做成开关:21 个调用点无一例外都是「出错了才渲染」,
 * 而这正是 alert 的定义。收编前只有 AI 聊天手写的那两份带了 role,库件反而没有,
 * 于是其余 19 处的失败对读屏器完全不存在。
 */
export function ErrorNote({ children, icon, size = "md", className }: ErrorNoteProps) {
	const base = `border border-bn-danger-border bg-bn-danger-soft text-bn-danger-text ${ERROR_NOTE_SIZE[size]}`;
	if (!icon) {
		return (
			<div role="alert" data-bn="note note-danger" className={`${base} ${className ?? ""}`}>
				{children}
			</div>
		);
	}
	return (
		<div
			role="alert"
			data-bn="note note-danger"
			className={`flex items-start gap-1.5 ${base} ${className ?? ""}`}
		>
			<span className={`${ERROR_NOTE_ICON_NUDGE[size]} shrink-0`} aria-hidden="true">
				{icon}
			</span>
			<span>{children}</span>
		</div>
	);
}

const WARN_NOTE_SIZE = {
	sm: `${NOTE_SIZE.sm} px-2 py-1.5`,
	md: `${NOTE_SIZE.md} px-3 py-2`,
} as const;

/**
 * 黄字提示盒 —— 「做完了,但有几处没照办」这一档。红字那档见 {@link ErrorNote}。
 *
 * 行高**刻意不给**:两处用它的地方(皮肤上传警告、消息排版提示)一个是短句列表、
 * 一个是整段说明,行高各要各的。同名工具类在一个 class 串里谁赢由生成顺序定,
 * 靠调用方覆盖不住,所以基础样式里干脆不放。
 *
 * `size` 两档与 {@link ErrorNote} 对齐 —— 有了它,「红 / 黄双色同形」的一对才写得出来
 * (FontPicker 那处此前正是因为库里两兄弟一大一小,只能自己手搓一份)。
 */
export function WarnNote({
	children,
	size = "md",
	className,
}: {
	children: ReactNode;
	size?: "sm" | "md";
	className?: string;
}) {
	return (
		<div
			data-bn="note note-warn"
			className={`border border-bn-warning/40 bg-bn-warning/10 text-bn-warning ${WARN_NOTE_SIZE[size]} ${className ?? ""}`}
		>
			{children}
		</div>
	);
}

/**
 * 空状态提示盒 —— 「这里还什么都没有」那一档中性虚线框,与 {@link ErrorNote}(红)、
 * {@link WarnNote}(黄)同族,只是它不报警,所以走中性边与正文次级字色。
 *
 * **两档尺寸不是可选项而是两种位置**:`md` 给整块面板的空态(Dashboard 那几张卡,
 * 盒子要撑满卡片留白),`sm` 给表单小节里内嵌的一行空态(挤在字段之间,撑大就顶跑
 * 下面的控件)。除此之外别再加档 —— 收编前站内手写了九份,同一个意思在四种圆角
 * (`rounded-md` 6px / `rounded-bn-sm` 9.5px / `rounded-lg` 8px / `rounded-bn-card`
 * 14px)和三种字号之间漂,看着像四种不同的控件。
 *
 * 外边距(mt-3 / mb-2 …)交给调用方 `className`,盒子本体样式不许各处漂。
 */
export interface EmptyNoteProps {
	children: ReactNode;
	size?: "sm" | "md";
	className?: string;
}

const EMPTY_NOTE_SIZE = {
	sm: `${NOTE_SIZE.sm} px-3 py-3`,
	md: `${NOTE_SIZE.md} p-6`,
} as const;

export function EmptyNote({ children, size = "md", className }: EmptyNoteProps) {
	return (
		<div
			data-bn="note note-empty"
			className={`border border-dashed border-bn-border text-center text-bn-text-secondary ${EMPTY_NOTE_SIZE[size]} ${className ?? ""}`}
		>
			{children}
		</div>
	);
}

// ── PlatformIcon ────────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, { color: string; label: string; icon?: IconName }> = {
	onebot: { color: "#3b82f6", label: "OneBot", icon: "qq" },
	"qq-official": { color: "#14b8a6", label: "QQ官方", icon: "qq" },
	webhook: { color: "#22c55e", label: "Webhook" },
};

/**
 * 平台的标识色。**认不出的平台退静默档** —— 「不认识」正是那个 token 的意思。
 *
 * 导出它是为了让 Targets 的平台胶囊别再照着 `PLATFORM_META` 抄第二份:那份副本连
 * 兜底的 `#888` 都一字不差,而站里同义的灰正在往 `--color-bn-inactive` 上收。
 */
export function platformTint(platform: string): string {
	return PLATFORM_META[platform]?.color ?? "var(--color-bn-inactive)";
}

export function PlatformIcon({ platform, size = 16 }: { platform: string; size?: number }) {
	const meta = PLATFORM_META[platform];
	const color = platformTint(platform);
	const I = meta?.icon ? Icon[meta.icon] : null;
	if (I) return <I size={size} style={{ color }} />;
	const label = meta?.label ?? platform;
	const badgeStyle: CSSProperties & SVGProps<SVGSVGElement> = {
		width: size,
		height: size,
		borderRadius: size * 0.22,
		background: color,
		fontSize: size * 0.52,
	};
	return (
		<span
			className="inline-flex shrink-0 items-center justify-center font-extrabold tracking-tighter text-bn-on-solid"
			style={badgeStyle}
		>
			{label[0]}
		</span>
	);
}

export function platformLabel(platform: string): string {
	return PLATFORM_META[platform]?.label ?? platform;
}

// ── StatsBar (mini bar chart) ──────────────────────────────────────────────

export interface StatsBarDatum {
	d: string;
	live: number;
	dyn: number;
	sc: number;
	guard: number;
}

/** 四段的颜色。键与 `StatsBarDatum` 的四个计数字段一一对应。 */
export type StatsBarColors = Record<"live" | "dyn" | "sc" | "guard", string>;

/** 由高到低堆叠 —— 上舰在最上,直播在最下。 */
const STATS_BAR_SEGMENTS = ["guard", "sc", "dyn", "live"] as const;

/**
 * 迷你堆叠柱状图。
 *
 * **`colors` 必填,库里不留默认值。** 这四段是推送家族色,而家族色的唯一出处
 * (`push-kinds.ts`)是业务侧的东西,平台中立的库取不到 —— 于是「就地抄一份」曾经是
 * 这儿最省事的写法,四个值也就真在这里躺了一整轮:调色板改了它不动,而守卫当时只扫
 * 站点源码,连这个目录都没看过。给个默认值等于把那份副本原样留下,所以不给。
 */
export function StatsBar({
	data,
	colors,
	height = 80,
}: {
	data: StatsBarDatum[];
	colors: StatsBarColors;
	height?: number;
}) {
	const max = Math.max(1, ...data.map((d) => d.live + d.dyn + d.sc + d.guard));
	return (
		<div className="relative flex items-end gap-2.5 pb-4.5" style={{ height }}>
			{data.map((d) => {
				const total = d.live + d.dyn + d.sc + d.guard;
				const h = (total / max) * (height - 18);
				return (
					<div key={d.d} className="relative flex flex-1 flex-col items-center gap-1">
						<div
							className="flex w-full flex-col justify-end overflow-hidden rounded-t"
							style={{ height: h }}
						>
							{STATS_BAR_SEGMENTS.map((seg) =>
								d[seg] > 0 ? (
									<div
										key={seg}
										style={{ background: colors[seg], height: `${(d[seg] / total) * 100}%` }}
									/>
								) : null,
							)}
						</div>
						<div className="absolute bottom-0 text-bn-2xs text-bn-text-secondary">{d.d}</div>
					</div>
				);
			})}
		</div>
	);
}

// ── Section / Row (used by drawer + dashboard panels) ─────────────────────

export function Section({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<div className="mb-2 text-bn-xs font-bold uppercase tracking-wider text-bn-text-secondary">
				{label}
			</div>
			<div className="rounded-lg border border-bn-border bg-bn-surface-muted/80">{children}</div>
		</div>
	);
}

export function Row({
	label,
	sub,
	icon,
	children,
}: {
	label: string;
	sub?: string;
	icon?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2.5 border-b border-bn-border-subtle px-3 py-2.5 last:border-b-0">
			{icon ? <span className="shrink-0">{icon}</span> : null}
			<div className="min-w-0 flex-1">
				<div className="text-bn-sm font-semibold text-bn-text-primary">{label}</div>
				{sub ? <div className="mt-0.5 text-bn-xs text-bn-text-secondary">{sub}</div> : null}
			</div>
			{children}
		</div>
	);
}
