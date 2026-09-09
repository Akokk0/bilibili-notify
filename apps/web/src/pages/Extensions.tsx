import type {
	ExtensionDTO,
	ExtensionProvides,
	ExtensionShadowDTO,
	ExtensionsResponse,
} from "@bilibili-notify/contract";
import { EXTENSION_ROOT_LABEL } from "@bilibili-notify/contract";
import {
	EmptyNote,
	ErrorNote,
	GlassPanel,
	HintNote,
	LoadingBlock,
	Pill,
	StatusDot,
	Toggle,
	WarnNote,
} from "@bilibili-notify/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../services/api";
import { ExtensionsEmpty } from "./extensions/empty-state";
import {
	ExtensionIcon,
	ExtensionRootLine,
	extensionAccent,
	useExtensionToggle,
} from "./extensions/shared";
import { EXTENSION_STATE_META } from "./extensions/state-meta";

/**
 * `/extensions` —— 装了哪些拓展、开没开、跑没跑起来。
 *
 * **卡片上的每一个字都来自服务端**(`GET /api/ext` → 拓展自己的清单):前端再抄一份的话,
 * 装进来一个我们没见过的拓展,它的卡片就是个灰方章。同理这一页**没有写死的拓展名单** ——
 * 盘上有什么就是什么。
 *
 * 开关不在这儿开专门的端点:它住 `globals.extensions.<id>.enabled`,与别的全局设置走
 * 同一条 `PATCH /api/globals`(ADR-0012)。
 */

/**
 * 拓展只开两口(ADR-0012),这一页就按这两口分节。
 *
 * **分组不是排版口味**:主人来这一页多半是为了某一口(「我想让抖音也能订阅」),而卡片
 * 上那颗 `provides` 药丸说不清它会出现在哪。空的那一口也留着 —— 那句「还没有」正是
 * 「这口存在、只是还没人接」的唯一说法。
 */
const SECTIONS: ReadonlyArray<{
	code: ExtensionProvides;
	label: string;
	hint: string;
	empty: string;
}> = [
	{
		code: "push",
		label: "推送源",
		hint: "接进「推送目标」",
		empty: "还没有推送源拓展 —— 现在能推的只有直连的那些目标。",
	},
	{
		code: "subscription",
		label: "订阅源",
		hint: "接进「订阅 UP 主」",
		empty: "还没有订阅源拓展 —— BN 现在只看 B 站。",
	},
];

/** 它开的是哪一口 —— 清单里的机器词,印给人看要换句话。 */
function providesLabel(code: string): string {
	return SECTIONS.find((section) => section.code === code)?.label ?? code;
}

function StateLine({ ext }: { ext: ExtensionDTO }) {
	const meta = EXTENSION_STATE_META[ext.state];
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
			<span className="flex items-center gap-1.5 text-bn-sm text-bn-text-secondary">
				<StatusDot kind={meta.dot} />
				{meta.label}
			</span>
			{ext.version ? (
				<span className="font-mono text-bn-xs text-bn-text-tertiary">v{ext.version}</span>
			) : null}
			{(ext.provides ?? []).map((provide) => (
				<Pill key={provide} subtle color="var(--color-bn-pink)">
					{providesLabel(provide)}
				</Pill>
			))}
		</div>
	);
}

/**
 * 「为什么没跑起来」。分红黄两档不是口味:清单坏了 / 加载炸了要主人去动手,而连败自动
 * 停用与版本不合是「换一版就好」,同一个红盒会让前者被当成后者放着不管。
 */
function StateDetail({ ext }: { ext: ExtensionDTO }) {
	if (!ext.detail) return null;
	const { severity } = EXTENSION_STATE_META[ext.state];
	if (severity === "err") return <ErrorNote size="sm">{ext.detail}</ErrorNote>;
	if (severity === "warn") return <WarnNote size="sm">{ext.detail}</WarnNote>;
	return null;
}

function ExtensionCard({
	ext,
	onToggle,
}: {
	ext: ExtensionDTO;
	onToggle: (enabled: boolean) => void;
}) {
	return (
		<GlassPanel
			title={ext.name}
			subtitle={ext.description}
			// 没有图标的那张连方块一起转灰 —— 灰是「关于它我们只知道这么多」,
			// 而不是某个拓展被挑出来上了另一种色。
			accent={extensionAccent(ext)}
			icon={<ExtensionIcon svg={ext.icon} />}
			right={<Toggle ariaLabel={ext.name} value={ext.enabled} onChange={(on) => onToggle(on)} />}
		>
			<div className="flex flex-col gap-2">
				<StateLine ext={ext} />
				<StateDetail ext={ext} />
				<ExtensionRootLine ext={ext} />
				{/* 详情页那块是拓展自己交上来的面板数据 —— 没有入口的话只能手敲地址。 */}
				<Link
					to={`/extensions/${ext.id}`}
					className="self-start text-bn-xs text-bn-text-tertiary hover:text-bn-pink"
				>
					详情 →
				</Link>
			</div>
		</GlassPanel>
	);
}

