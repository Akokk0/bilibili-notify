import { targetDisplay } from "../components/target-display";
/**
 * Cards page — image plugin card preview. Ports `GlassPreviewTab` from
 * `.bn-design/variation-ac.jsx`.
 *
 * A scope switcher (全局默认 / 各 UP) sits on top. Three columns: a left rail
 * (SectionNav) = 全局 + the four card kinds. On the 全局 tab the middle column holds the
 * skin library and its knobs and the right column shows a four-card 全家福; to see
 * one kind you open its tab. On a kind tab the middle column holds the live cover
 * gallery (live only) and 测试推送 + preview-content form, and the right column is
 * the single live puppeteer preview. 设置只剩出图总开关与直播封面(㉔e):全局绑
 * `GlobalSettings.defaults.cards`,per-UP 绑该订阅的 `overrides.cards`(只有直播封面),
 * 由「覆盖全局」开关控制。
 *
 * 排版归卡片皮肤(ADR-0014):「全局」tab 上的皮肤库是整套外观的入口,per-UP 挑一套
 * (`overrides.cardSkin`)并可单独拧那套的旋钮(`overrides.cardSkinKnobs`,决策 17 的 🔗)。
 * 旧的一维版式编辑器连同它的配置字段已随决策 15 整个退役 ——
 * 面板里现在搜不到它,那个键只剩服务端一次性迁移时读一遍。
 */

import type { PreviewResponse, TestPushResponse } from "@bilibili-notify/contract";
import { CARD_KIND_EVENT_NAMES } from "@bilibili-notify/internal/card-skin";
import { buildPatch } from "@bilibili-notify/internal/patch";
import {
	Btn,
	ConfirmDialog,
	EmptyNote,
	GlassBox,
	HintNote,
	Icon,
	type IconName,
	LoadingBlock,
	Pill,
	SectionNav,
	Toggle,
} from "@bilibili-notify/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChromeAutoDetect } from "../components/chrome-autodetect";
import { Field, Picker, TArea, TInput, TNum, TSelect } from "../components/forms";
import { HeroStrip } from "../components/hero-strip";
import { InheritNote } from "../components/inherit-note";
import { type Scope, ScopeTabs } from "../components/scope-tabs";
import { type MembershipProgram, membershipTiersOf } from "../config/membership-programs";
import { PUSH_TONE } from "../config/push-features";
import { SECTION_ACCENT } from "../config/section-accents";
import { useDirtyDraft } from "../hooks/useDirtyDraft";
import { patchCoreSettings, SETTINGS_KEY, useCoreSettings } from "../hooks/useSettings";
import { useSources } from "../hooks/useSources";
import { useT, useTextOptions } from "../i18n";
import { ApiError, api } from "../services/api";
import {
	type Connection,
	type PushTarget,
	type Subscription,
	subscriptionIdentityOf,
} from "../types/domain";
import type { CardsSettings } from "../types/globals";
import { walkTreeDiff } from "../utils/walkTreeDiff";
import { CardSkinKnobsSection } from "./cards/CardSkinKnobs";
import { CardSkinPicker, CardSkinSection } from "./cards/CardSkinSection";
import { GalleryPicker } from "./cards/GalleryPicker";
import { removeFromGallery } from "./cards/gallery-ops";
import type { CardSkinKnobsBySkin } from "./cards/knob-ops";
import { previewErrorHint, previewErrorTitle } from "./cards/preview-error";
import { enqueuePreview, PREVIEW_TIMEOUT_MS } from "./cards/preview-queue";
import { displayName } from "./subscriptions/helpers";
import { subscriptionPlatformOf } from "./subscriptions/subscription-source";

/** 本页能预览的四种卡(卡种键与全仓同一套,没有页面自己的缩写)。 */
type PreviewKind = "live" | "post" | "superchat" | "membership";

/** 预览与测试推送请求里的样式:只有直播封面(字体与玻璃归皮肤的旋钮)。 */
interface PreviewStyle {
	liveCoverImageIds: string[];
}

interface PreviewContent {
	/**
	 * 全局作用域「从订阅里挑一条」挑中的那条订阅(真数据问它的来源要);空串 = 不挑,画示例。
	 * 按订阅作用域用的是正在改的那一条,不读它。
	 */
	subscriptionId: string;
	/** `nth`:作品卡取最近的第几条(1 = 最新那条);挑了订阅才有用。 */
	post: { nth: number };
	/** 金额、配色档位、展示时长互相独立，只用于示例。 */
	superchat: { text: string; amount: number; rank: number; durationSec: number };
	/** `program`:会员体系 id;`tierKey`:那一档在这个体系里的 key。两个一起随预览请求体发给服务端。 */
	membership: { program: string; text: string; tierKey: string };
}

/** 上舰预览能选的档,由低到高(会员体系的档位表本身的顺序);默认选最低一档。 */
const DEFAULT_PREVIEW_CONTENT: PreviewContent = {
	subscriptionId: "",
	post: { nth: 1 },
	// 留言默认空:服务端画示例留言(一句话只在服务端字典里存一份)。
	superchat: { text: "", amount: 30, rank: 1, durationSec: 60 },
	// membership.text 默认空:挑了订阅时服务端取那个来源登录着的账号名,没挑或没登录才是示例名。
	membership: { program: "", text: "", tierKey: "" },
};

/**
 * 按卡种拼预览 / 测试推送请求的 `content`:挑了订阅就带上它的 id(作品再带第几条),醒目留言 / 上舰另带示例消息。
 * 没挑订阅时作品与直播一格都不带 —— 服务端画示例。
 */
function previewContentOf(
	kind: PreviewKind,
	content: PreviewContent,
	subscriptionId: string | undefined,
): Record<string, unknown> {
	const picked = subscriptionId ? { subscriptionId } : {};
	if (kind === "live") return picked;
	if (kind === "post") return subscriptionId ? { subscriptionId, nth: content.post.nth } : {};
	return { ...content[kind], ...picked };
}

const KIND_META: Record<PreviewKind, { tone: string; icon: IconName }> = {
	live: { tone: PUSH_TONE.live, icon: "live" },
	post: { tone: PUSH_TONE.post, icon: "dyn" },
	superchat: { tone: PUSH_TONE.superchat, icon: "sc" },
	membership: {
		tone: PUSH_TONE.membership,
		icon: "guard",
	},
};

/** 交给取字口当名字占位的记号:取回整句后在它那里切开,名字画成元素。 */
const NAME_MARK = "\u0000";

/**
 * 字典里的一整句,把 `{name}` 那一格画成加粗的元素 —— 译文里那一格放在哪都行,句子不拆成前后两截去翻。
 * `text` 是 `t(键, { name: NAME_MARK })` 取回的那句。
 */
function EmphasizedName({
	text,
	name,
	className,
}: {
	text: string;
	name: React.ReactNode;
	className: string;
}) {
	const [before = "", after = ""] = text.split(NAME_MARK);
	return (
		<>
			{before}
			<b className={className}>{name}</b>
			{after}
		</>
	);
}

