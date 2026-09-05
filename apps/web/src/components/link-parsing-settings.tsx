/**
 * 系统页的「链接解析」卡片 —— 群里贴 B 站视频链接自动回一张卡。
 *
 * 控件各自直接 patch 草稿(与其他系统设置一样走灵动岛保存)。这功能默认关:开着就
 * 意味着同群任何人都能让机器人出图,所以开关必须是主人自己按下去的。
 *
 * 「在哪些群、回什么」是一张表:**默认行**(所有群解不解析、回图片卡还是小程序卡)+
 * **按群例外**(从推送目标里列出的群,每格三态:跟默认 / 显式值)。「所有群」不是一种
 * 模式,它就是默认行;想「只在某几群解析」就把默认解析关掉、给那几群显式开。例外只存
 * 显式写了的字段 —— 「跟默认」发的是删除哨兵(null),不是把默认值抄一份进例外,否则
 * 主人改默认行那天这群不跟着动。停用的目标照列照配、标「已停用」(与周报「发送到」同一条
 * 规矩:停用是暂停不是消失),运行时不解析。
 */

import type { AdapterCapabilitiesMap, MiniAppCardSupport } from "@bilibili-notify/contract";
import {
	INBOUND_CAPABLE_PLATFORMS,
	LINK_REPLY_FORMS,
	type LinkReplyForm,
} from "@bilibili-notify/internal/constants";
import {
	EmptyNote,
	GlassBox,
	HintNote,
	Icon,
	Picker,
	Pill,
	PlatformIcon,
	Row,
	Section,
	StatusDot,
	TNum,
	Toggle,
} from "@bilibili-notify/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { SECTION_ACCENT } from "../config/section-accents";
import type { PushAdapter, PushTarget } from "../types/domain";
import type { GlobalConfig, GlobalConfigPatch } from "../types/globals";
import { Field } from "./forms";

type LinkParsing = GlobalConfig["linkParsing"];

export const LINK_REPLY_FORM_LABELS: Record<LinkReplyForm, string> = {
	image: "图片卡",
	miniapp: "小程序卡",
};

/** 三态格的取值:跟默认,或一个显式值。 */
const INHERIT = "inherit" as const;

/** 能列进例外表的目标:群类,且平台收得到入站消息(webhook 只出不进,配了也没用)。 */
function isGroupCandidate(t: PushTarget): boolean {
	return (
		t.scope === "group" && (INBOUND_CAPABLE_PLATFORMS as readonly string[]).includes(t.platform)
	);
}

/** 面板上「未探测」那一档;引擎还没起来、或表里根本没这条时都是它。 */
const NOT_PROBED: MiniAppCardSupport = { state: "unknown" };