/** 一节的标题行:小标题 + 一条发丝线 + 右边那句「它接到哪儿去」。 */
function SectionHead({ label, hint }: { label: string; hint: string }) {
	return (
		<div className="flex items-center gap-2">
			<b className="text-bn-xs font-bold tracking-wide text-bn-text-tertiary">{label}</b>
			<span className="h-px flex-1 bg-bn-border" />
			<span className="text-bn-xs text-bn-text-tertiary">{hint}</span>
		</div>
	);
}

/**
 * 🔴 同一个 id 在两个根里都有。
 *
 * 悄悄盖掉正是「我明明改了怎么没生效」最难查的原因 —— 盘上两份、这一页只有一行,
 * 不把两份的位置都摆出来,没有任何办法判断跑的是哪个。
 */
function ShadowWarning({ shadow }: { shadow: ExtensionShadowDTO }) {
	return (
		<WarnNote size="sm">
			<strong>{shadow.id} 有两份</strong>:跑的是
			{EXTENSION_ROOT_LABEL[shadow.winner.kind]}那份(
			<span className="font-mono">{shadow.winner.dir}</span>),盖住了
			{EXTENSION_ROOT_LABEL[shadow.shadowed.kind]}的(
			<span className="font-mono">{shadow.shadowed.dir}</span>)。
		</WarnNote>
	);
}

export default function Extensions() {
	const listed = useQuery({
		queryKey: ["extensions"],
		queryFn: () => api.get<ExtensionsResponse>("/api/ext"),
	});
	const toggle = useExtensionToggle();

	if (listed.isPending) return <LoadingBlock label="正在读取拓展" />;

	const extensions = listed.data?.extensions ?? [];
	const shadowed = listed.data?.shadowed ?? [];
	// 归不了口的那些(清单读不出来 / 版本不合 → 没有 provides)。它们**不许消失**:
	// 消失的东西没法排查,而这一页正是主人来看「它怎么了」的地方。
	const homeless = extensions.filter((ext) => (ext.provides ?? []).length === 0);

	const card = (ext: ExtensionDTO) => (
		<ExtensionCard
			key={ext.id}
			ext={ext}
			onToggle={(enabled) => toggle.mutate({ id: ext.id, enabled })}
		/>
	);

	return (
		<div className="bn-anim-page-in flex flex-col gap-4">
			<div>
				<div className="text-bn-xl font-bold text-bn-text-primary">拓展</div>
				<div className="mt-0.5 text-bn-xs text-bn-text-secondary">
					装进来的东西,不编在主程序里 ——{" "}
					<strong className="text-bn-text-primary">本体一个拓展都不带</strong>。
				</div>
			</div>

			{shadowed.map((shadow) => (
				<ShadowWarning key={shadow.id} shadow={shadow} />
			))}

			{extensions.length === 0 ? (
				<ExtensionsEmpty />
			) : (
				<>
					{/*
					 * ⚠️ 这句话是**必须**的,不是装饰:开关热、代码不热(ADR-0012 决策 10)。
					 * 两半都要说 —— 只说前半,主人换完代码会以为拨一下开关就够;只说后半,
					 * 他会为一次停用去重启整个进程,还顺手把别的推送一起停了。
					 *
					 * 一个拓展都没装时**不说**:那一屏要讲的是「怎么装」,开关的脾气还轮不到。
					 */}
					<HintNote>
						拓展是装进来的,不编在主程序里。拨动开关
						<strong className="text-bn-text-secondary">立刻生效</strong>:关掉当场收摊
						(正连着的插件会被断开,配置全留),打开就地装起来。装进来一个新拓展、
						或者换掉一份拓展的代码,才要重启一次 —— 已经加载的代码在进程里换不掉。
					</HintNote>

					{SECTIONS.map((section) => {
						const mine = extensions.filter((ext) => (ext.provides ?? []).includes(section.code));
						return (
							<div key={section.code} className="flex flex-col gap-2.5">
								<SectionHead label={section.label} hint={section.hint} />
								{mine.length === 0 ? (
									<EmptyNote size="sm">{section.empty}</EmptyNote>
								) : (
									<div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
										{mine.map(card)}
									</div>
								)}
							</div>
						);
					})}

					{homeless.length > 0 ? (
						<div className="flex flex-col gap-2.5">
							<SectionHead label="没归到口上的" hint="清单读不出来 / 版本不合" />
							<div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
								{homeless.map(card)}
							</div>
						</div>
					) : null}

					{/*
					 * 「还能再装一个」。**它不属于任何一口** —— 装这件事跟拓展开哪一口无关,
					 * 所以摆在分组之外。
					 *
					 * 刻意**不是** `AddCard`:那是一颗按钮,而面板安装那条路还没建,按下去
					 * 没有任何事发生。虚线框说的是同一句话,又不假装自己能点。
					 */}
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						<EmptyNote className="flex flex-col justify-center gap-1">
							<span className="text-bn-sm font-bold text-bn-text-secondary">装一个拓展</span>
							<span className="text-bn-xs text-bn-text-tertiary">
								把包放进 <span className="font-mono">&lt;dataDir&gt;/extensions/</span>,
								重启一次就看得见
							</span>
						</EmptyNote>
					</div>
				</>
			)}
		</div>
	);
}