function PreviewImage({
	kind,
	style,
	content,
	cardSkin,
	cardSkinKnobs,
	frame = true,
}: {
	kind: PreviewKind;
	style: PreviewStyle;
	/** 已按 kind 选好的内容载荷(`previewContentOf`):挑了订阅带它的 id,醒目留言 / 上舰带示例消息。 */
	content: Record<string, unknown>;
	/**
	 * 这张卡用哪套皮肤。**不传 = 全局在用的那套**(服务端那边就是这么解释的);只有
	 * per-UP 单独指了一套时才填,否则「单独指定」的选择器与预览里的卡对不上。
	 */
	cardSkin?: string;
	/**
	 * per-UP 那侧的**草稿**旋钮(按皮肤 id 分,ADR-0014 决策 17 的 🔗)。全局作用域不传 ——
	 * 全局那份是存完再看的,服务端自己从配置里读;per-UP 传草稿,拧一格预览当场变。
	 */
	cardSkinKnobs?: CardSkinKnobsBySkin;
	/** 带边框大容器(单卡预览)。false = 裸图缩放填满父格(全家福格子复用)。 */
	frame?: boolean;
}) {
	const t = useT();
	const { locale, voice } = useTextOptions();
	// 把整份请求(kind/style/content/cardSkin)合成一个 spec 做**单一**防抖。
	// 关键:kind 不能直接进 queryKey 而其余走独立防抖 —— 否则切类型时
	// kind 立刻变、content 防抖没追上,会先用「上一个类型残留的内容」白发一次请求
	// (per-UP 下还会真去拉一次接口),一次操作打两条日志、跑两次 puppeteer。整体防抖
	// 后一次变更只触发一次 refetch。TArea / 图廊等控件的高频 onChange 同样收敛。
	const spec = useMemo(
		() => ({ kind, style, content, cardSkin, cardSkinKnobs }),
		[kind, style, content, cardSkin, cardSkinKnobs],
	);
	const [debouncedSpec, setDebouncedSpec] = useState(spec);
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSpec(spec), 500);
		return () => clearTimeout(timer);
	}, [spec]);

	const query = useQuery({
		queryKey: ["card-preview", debouncedSpec, locale, voice],
		// 经串行队列 —— 全家福一屏四张卡,四个请求一起打出去的话,后三个只是挂在服务端
		// 渲染闸门口空等(服务端本来就串行,见 runtime/serial-gate.ts)。等在浏览器这边
		// 总耗时一样,但每条连接的存活时间只剩自己那张卡的渲染时间,不会被反代的读超时
		// 连坐掐断。详见 cards/preview-queue.ts。
		queryFn: () =>
			enqueuePreview(async () => {
				// 带死线:队伍是串行的,一个永不落地的请求会让后面几张卡连发都发不出去。
				const res = await api.post<PreviewResponse>("/api/cards/preview", debouncedSpec, {
					timeoutMs: PREVIEW_TIMEOUT_MS,
				});
				// 画不出来是 200 + 失败那一支(`Result`):请求没毛病、这一趟没成。造成 `ApiError`
				// 是为了让下面按 `code` / `message` 读的地方与非 2xx(如 `not_configured`)走同一条路。
				if (!res.ok) throw new ApiError(200, res, res.message);
				// 挑了订阅却画成示例(来源没交出真数据):原因随图一起带回来,不吞(4-14 主人定)。
				return { dataUrl: res.dataUrl, sampleReason: res.sampleReason };
			}),
		retry: false,
	});

	const showSkeleton = query.isPending;
	const apiErr = query.error as ApiError | undefined;

	const body = showSkeleton ? (
		/* `inset` + 自带外壳:这块占的是预览图的位置,底与宽度要跟着预览框走,
		   `card` 变体那层玻璃会和外面的预览区叠成玻璃叠玻璃。 */
		<LoadingBlock
			label={t("cards.preview.rendering")}
			variant="inset"
			className="w-full max-w-95 rounded-bn-card bg-bn-surface/70"
		/>
	) : query.error ? (
		<div className="w-full max-w-95 rounded-xl bg-bn-surface p-4 text-bn-sm">
			<div className="mb-1 font-bold text-bn-danger-text">{previewErrorTitle(apiErr)}</div>
			<div className="text-bn-text-secondary">
				{apiErr?.message ?? t("cards.preview.unknownError")}
			</div>
			{previewErrorHint(apiErr?.status) ? (
				<div className="mt-2 text-bn-xs text-bn-text-tertiary">
					{previewErrorHint(apiErr?.status)}
				</div>
			) : null}
			{/* 没配浏览器(`not_configured`)才摆「一键检测并启用 Chrome」;引擎还没就绪是
			    `unavailable`,等一会儿就好,摆了也没用。从前按状态码 503 认,两件事分不开。 */}
			{apiErr?.code === "not_configured" ? (
				<ChromeAutoDetect onEnabled={() => query.refetch()} />
			) : null}
		</div>
	) : (
		<img
			src={query.data?.dataUrl}
			srcSet={`${query.data?.dataUrl} 2x`}
			alt={t("cards.preview.imageAlt")}
			className={
				frame
					? "bn-anim-fade-in max-w-full rounded-xl shadow-[0_6px_20px_rgba(0,0,0,0.14)]"
					: "bn-anim-fade-in max-h-full max-w-full rounded-lg object-contain shadow-[0_4px_14px_rgba(0,0,0,0.12)]"
			}
		/>
	);

	const sampleReason = query.data?.sampleReason;
	const reasonLine = sampleReason ? (
		<div className="mt-2 text-center text-bn-xs text-bn-text-tertiary">
			{t("cards.preview.sampleBecause", { reason: sampleReason })}
		</div>
	) : null;
	// 全家福格子复用裸图模式:不套大边框,缩放填满父格(父格定高 + overflow-hidden)。
	if (!frame) {
		return (
			<div className="flex h-full w-full flex-col items-center justify-center">
				{body}
				{reasonLine}
			</div>
		);
	}
	return (
		<div className="relative flex min-h-105 flex-col items-center justify-center rounded-bn-card border border-bn-border p-7">
			{body}
			{reasonLine}
		</div>
	);
}

/**
 * 预览内容 + 测试推送(合并卡)—— 上半编辑该类型的预览内容(全局可改 mock,per-UP 用真实
 * 数据),下半把当前预览卡片(草稿样式 + 皮肤 + 类型 + 内容)渲染成图片推给所选 PushTarget。
 * 所见即所推:用的是当前预览正在调的草稿,无需先保存。
 */