export function LinkParsingSettings({
	draft,
	onPatch,
	targets,
	adapters,
	capabilities,
}: {
	draft: GlobalConfig;
	onPatch: (delta: GlobalConfigPatch) => void;
	/** 推送目标表(由页面取数),这里只挑群类的列出来。 */
	targets: readonly PushTarget[];
	/** 适配器表(由页面取数),面板只列 OneBot 的。 */
	adapters: readonly PushAdapter[];
	/** `GET /api/adapters/capabilities`:各适配器能不能签小程序卡。 */
	capabilities: AdapterCapabilitiesMap;
}) {
	const cfg = draft.linkParsing;
	const candidates = targets.filter(isGroupCandidate);
	// 两格都调回「跟默认」时草稿里留下的是个空对象(删除哨兵把字段删掉,不删这一格),
	// 它已经不是例外了 —— 数键会让卡上多出一条根本不存在的例外,直到存盘重拉才消失。
	const overrides = Object.values(cfg.groups).filter(
		(g) => g?.parse !== undefined || g?.form !== undefined,
	).length;
	// 逐群表默认收起:群一多整张表直接把卡撑爆,先给一行摘要,要改再展开。
	const [groupsOpen, setGroupsOpen] = useState(false);

	const badge = !cfg.enabled
		? "已关闭"
		: [
				`冷却 ${cfg.cooldownSeconds} 秒`,
				cfg.defaults.parse ? null : "仅例外群",
				overrides > 0 ? `${overrides} 个例外` : null,
			]
				.filter(Boolean)
				.join(" · ");

	return (
		<GlassBox
			title="Core · 链接解析"
			subtitle="群里贴 B 站视频链接,自动回一张视频卡 · globals.linkParsing"
			accent={SECTION_ACCENT.system}
			icon={<Icon.link size={14} />}
			badge={badge}
		>
			<Field code="linkParsing.enabled">
				<Toggle
					value={cfg.enabled}
					onChange={(v) => onPatch({ linkParsing: { enabled: v } })}
					ariaLabel="链接解析总开关"
				/>
			</Field>

			<Field code="linkParsing.cooldownSeconds">
				<TNum
					value={cfg.cooldownSeconds}
					onChange={(v) => onPatch({ linkParsing: { cooldownSeconds: v } })}
					min={0}
					max={3600}
					suffix="秒"
				/>
			</Field>

			<Field code="linkParsing.defaults" full>
				<fieldset
					aria-label="默认(所有群)"
					className="m-0 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 border-0 p-0"
				>
					<Cell label="解析">
						<Picker
							value={cfg.defaults.parse}
							onChange={(parse) => onPatch({ linkParsing: { defaults: { parse } } })}
							options={[
								{ value: true, label: "开", color: SECTION_ACCENT.system },
								{ value: false, label: "关", color: SECTION_ACCENT.system },
							]}
						/>
					</Cell>
					<Cell label="形式">
						<Picker
							value={cfg.defaults.form}
							onChange={(form) => onPatch({ linkParsing: { defaults: { form } } })}
							options={LINK_REPLY_FORMS.map((f) => ({
								value: f,
								label: LINK_REPLY_FORM_LABELS[f],
								color: SECTION_ACCENT.system,
							}))}
						/>
					</Cell>
				</fieldset>
			</Field>

			<Field code="linkParsing.groups" full>
				{candidates.length === 0 ? (
					<EmptyNote size="sm" className="w-full">
						还没有群类推送目标,先去
						<Link to="/targets" className="mx-0.5 font-semibold text-bn-pink">
							推送目标
						</Link>
						页添加一个群;不是推送目标的群一律跟默认行
					</EmptyNote>
				) : (
					<div className="flex flex-col">
						<div className="flex items-center gap-2 text-bn-xs text-bn-text-secondary">
							<span>
								{candidates.length} 个群 · {overrides} 个例外
							</span>
							{/* 展开钮借 Pill 的形制(与历史页的展开行同一套):aria-expanded 说明它是开合,不是选项。 */}
							<button
								type="button"
								aria-expanded={groupsOpen}
								data-bn={groupsOpen ? "chip chip-active" : "chip"}
								onClick={() => setGroupsOpen((v) => !v)}
								className="rounded-md transition hover:opacity-80"
							>
								<Pill color={SECTION_ACCENT.system} subtle size="sm">
									{groupsOpen ? "收起" : "展开"}
								</Pill>
							</button>
						</div>
						{groupsOpen
							? candidates.map((t) => (
									<GroupRow
										key={t.id}
										target={t}
										cfg={cfg}
										onPatch={onPatch}
										support={capabilities[t.adapterId]?.miniAppCard}
									/>
								))
							: null}
					</div>
				)}
			</Field>

			<CapabilityPanel adapters={adapters} capabilities={capabilities} />
		</GlassBox>
	);
}

/** 三态在面板上怎么说。 */
function supportText(s: MiniAppCardSupport): { dot: "ok" | "off" | "pending"; text: string } {
	switch (s.state) {
		case "supported":
			return { dot: "ok", text: "支持小程序卡" };
		case "unsupported":
			return { dot: "off", text: "不支持,回落图片卡" };
		default:
			return { dot: "pending", text: "未探测" };
	}
}

/**
 * 「适配器支持情况」:每个 OneBot 适配器一行,三态 支持 / 不支持(带原因)/ 未探测。只列
 * OneBot —— 官机与 webhook 没有能力概念,一句话说清。探测是连上时自动做的,主人在推送
 * 目标页点「测试」也会补探「未探测」的。
 */
function CapabilityPanel({
	adapters,
	capabilities,
}: {
	adapters: readonly PushAdapter[];
	capabilities: AdapterCapabilitiesMap;
}) {
	const onebots = adapters.filter((a) => a.platform === "onebot");
	return (
		<section aria-label="适配器支持情况" className="mt-4">
			<Section label="适配器支持情况">
				{onebots.length === 0 ? (
					<EmptyNote size="sm" className="m-2">
						还没有 OneBot 适配器;小程序卡只有 OneBot 实现能签
					</EmptyNote>
				) : (
					onebots.map((a) => {
						const support = capabilities[a.id]?.miniAppCard ?? NOT_PROBED;
						const { dot, text } = supportText(support);
						return (
							<Row
								key={a.id}
								label={a.name}
								sub={support.state === "supported" ? undefined : support.reason}
								icon={<PlatformIcon platform={a.platform} size={14} />}
							>
								<span className="flex shrink-0 items-center gap-1.5 text-bn-xs text-bn-text-secondary">
									<StatusDot kind={dot} size="sm" />
									{text}
								</span>
							</Row>
						);
					})
				)}
			</Section>
			<HintNote className="mt-2">
				QQ 官方机器人与 webhook 不支持小程序卡,那些目标一律回图片卡。OneBot 实现要有
				get_mini_app_ark 接口(目前已知 NapCat 支持),连上时自动探测
			</HintNote>
		</section>
	);
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span className="text-bn-xs text-bn-text-secondary">{label}</span>
			{children}
		</div>
	);
}

/**
 * 例外表的一行:目标名 + 两个三态格。格里「跟默认」那一档把继承来的值写在旁边 —— 主人
 * 一眼看到这群现在实际是什么,不用回头看默认行。
 */
function GroupRow({
	target,
	cfg,
	onPatch,
	support,
}: {
	target: PushTarget;
	cfg: LinkParsing;
	onPatch: (delta: GlobalConfigPatch) => void;
	/** 这群所在适配器能不能签小程序卡;没有能力概念的平台(官机)是 undefined。 */
	support: MiniAppCardSupport | undefined;
}) {
	const o = cfg.groups[target.id];
	// 草稿里被 patch 成 null 的字段(刚点过「跟默认」)与没写一样,都是跟默认。
	const parse = o?.parse ?? undefined;
	const form = o?.form ?? undefined;
	const setParse = (v: boolean | typeof INHERIT) =>
		onPatch({ linkParsing: { groups: { [target.id]: { parse: v === INHERIT ? null : v } } } });
	const setForm = (v: LinkReplyForm | typeof INHERIT) =>
		onPatch({ linkParsing: { groups: { [target.id]: { form: v === INHERIT ? null : v } } } });
	return (
		<fieldset
			aria-label={target.name}
			className="m-0 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 border-0 border-bn-border-subtle border-b p-0 py-2 last:border-b-0"
		>
			<div className="flex min-w-40 items-center gap-1.5 text-bn-sm text-bn-text-primary">
				<PlatformIcon platform={target.platform} size={13} />
				<span className="font-semibold">{target.name}</span>
				{target.enabled ? null : (
					<Pill size="sm" subtle color="var(--color-bn-inactive)">
						已停用
					</Pill>
				)}
			</div>
			<Cell label="解析">
				<Picker<boolean | typeof INHERIT>
					value={parse ?? INHERIT}
					onChange={setParse}
					options={[
						{ value: INHERIT, label: `跟默认 · ${cfg.defaults.parse ? "开" : "关"}` },
						{ value: true, label: "开", color: SECTION_ACCENT.system },
						{ value: false, label: "关", color: SECTION_ACCENT.system },
					]}
				/>
			</Cell>
			<Cell label="形式">
				<Picker<LinkReplyForm | typeof INHERIT>
					value={form ?? INHERIT}
					onChange={setForm}
					options={[
						{ value: INHERIT, label: `跟默认 · ${LINK_REPLY_FORM_LABELS[cfg.defaults.form]}` },
						...LINK_REPLY_FORMS.map((f) => ({
							value: f,
							label: LINK_REPLY_FORM_LABELS[f],
							color: SECTION_ACCENT.system,
						})),
					]}
				/>
			</Cell>
			{target.platform === "qq-official" ? (
				<HintNote className="basis-full">QQ 官方机器人不支持小程序卡,选了也会回落图片卡</HintNote>
			) : support?.state === "unsupported" ? (
				<HintNote className="basis-full">该适配器不支持小程序卡,选了也会回落图片卡</HintNote>
			) : null}
		</fieldset>
	);
}