function TestPushCard({
	programs,
	membershipAvailable,
	kind,
	style,
	pushContent,
	cardSkin,
	cardSkinKnobs,
	mockContent,
	setMockContent,
	realData,
	realDataLabel,
	subscriptions,
}: {
	kind: PreviewKind;
	style: PreviewStyle;
	/** 已解析的预览/推送内容载荷(`previewContentOf`,与预览同一份)。 */
	pushContent: Record<string, unknown>;
	programs: readonly MembershipProgram[];
	membershipAvailable: boolean;
	/** 与预览同一份(`previewSkin` / `previewKnobs`):全局作用域不传,per-UP 传这位 UP 的皮肤与草稿旋钮。 */
	cardSkin?: string;
	cardSkinKnobs?: CardSkinKnobsBySkin;
	/** 可编辑的 mock 内容状态(供上半内容编辑)。 */
	mockContent: PreviewContent;
	setMockContent: React.Dispatch<React.SetStateAction<PreviewContent>>;
	realData?: boolean;
	realDataLabel?: string;
	/** 全局作用域「从订阅里挑一条」的候选。 */
	subscriptions: readonly Subscription[];
}) {
	const t = useT();
	const connectionsQuery = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<Connection[]>("/api/connections"),
	});
	const targetsQuery = useQuery({
		queryKey: ["targets"],
		queryFn: () => api.get<PushTarget[]>("/api/targets"),
	});
	const targets = useMemo(
		() => (targetsQuery.data ?? []).filter((target) => target.enabled),
		[targetsQuery.data],
	);
	const [targetId, setTargetId] = useState("");
	useEffect(() => {
		// 目标列表到位后默认选第一个;所选目标被删 / 停用则回退到第一个。
		const first = targets[0];
		if (first && !targets.some((target) => target.id === targetId)) setTargetId(first.id);
	}, [targets, targetId]);

	const push = useMutation({
		mutationFn: async (submitted: {
			targetId: string;
			kind: PreviewKind;
			style: PreviewStyle;
			content: Record<string, unknown>;
			cardSkin?: string;
			cardSkinKnobs?: CardSkinKnobsBySkin;
		}) => {
			// 同 PreviewImage 的过渡注释:版式已归皮肤,这一轮一个字也不传 layout。
			const res = await api.post<TestPushResponse>("/api/cards/test", submitted);
			// 没送达是 200 + 失败那一支,`message` 就是对端的原话。
			if (!res.ok) throw new ApiError(200, res, res.message);
			return res;
		},
	});

	return (
		<GlassBox
			title={t("cards.testPush.title")}
			subtitle={t("cards.testPush.subtitle")}
			accent={SECTION_ACCENT.capability}
			icon={<Icon.bell size={14} />}
			badge="test"
		>
			<PreviewContentFields
				programs={programs}
				kind={kind}
				content={mockContent}
				setContent={setMockContent}
				realData={realData}
				realDataLabel={realDataLabel}
				subscriptions={subscriptions}
			/>
			<div className="my-3 border-t border-bn-border-subtle" />
			<Field code="targetId" full>
				<TSelect
					full
					value={targetId}
					onChange={setTargetId}
					disabled={targets.length === 0}
					options={
						targets.length === 0
							? [{ value: "", label: t("cards.testPush.noTargets") }]
							: targets.map((target) => targetDisplay(target, connectionsQuery.data ?? []))
					}
				/>
			</Field>
			<div className="pt-2.5">
				<Btn
					variant="primary"
					size="sm"
					full
					onClick={() =>
						push.mutate({ targetId, kind, style, content: pushContent, cardSkin, cardSkinKnobs })
					}
					disabled={push.isPending || !targetId || (kind === "membership" && !membershipAvailable)}
				>
					{push.isPending ? t("cards.testPush.pushing") : t("cards.testPush.button")}
				</Btn>
				{push.isError ? (
					<div className="mt-2 text-bn-xs text-bn-danger-text">
						{t("cards.testPush.failed", {
							reason: (push.error as ApiError)?.message ?? t("cards.preview.unknownError"),
						})}
					</div>
				) : push.isSuccess ? (
					<div className="mt-2 text-bn-xs text-bn-success-text">
						{t("cards.testPush.delivered", { ms: push.data.latencyMs })}
						{push.data.sampleReason ? (
							<div className="text-bn-text-tertiary">
								{t("cards.testPush.sampleBecause", { reason: push.data.sampleReason })}
							</div>
						) : null}
					</div>
				) : null}
			</div>
		</GlassBox>
	);
}

// 背景图选择改用图廊多选组件 GalleryPicker(支持上传 / 删盘 / 轮换序);缩略图 hook
// 抽到 ./cards/useAssetObjectUrl 与之共享。

/**
 * per-UP 直播封面:对该 UP 单独选封面图(替换 B 站房间封面/关键帧)。存进 `overrides.cards.liveCoverImageIds`。
 * 未覆盖时跟随全局封面;开关打开把全局那份抄过来当起点,关掉 = 去掉这条覆盖(保存时 `cards` 整个清成 null)。
 * 打开后把列表挑空是**另一回事**:空列表是「这位 UP 不用自定义封面(回 B 站封面)」,要显式存成 `[]`。
 */
export function PerUpCoverSection({
	base,
	value,
	onChange,
	onAssetDeleted,
}: {
	/** 继承值来源:全局的封面列表。 */
	base: string[];
	/** 这位 UP 的封面覆盖;`undefined` = 没覆盖、跟随全局。 */
	value: string[] | undefined;
	/** 写回覆盖(`undefined` = 去掉覆盖、跟随全局)。 */
	onChange: (next: string[] | undefined) => void;
	/** 封面图删盘回调,透传给 GalleryPicker(Cards 页借它清扫其他草稿)。 */
	onAssetDeleted?: (id: string) => void;
}) {
	const t = useT();
	const active = value !== undefined;
	const toggleOverride = (on: boolean) => {
		onChange(on ? [...base] : undefined);
	};
	return (
		<GlassBox
			title={t("cards.cover.title")}
			subtitle={t("cards.cover.perSubSubtitle")}
			accent={KIND_META.live.tone}
			icon={<Icon.live size={14} />}
			badge={active ? t("cards.cover.badgeOwn") : t("cards.cover.badgeInherit")}
			right={<Toggle value={active} onChange={toggleOverride} />}
		>
			{active ? (
				<Field code="liveCoverImageIds" full>
					<GalleryPicker
						value={value ?? []}
						onChange={(next) => onChange(next)}
						onAssetDeleted={onAssetDeleted}
						emptyHint={t("cards.cover.emptyHint")}
						singleHint={t("cards.cover.singleHint")}
					/>
				</Field>
			) : (
				<InheritNote>
					{base.length > 0
						? t("cards.cover.inheritCount", { count: base.length })
						: t("cards.cover.inheritNone")}
				</InheritNote>
			)}
		</GlassBox>
	);
}

/**
 * 「这条预览用的是真实数据」的绿色说明条。四个 kind 分支各自写了一遍,连
 * `realDataLabel` 缺省时的那句兜底也抄了两份;局部收编后又与 FontPicker /
 * SubscriptionDialog 的旁注各配各的圆角 —— 观感统一升进了库的 {@link HintNote},这里
 * 只剩「这条旁注是报喜档」这层领域语义。
 */
function RealDataNote({ children }: { children: React.ReactNode }) {
	return <HintNote tone="success">{children}</HintNote>;
}

/** 「这一档的某些样式不归你管」的中性说明条 —— SC 与上舰各一条。 */
function KindHintNote({ children }: { children: React.ReactNode }) {
	return <HintNote>{children}</HintNote>;
}

/**
 * 「预览内容」框 —— 卡片类型切换 + 各类型的 mock/真实内容字段。与作用域无关
 * (预览的是哪类卡片、用什么内容,跟改谁的样式独立)。
 */
function PreviewContentFields({
	programs,
	kind,
	content,
	setContent,
	realData = false,
	realDataLabel,
	subscriptions,
}: {
	kind: PreviewKind;
	programs: readonly MembershipProgram[];
	content: PreviewContent;
	setContent: React.Dispatch<React.SetStateAction<PreviewContent>>;
	/** per-UP 作用域:仅类型选择,不提供 mock 内容编辑(用该 UP 真实数据)。 */
	realData?: boolean;
	realDataLabel?: string;
	/** 全局作用域「从订阅里挑一条」的候选。 */
	subscriptions: readonly Subscription[];
}) {
	const t = useT();
	const sourceEntries = useSources().data?.sources;
	const setPost = (next: Partial<PreviewContent["post"]>) =>
		setContent((c) => ({ ...c, post: { ...c.post, ...next } }));
	const setSuperchat = (next: Partial<PreviewContent["superchat"]>) =>
		setContent((c) => ({ ...c, superchat: { ...c.superchat, ...next } }));
	const setMembership = (next: Partial<PreviewContent["membership"]>) =>
		setContent((c) => ({ ...c, membership: { ...c.membership, ...next } }));

	return (
		<>
			{kind === "membership" ? (
				<>
					<Field code="program" label={t("cards.content.program")}>
						<TSelect
							value={content.membership.program}
							onChange={(program) =>
								setMembership({
									program,
									tierKey: membershipTiersOf(programs, program)[0]?.key ?? "",
								})
							}
							options={programs.map((program) => ({ value: program.id, label: program.name }))}
						/>
					</Field>
					<Field code="tierKey">
						<TSelect
							value={content.membership.tierKey}
							onChange={(tierKey) => setMembership({ tierKey })}
							options={membershipTiersOf(programs, content.membership.program).map((tier) => ({
								value: tier.key,
								label: tier.name,
							}))}
						/>
					</Field>
				</>
			) : null}
			{/* 卡片类型由左侧「卡片类型」导航选择;此处只显示当前类型的内容字段。 */}
			{realData ? (
				kind === "post" ? (
					// per-UP 作品:仍用这条订阅的真实作品,但可选渲染「第几条」。
					<>
						<Field code="nth">
							<TInput
								value={String(content.post.nth)}
								onChange={(v) => {
									const n = Number.parseInt(v, 10);
									setPost({ nth: Number.isFinite(n) && n > 0 ? n : 1 });
								}}
								placeholder="1"
							/>
						</Field>
						<RealDataNote>{realDataLabel ?? t("cards.preview.realDataNote")}</RealDataNote>
					</>
				) : (
					<RealDataNote>
						{kind === "live"
							? (realDataLabel ?? t("cards.preview.realDataNote"))
							: t("cards.preview.messageNote")}
					</RealDataNote>
				)
			) : kind === "live" || kind === "post" ? (
				// 全局:从订阅里挑一条(可不挑)。挑了且它的来源能出真实预览,就画真数据;不挑画示例。
				<>
					<Field code="subscriptionId">
						<TSelect
							value={content.subscriptionId}
							onChange={(subscriptionId) => setContent((c) => ({ ...c, subscriptionId }))}
							options={[
								{ value: "", label: t("cards.preview.noSubscription") },
								...subscriptions.map((sub) => ({
									value: sub.id,
									label: displayName(sub, subscriptionPlatformOf(sub.identity, sourceEntries)),
								})),
							]}
						/>
					</Field>
					{kind === "post" && content.subscriptionId ? (
						<Field code="nth">
							<TInput
								value={String(content.post.nth)}
								onChange={(v) => {
									const n = Number.parseInt(v, 10);
									setPost({ nth: Number.isFinite(n) && n > 0 ? n : 1 });
								}}
								placeholder="1"
							/>
						</Field>
					) : null}
				</>
			) : kind === "superchat" ? (
				<>
					<Field code="text" full>
						<TArea
							value={content.superchat.text}
							onChange={(v) => setSuperchat({ text: v })}
							placeholder={t("cards.content.superchatPlaceholder")}
							rows={3}
						/>
					</Field>
					<Field
						code="amount"
						label={t("cards.content.superchatAmount")}
						hint={t("cards.content.superchatAmountHint")}
						full
					>
						<TInput
							value={String(content.superchat.amount)}
							onChange={(v) => {
								const n = Number.parseInt(v, 10);
								setSuperchat({ amount: Number.isFinite(n) && n > 0 ? n : 30 });
							}}
							placeholder="30"
						/>
					</Field>
					<Field code="rank" label={t("cards.content.superchatRank")} full>
						<Picker
							value={content.superchat.rank}
							onChange={(rank) => setSuperchat({ rank })}
							options={[1, 2, 3, 4, 5, 6].map((rank) => ({ value: rank, label: String(rank) }))}
						/>
					</Field>
					<Field code="durationSec" label={t("cards.content.superchatDuration")} full>
						<TNum
							value={content.superchat.durationSec}
							onChange={(durationSec) =>
								setSuperchat({ durationSec: Math.max(0, Math.floor(durationSec)) })
							}
							min={0}
							ariaLabel={t("cards.content.superchatDuration")}
						/>
					</Field>
					<KindHintNote>{t("cards.content.superchatHint")}</KindHintNote>
				</>
			) : (
				<>
					<Field
						label={t("cards.content.memberNameLabel")}
						code="text"
						hint={t("cards.content.memberNameHint")}
					>
						<TArea
							value={content.membership.text}
							onChange={(v) => setMembership({ text: v })}
							placeholder={t("cards.content.memberNamePlaceholder")}
							rows={2}
						/>
					</Field>
					<KindHintNote>{t("cards.content.membershipHint")}</KindHintNote>
				</>
			)}
		</>
	);
}

/** 预览列的头行:左粗标题 + 右小字说明 —— 全家福与单卡两分支此前各抄一份。 */
function PreviewHead({ title, note }: { title: React.ReactNode; note: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between text-bn-base text-bn-text-primary">
			<span className="font-bold">{title}</span>
			<span className="text-bn-xs font-normal text-bn-text-secondary">{note}</span>
		</div>
	);
}

/** 该 UP 是否单独设了直播封面(`overrides.cards.liveCoverImageIds`;空列表也算 —— 那是「不用自定义封面」)。 */
function hasCoverOverride(sub: Subscription): boolean {
	return sub.overrides.cards?.liveCoverImageIds !== undefined;
}
/** 该 UP 单独拧过皮肤旋钮没有(非空才算;按皮肤 id 分层,哪一套拧过都算)。 */
function hasCardSkinKnobs(sub: Subscription): boolean {
	const k = sub.overrides.cardSkinKnobs;
	return k !== undefined && Object.keys(k).length > 0;
}
/** 该 sub 已覆盖的卡片切片数(0..3),供 ScopeTabs 计数徽章。 */
function cardOverrideCount(sub: Subscription): number {
	return (
		(hasCoverOverride(sub) ? 1 : 0) +
		(sub.overrides.cardSkin ? 1 : 0) +
		(hasCardSkinKnobs(sub) ? 1 : 0)
	);
}
function hasCardCustomization(sub: Subscription): boolean {
	return hasCoverOverride(sub) || sub.overrides.cardSkin !== undefined || hasCardSkinKnobs(sub);
}

export default function Cards() {
	const qc = useQueryClient();
	const globalsQuery = useCoreSettings();
	const subsQuery = useQuery({
		queryKey: ["subscriptions"],
		queryFn: () => api.get<Subscription[]>("/api/subscriptions"),
	});

	const [scope, setScope] = useState<Scope>("__global");
	// 客户端临时添加(还没设覆盖)的 sub.id;刷新即清空。
	const [addedSubIds, setAddedSubIds] = useState<Set<string>>(new Set());
	const [pendingRemoval, setPendingRemoval] = useState<Subscription | null>(null);

	// 全局草稿:出图总开关 + 直播封面
	const [gCards, setGCards] = useState<CardsSettings | null>(null);
	// 皮肤旋钮的覆盖,按皮肤 id 分层(ADR-0014 决策 16 的 🔗)。全局那一份,不分卡种;
	// 每位 UP 自己那层见下面的 `puKnobs`。
	const [gSkinKnobs, setGSkinKnobs] = useState<CardSkinKnobsBySkin>({});

	// per-UP 直播封面覆盖草稿(undefined = 继承全局;空数组 = 这位 UP 不用自定义封面)。
	const [puCover, setPuCover] = useState<string[] | undefined>(undefined);
	// 该 UP 单独指定的卡片皮肤;undefined = 跟随全局(保存时把这个键整个清掉)。
	const [puSkin, setPuSkin] = useState<string | undefined>(undefined);
	// 该 UP 单独拧过的皮肤旋钮,按皮肤 id 分层(ADR-0014 决策 17 的 🔗)。空 = 全跟全局。
	const [puKnobs, setPuKnobs] = useState<CardSkinKnobsBySkin>({});

	// 删盘后清扫页面上所有仍引用该 id 的封面草稿(全局 / per-UP)。picker 自身的 onChange 只清
	// 它绑定的那一个;另一份草稿若攥着这个 id 不放,下次保存就落盘成悬空引用(封面是幽灵占轮换位)。
	// 服务端 409 只拦「已保存配置」里的引用,未保存草稿只能靠这里。
	const sweepDeletedAsset = (id: string) => {
		setGCards((c) =>
			c ? { ...c, liveCoverImageIds: removeFromGallery(c.liveCoverImageIds, id) } : c,
		);
		setPuCover((ids) => (ids ? removeFromGallery(ids, id) : ids));
	};

	// 左侧导航:「全局」(基准通用样式)或某卡片类型。与作用域无关。
	const t = useT();
	const sourceEntries = useSources().data?.sources;
	const [activeTab, setActiveTab] = useState<"__global" | PreviewKind>("__global");
	const [content, setContent] = useState<PreviewContent>(DEFAULT_PREVIEW_CONTENT);

	const isGlobalTab = activeTab === "__global";
	// 类型 tab 锁定为该类型;全局 tab 右侧铺四张卡(无单一类型),kind 仅占位。
	const kind: PreviewKind = isGlobalTab ? "live" : activeTab;

	// 按订阅覆盖卡片皮肤与旋钮对所有订阅开放(ADR-0021 决策 12):真数据由各自的来源出,来源没有真实预览就画示例。
	const allSubs = useMemo(() => subsQuery.data ?? [], [subsQuery.data]);
	const isGlobalScope = scope === "__global";
	const focusedSub = isGlobalScope ? undefined : allSubs.find((s) => s.id === scope);

	useEffect(() => {
		if (globalsQuery.data) {
			setGCards(globalsQuery.data.defaults.cards);
			setGSkinKnobs(globalsQuery.data.defaults.cardSkinKnobs ?? {});
		}
	}, [globalsQuery.data]);

	// 选中 UP 的存储覆盖 → 编辑草稿。
	const seededPuCover = focusedSub?.overrides.cards?.liveCoverImageIds;
	const seededPuSkin = focusedSub?.overrides.cardSkin;
	const seededPuKnobs = useMemo<CardSkinKnobsBySkin>(
		() => focusedSub?.overrides.cardSkinKnobs ?? {},
		[focusedSub?.overrides.cardSkinKnobs],
	);

	// 切换到不同 UP(或其服务端数据变化)→ 重新 seed 覆盖草稿。
	useEffect(() => {
		setPuCover(seededPuCover);
		setPuSkin(seededPuSkin);
		setPuKnobs(seededPuKnobs);
	}, [seededPuCover, seededPuSkin, seededPuKnobs]);

	// 选中的 UP 从订阅列表消失 → 回退全局。
	useEffect(() => {
		if (!isGlobalScope && subsQuery.data && !allSubs.some((s) => s.id === scope)) {
			setScope("__global");
		}
	}, [isGlobalScope, scope, subsQuery.data, allSubs]);

	const saveGlobal = useMutation({
		mutationFn: async (payload: { cards: CardsSettings; cardSkinKnobs: CardSkinKnobsBySkin }) => {
			// 只挑本页真正编辑的 scope 做 diff —— 下发全量会让服务端的 enable-check
			// 每次保存都跑一遍 puppeteer 启动 + chat.completions 探针。草稿里消失的键
			// 由 buildPatch 自动变成显式 null,不必再逐个记着手写。
			const base = globalsQuery.data;
			await patchCoreSettings(
				buildPatch(
					{
						defaults: {
							cards: payload.cards,
							// 「还原」一枚旋钮是把键删掉,而删除只有走 buildPatch 的 diff 才发得出去
							// (草稿里没了 + 基线里有 → 显式 null)。手写 payload 的话那个键只是
							// 「不出现」= 服务端读作「别动」,于是还原永远不生效。
							cardSkinKnobs: payload.cardSkinKnobs,
						},
					},
					{
						defaults: {
							cards: base?.defaults.cards,
							cardSkinKnobs: base?.defaults.cardSkinKnobs ?? {},
						},
					},
				),
			);
			// 旋钮变没变要在这儿算:这是**保存前**那份基线,onSuccess 里 globals 已经在重取了。
			return {
				knobsChanged:
					walkTreeDiff(base?.defaults.cardSkinKnobs ?? {}, payload.cardSkinKnobs).length > 0,
			};
		},
		onSuccess: (res) => {
			void qc.invalidateQueries({ queryKey: SETTINGS_KEY });
			// 旋钮**不进预览 spec** —— 服务端出图时自己从 globals 里读那一层。于是拧完保存,
			// `["card-preview", spec]` 这个 key 一个字都没变,react-query 端出来的还是保存前
			// 那张图,看着就是「拧了没反应」。别的卡片设置没这个毛病:它们本来就在 spec 里,
			// 编辑当场就重画了。按需作废 —— 无条件作废等于每次保存白跑一遍 puppeteer。
			if (res.knobsChanged) void qc.invalidateQueries({ queryKey: ["card-preview"] });
		},
	});

	// per-UP 保存:只下发卡片那几片(缺席键 = 不改其它 slice;null = 清除)。
	const savePerUp = useMutation({
		mutationFn: async (sub: Subscription) => {
			await api.patch<Subscription>(`/api/subscriptions/${sub.id}`, {
				overrides: {
					// 封面覆盖:有(含空列表)→ 存 `{ liveCoverImageIds }`,与该 UP 服务端当前值做 diff
					// (整列表替换);没有 = 「跟随全局」→ 显式 null 把 `cards` 整个清掉(undefined 在 JSON 里
					// 表达不出来,键消失只会被读作「不改」,清不掉)。
					cards:
						puCover !== undefined
							? buildPatch({ liveCoverImageIds: puCover }, sub.overrides.cards ?? {})
							: null,
					// 「跟随全局」= 把这个键清掉。同上,必须落成显式 null 才是删除哨兵。
					cardSkin: puSkin ?? null,
					// 旋钮:一枚都不剩 → 整份 null(不留空壳);还有 → 与服务端当前值做 diff,「还原」掉的
					// 那一枚由 buildPatch 变成显式 null(键消失 = 不改,还原就永远不生效)。
					cardSkinKnobs:
						Object.keys(puKnobs).length > 0
							? buildPatch(puKnobs, sub.overrides.cardSkinKnobs ?? {})
							: null,
				},
			});
		},
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	const removeCardCustomization = useMutation({
		mutationFn: async (sub: Subscription) =>
			api.patch<Subscription>(`/api/subscriptions/${sub.id}`, {
				overrides: { cards: null, cardSkin: null, cardSkinKnobs: null },
			}),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }),
	});

	// Tab 栏:已有卡片覆盖 / 本轮客户端添加的 sub。
	const tabSubs = useMemo(
		() => allSubs.filter((s) => hasCardCustomization(s) || addedSubIds.has(s.id)),
		[allSubs, addedSubIds],
	);
	const availableSubs = useMemo(() => {
		const taken = new Set(tabSubs.map((s) => s.id));
		return allSubs.filter((s) => !taken.has(s.id));
	}, [allSubs, tabSubs]);

	function handleAddSub(id: string): void {
		setAddedSubIds((set) => {
			const next = new Set(set);
			next.add(id);
			return next;
		});
		setScope(id);
	}
	function detachSub(id: string): void {
		setAddedSubIds((set) => {
			const next = new Set(set);
			next.delete(id);
			return next;
		});
		if (scope === id) setScope("__global");
	}
	function handleRemoveSub(id: string): void {
		const sub = allSubs.find((s) => s.id === id);
		if (sub && hasCardCustomization(sub)) {
			setPendingRemoval(sub);
			return;
		}
		detachSub(id);
	}
	function confirmRemoveSub(): void {
		if (!pendingRemoval) return;
		removeCardCustomization.mutate(pendingRemoval);
		detachSub(pendingRemoval.id);
		setPendingRemoval(null);
	}

	// 灵动岛:单一 hook 按作用域切换,杜绝双挂载抢单槽竞态。
	//
	// 全局那份**不含** cardSkin:换全局皮肤是皮肤库里点一下就生效(PUT /active 直改
	// globals),不是草稿 —— 塞进来只会让灵动岛拿一个永远不脏的键去 diff。
	const globalIslandDraft = useMemo(() => {
		if (gCards === null) return null;
		return { ...gCards, cardSkinKnobs: gSkinKnobs };
	}, [gCards, gSkinKnobs]);
	const globalIslandBaseline = useMemo(() => {
		if (!globalsQuery.data) return null;
		return {
			...globalsQuery.data.defaults.cards,
			cardSkinKnobs: globalsQuery.data.defaults.cardSkinKnobs ?? {},
		};
	}, [globalsQuery.data]);
	const perUpIslandDraft = useMemo(
		() => ({
			liveCoverImageIds: puCover ?? null,
			cardSkin: puSkin ?? null,
			cardSkinKnobs: puKnobs,
		}),
		[puCover, puSkin, puKnobs],
	);
	const perUpIslandBaseline = useMemo(
		() => ({
			liveCoverImageIds: seededPuCover ?? null,
			cardSkin: seededPuSkin ?? null,
			cardSkinKnobs: seededPuKnobs,
		}),
		[seededPuCover, seededPuSkin, seededPuKnobs],
	);

	// 预览内容:全局 = 挑的那条订阅(可不挑)+ 可编辑的示例消息;per-UP = 正在改的这条订阅。真数据由服务端问那条订阅的
	// 来源要,取不到就画示例并说原因。useMemo 稳定引用 —— 否则每次 render 新建对象会不断重置 PreviewImage 的防抖定时器。
	const previewSubscriptionId = isGlobalScope
		? content.subscriptionId || undefined
		: focusedSub?.id;
	const previewSub = allSubs.find((sub) => sub.id === previewSubscriptionId);
	const membershipSources = previewSub
		? sourceEntries?.filter((source) => source.key === previewSub.identity.sourceKey)
		: sourceEntries;
	const membershipPrograms =
		membershipSources?.flatMap((source) => source.descriptor.membershipPrograms ?? []) ?? [];
	const firstPreviewableProgram = membershipSources
		?.filter((source) => source.status === "running")
		.flatMap((source) => source.descriptor.membershipPrograms ?? [])
		.find((program) => Array.isArray(program.tiers) && program.tiers.length > 0);
	const selectedProgram =
		membershipPrograms.find((program) => program.id === content.membership.program) ??
		firstPreviewableProgram ??
		membershipPrograms[0];
	const membershipTiers = selectedProgram
		? membershipTiersOf(membershipPrograms, selectedProgram.id)
		: [];
	const selectedTier =
		membershipTiers.find((tier) => tier.key === content.membership.tierKey) ?? membershipTiers[0];
	const membershipAvailable = Boolean(
		selectedProgram &&
			selectedTier &&
			membershipSources?.some(
				(source) =>
					source.status === "running" &&
					source.descriptor.membershipPrograms?.some(
						(program) => program.id === selectedProgram.id,
					),
			),
	);
	const resolvedContent = useMemo(
		() => ({
			...content,
			membership: {
				...content.membership,
				program: selectedProgram?.id ?? "",
				tierKey: selectedTier?.key ?? "",
			},
		}),
		[content, selectedProgram?.id, selectedTier?.key],
	);
	const previewContent = useMemo(
		() => previewContentOf(kind, resolvedContent, previewSubscriptionId),
		[kind, resolvedContent, previewSubscriptionId],
	);

	useDirtyDraft({
		pageKey: isGlobalScope ? "cards" : "cards-perup",
		pageLabel: isGlobalScope
			? t("cards.page.label")
			: t("cards.page.perSubLabel", {
					name: focusedSub
						? displayName(focusedSub, subscriptionPlatformOf(focusedSub.identity, sourceEntries))
						: "",
				}),
		draft: isGlobalScope ? globalIslandDraft : perUpIslandDraft,
		baseline: isGlobalScope ? globalIslandBaseline : perUpIslandBaseline,
		onSave: async () => {
			if (isGlobalScope) {
				if (gCards !== null) {
					await saveGlobal.mutateAsync({ cards: gCards, cardSkinKnobs: gSkinKnobs });
				}
			} else if (focusedSub) {
				await savePerUp.mutateAsync(focusedSub);
			}
		},
		onDiscard: () => {
			if (isGlobalScope) {
				if (!globalsQuery.data) return;
				setGCards(globalsQuery.data.defaults.cards);
				setGSkinKnobs(globalsQuery.data.defaults.cardSkinKnobs ?? {});
			} else {
				setPuCover(seededPuCover);
				setPuSkin(seededPuSkin);
				setPuKnobs(seededPuKnobs);
			}
		},
	});

	if (!gCards) {
		return <LoadingBlock label={t("cards.page.loading")} />;
	}

	// 预览请求带的样式:全局 = 全局封面;per-UP = 这位 UP 的封面覆盖(有就用,没有跟随全局)。
	// 与服务端出图的取法是同一条(订阅的 ?? 全局的),预览才是所见即所推。
	const effStyle: PreviewStyle = {
		liveCoverImageIds: isGlobalScope
			? gCards.liveCoverImageIds
			: (puCover ?? gCards.liveCoverImageIds),
	};
	// 全局 tab:右侧四张卡「全家福」,逐类型用同一份生效样式 + 各自内容渲染。
	const familyPreviews = (["live", "post", "superchat", "membership"] as const)
		.filter((fk) => fk !== "membership" || membershipAvailable)
		.map((fk) => ({
			fk,
			style: effStyle,
			content: previewContentOf(fk, resolvedContent, previewSubscriptionId),
		}));

	/**
	 * 预览要用哪套皮肤。全局作用域**一个字都不传** —— 「不指皮肤 = 全局在用的那套」
	 * 是服务端那一处的解释,面板再抄一份就是第二个缺省,迟早分家。per-UP 传的是**草稿**
	 * 那个值(`puSkin`),这样选择器里刚点的那套立刻就能在预览里看到,不必先保存。
	 */
	const previewSkin = isGlobalScope ? undefined : puSkin;
	/** 同上:per-UP 那侧的草稿旋钮;全局作用域不传,没拧过也不传(请求体与从前一字不差)。 */
	const previewKnobs = isGlobalScope || Object.keys(puKnobs).length === 0 ? undefined : puKnobs;
	/** 左侧类型导航的副标题(对齐 Rules 左栏的「label + desc」观感)。 */
	const kindDesc: Record<PreviewKind, string> = {
		live: t("cards.kind.liveDesc"),
		post: t("cards.kind.postDesc"),
		superchat: t("cards.kind.superchatDesc"),
		membership: t("cards.kind.membershipDesc"),
	};
	const scopeName = isGlobalScope ? t("cards.preview.scopeGlobal") : t("cards.preview.scopeSub");

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			{/* Hero strip — 全局插件信息 + (仅全局作用域)总开关 */}
			<HeroStrip
				icon={<Icon.eye size={26} />}
				title={
					<>
						{t("cards.hero.title")}
						<Pill color="var(--color-bn-purple)" subtle size="sm">
							image
						</Pill>
					</>
				}
				subtitle={t("cards.hero.subtitle")}
				right={
					isGlobalScope ? (
						<Picker
							value={gCards.enabled}
							onChange={(v) => setGCards((d) => (d ? { ...d, enabled: v } : d))}
							options={[
								{ value: true, label: t("cards.hero.enable"), color: "var(--color-bn-purple)" },
								{ value: false, label: t("cards.hero.disable"), color: "var(--color-bn-inactive)" },
							]}
						/>
					) : (
						<span className="rounded-md border border-bn-border-subtle bg-bn-surface/70 px-2.5 py-1 text-bn-xs text-bn-text-tertiary">
							{t("cards.hero.switchInGlobal")}
						</span>
					)
				}
			/>

			{/* 作用域切换 */}
			<ScopeTabs
				platformOf={(identity) => subscriptionPlatformOf(identity, sourceEntries)}
				scope={scope}
				onChange={setScope}
				tabSubs={tabSubs}
				availableSubs={availableSubs}
				onAddSub={handleAddSub}
				onRemoveSub={handleRemoveSub}
				overridesCountFor={cardOverrideCount}
				globalHint={t("cards.scope.globalHint")}
				perUpHint={(sub) =>
					sub ? (
						<EmphasizedName
							text={t("cards.scope.perSubHint", { name: NAME_MARK })}
							name={subscriptionIdentityOf(sub).externalId}
							className="text-bn-pink"
						/>
					) : null
				}
			/>

			{/* 中间那栏 440 而不是 380(2026-09-19 主人:「又被挤占了」):旋钮那节的标签列吃掉
			    160px,剩给控件的才是真正要摆字体选择器、图廊、滑杆的地方 —— 380 时它只有 180,
			    上传按钮与它旁边那句说明挤成一团。预览那栏是 1fr 且卡片按 object-contain 缩放,
			    让出这 60px 只是卡片画小一点。 */}
			<div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[220px_440px_minmax(0,1fr)]">
				{/* RAIL: 全局基准 + 各卡片类型 —— 选中决定编辑的样式 + 预览的卡片种类 */}
				<SectionNav
					heading={t("cards.page.label")}
					items={[
						{
							id: "__global",
							label: t("cards.nav.global"),
							desc: t("cards.nav.globalDesc"),
							icon: <Icon.edit size={15} />,
						},
						...(["live", "post", "superchat", "membership"] as const).map((k) => {
							const Ic = Icon[KIND_META[k].icon];
							return {
								id: k,
								label: CARD_KIND_EVENT_NAMES[k],
								desc: kindDesc[k],
								icon: <Ic size={15} />,
							};
						}),
					]}
					activeId={activeTab}
					onPick={(id) => setActiveTab(id === "__global" ? "__global" : (id as PreviewKind))}
				/>

				{/* LEFT: style config */}
				<div className="flex flex-col gap-3">
					{/* 字体与背景图 2026-09-14 退役成**皮肤自己的旋钮**(主人拍板);㉔e 又把「按卡种单独
					    样式」那一层整个撤了(它只剩直播封面一个用途)。这一栏只剩直播封面一个盒子。 */}
					{!isGlobalTab && kind !== "live" ? (
						<EmptyNote>{t("cards.skin.byCardHint")}</EmptyNote>
					) : null}

					{/* 卡片皮肤 —— 仅「全局」tab。皮肤是**整套外观**(七种卡一起换),不分卡种,
					    所以它不该出现在类型 tab 上;旧的「卡片版式」一节正是按卡种各一份,
					    那一节连同它的数据模型一起退役了(ADR-0014 决策 15 / 20)。 */}
					{isGlobalTab &&
						(isGlobalScope ? (
							<>
								<CardSkinSection />
								{/* 全局那份旋钮(按皮肤 id 分层、不分卡种),拧的是全局在用的那套。 */}
								<CardSkinKnobsSection value={gSkinKnobs} onChange={setGSkinKnobs} />
							</>
						) : (
							<>
								<GlassBox
									title={t("cards.skin.perSubTitle")}
									subtitle={t("cards.skin.perSubSubtitle")}
									accent="var(--color-bn-purple)"
									icon={<Icon.palette size={14} />}
									badge={puSkin ? t("cards.skin.badgeOwn") : t("cards.skin.badgeInherit")}
								>
									<CardSkinPicker value={puSkin} onChange={setPuSkin} />
								</GlassBox>
								{/* 这位 UP 实际用的那套(单独指了就是它,否则全局那套)的旋钮,ADR-0014 决策 17
								    的 🔗。「跟随全局」的起始位置取**已保存**的全局那份 —— per-UP 预览在服务端
								    也是与它合并,两边对得上。 */}
								<CardSkinKnobsSection
									value={puKnobs}
									onChange={setPuKnobs}
									perUp={{
										inherit: globalsQuery.data?.defaults.cardSkinKnobs ?? {},
										skinId: puSkin,
									}}
								/>
							</>
						))}

					{/* 直播封面 —— 仅「直播开播」tab。全局作用域改 `defaults.cards.liveCoverImageIds`
					    (推送链路的全局默认封面即读它);per-UP 单独覆盖走 `overrides.cards.liveCoverImageIds`。 */}
					{!isGlobalTab &&
						kind === "live" &&
						(isGlobalScope ? (
							<GlassBox
								title={t("cards.cover.title")}
								subtitle={t("cards.cover.globalSubtitle")}
								accent={KIND_META.live.tone}
								icon={<Icon.live size={14} />}
								badge="liveCover"
							>
								<Field code="liveCoverImageIds" full>
									<GalleryPicker
										value={gCards.liveCoverImageIds}
										onChange={(next) => setGCards({ ...gCards, liveCoverImageIds: next })}
										onAssetDeleted={sweepDeletedAsset}
										emptyHint={t("cards.cover.emptyHint")}
										singleHint={t("cards.cover.singleHint")}
									/>
								</Field>
							</GlassBox>
						) : (
							<PerUpCoverSection
								base={gCards.liveCoverImageIds}
								value={puCover}
								onChange={setPuCover}
								onAssetDeleted={sweepDeletedAsset}
							/>
						))}

					{/* 测试推送 + 预览内容编辑 —— 仅「类型」tab(全局只看四卡全家福,不带测试推送)。 */}
					{!isGlobalTab && (
						<TestPushCard
							programs={membershipPrograms}
							membershipAvailable={membershipAvailable}
							kind={kind}
							style={effStyle}
							pushContent={previewContent}
							cardSkin={previewSkin}
							cardSkinKnobs={previewKnobs}
							mockContent={resolvedContent}
							setMockContent={setContent}
							realData={!isGlobalScope}
							realDataLabel={
								focusedSub
									? t("cards.preview.realDataNoteOf", {
											name: displayName(
												focusedSub,
												subscriptionPlatformOf(focusedSub.identity, sourceEntries),
											),
										})
									: undefined
							}
							subscriptions={allSubs}
						/>
					)}
				</div>

				{/* PREVIEW: 全局 tab = 四卡全家福;类型 tab = 单卡 */}
				<div className="@container/card-previews flex flex-col gap-2.5">
					{isGlobalTab ? (
						<>
							<PreviewHead
								title={t("cards.preview.familyTitle", { scope: scopeName })}
								note={t("cards.preview.familyNote")}
							/>
							{/* 预览列够宽时保留固定高度的2×2布局；窄列改为单列自然增高，
							    避免错误说明和浏览器设置表单被挤进半张卡或裁掉。 */}
							<div className="flex h-auto flex-col rounded-bn-card border border-bn-border p-4 @min-[480px]/card-previews:h-180">
								<div className="grid min-h-0 flex-1 grid-cols-1 gap-3 @min-[480px]/card-previews:grid-cols-2 @min-[480px]/card-previews:grid-rows-2">
									{!membershipAvailable ? (
										<EmptyNote size="sm">{t("cards.preview.membershipUnavailable")}</EmptyNote>
									) : null}
									{familyPreviews.map(({ fk, style, content: fcontent }) => {
										const FkIcon = Icon[KIND_META[fk].icon];
										return (
											<div key={fk} className="flex min-h-0 flex-col gap-1">
												<div className="flex items-center gap-1 text-bn-xs font-bold text-bn-text-tertiary">
													<FkIcon size={11} />
													{CARD_KIND_EVENT_NAMES[fk]}
												</div>
												<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
													<PreviewImage
														kind={fk}
														style={style}
														content={fcontent}
														cardSkin={previewSkin}
														cardSkinKnobs={previewKnobs}
														frame={false}
													/>
												</div>
											</div>
										);
									})}
								</div>
							</div>
							<div className="rounded-md border border-bn-border-subtle bg-bn-surface/60 px-3 py-2 text-bn-xs italic text-bn-text-secondary">
								{isGlobalScope
									? t("cards.preview.familyGlobalHint")
									: focusedSub
										? t("cards.preview.familySubHint", {
												name: displayName(
													focusedSub,
													subscriptionPlatformOf(focusedSub.identity, sourceEntries),
												),
											})
										: ""}
							</div>
						</>
					) : (
						<>
							<PreviewHead
								title={t("cards.preview.singleTitle", { scope: scopeName })}
								note={t("cards.preview.renderWidth", {
									width: kind === "superchat" ? 280 : kind === "membership" ? 430 : 600,
								})}
							/>
							{kind === "membership" && !membershipAvailable ? (
								<EmptyNote>{t("cards.preview.membershipUnavailable")}</EmptyNote>
							) : (
								<PreviewImage
									kind={kind}
									style={effStyle}
									content={previewContent}
									cardSkin={previewSkin}
									cardSkinKnobs={previewKnobs}
								/>
							)}

							{/* 生效封面读数 */}
							<div className="flex flex-wrap gap-3.5 rounded-md border border-bn-border-subtle bg-bn-surface/60 px-3 py-2 font-mono text-bn-2xs text-bn-text-tertiary">
								{kind === "live" ? (
									<span>
										liveCoverImageIds:{" "}
										<b className="text-bn-text-primary">{effStyle.liveCoverImageIds.length}</b>
									</span>
								) : null}
								<span className="italic text-bn-text-secondary">
									{isGlobalScope
										? t("cards.preview.globalFooter")
										: focusedSub
											? t("cards.preview.subFooter", {
													name: displayName(
														focusedSub,
														subscriptionPlatformOf(focusedSub.identity, sourceEntries),
													),
												})
											: ""}
								</span>
							</div>
						</>
					)}
				</div>
			</div>

			{pendingRemoval ? (
				<ConfirmDialog
					title={t("cards.remove.title")}
					message={
						<EmphasizedName
							text={t("cards.remove.message", { name: NAME_MARK })}
							name={displayName(
								pendingRemoval,
								subscriptionPlatformOf(pendingRemoval.identity, sourceEntries),
							)}
							className="text-bn-text-primary"
						/>
					}
					confirmLabel={t("cards.remove.confirm")}
					cancelLabel={t("cards.remove.cancel")}
					danger
					onConfirm={confirmRemoveSub}
					onCancel={() => setPendingRemoval(null)}
				/>
			) : null}
		</div>
	);
}
