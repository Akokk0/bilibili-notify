import type {
	ExtensionDTO,
	ExtensionProvides,
	ExtensionsResponse,
} from "@bilibili-notify/contract";
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
import { ExtensionInstallSlot } from "./extensions/install-slot";
import {
	ExtensionIcon,
	ExtensionWhereLine,
	extensionAccent,
	useExtensionToggle,
} from "./extensions/shared";
import { EXTENSION_STATE_META } from "./extensions/state-meta";

/** 卡片只要接入的这两格,所以就地说清 —— 连接的完整形状不归这一页管。 */
interface ExtensionLink {
	kind?: string;
	extensionId?: string;
}

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

/**
 * 「它名下配了几条接入」。
 *
 * ⚠️ 设计稿 V1 这一行还有后半句「N 个 bot 在线」—— **那半句留在详情页**:bot 是桥自己的
 * 概念,数它就得让列表页认得桥,而「卡片上的每一个字都来自服务端」正是为了挡住这个。
 * 接入数不一样:任何开推送源那一口的拓展都有接入,按 `provides` 判就够,不必认得是谁。
 *
 * **0 也报**:那正是「装好了但还没接上」该看见的一行。
 */
function LinkCount({ ext, connections }: { ext: ExtensionDTO; connections: ExtensionLink[] }) {
	if (!(ext.provides ?? []).includes("push")) return null;
	const mine = connections.filter(
		(connection) => connection.kind === "extension" && connection.extensionId === ext.id,
	);
	// 大数字 —— 照设计稿 V1:这是卡上唯一要一眼读到的数,和旁边那排小字不是一个量级。
	return (
		<div className="flex items-baseline gap-1.5">
			<span className="text-bn-xl font-bold leading-none text-bn-text-primary">{mine.length}</span>
			<span className="text-bn-xs text-bn-text-tertiary">条接入</span>
		</div>
	);
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
	connections,
	onToggle,
}: {
	ext: ExtensionDTO;
	connections: ExtensionLink[];
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
				<LinkCount ext={ext} connections={connections} />
				<ExtensionWhereLine ext={ext} />
				{/*
				 * 详情页那块是拓展自己交上来的面板数据 —— 没有入口的话只能手敲地址。
				 * 照设计稿 V1 摆右下、叫「管理」:进去是要动手改东西的,不是去读一页说明。
				 */}
				<Link
					to={`/extensions/${ext.id}`}
					className="mt-auto self-end text-bn-sm font-bold text-bn-pink transition-opacity hover:opacity-80"
				>
					管理 →
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

export default function Extensions() {
	const listed = useQuery({
		queryKey: ["extensions"],
		queryFn: () => api.get<ExtensionsResponse>("/api/ext"),
	});
	// 接入表 —— 只为卡片上那句「N 条接入」。**与拓展表分开取**:拓展没跑起来时它照样在,
	// 而「配了但那个拓展没起来」正是最该看见的一种。
	const connections = useQuery({
		queryKey: ["connections"],
		queryFn: () => api.get<ExtensionLink[]>("/api/connections"),
	});
	const toggle = useExtensionToggle();

	if (listed.isPending) return <LoadingBlock label="正在读取拓展" />;

	const extensions = listed.data?.extensions ?? [];
	// 归不了口的那些(清单读不出来 / 版本不合 → 没有 provides)。它们**不许消失**:
	// 消失的东西没法排查,而这一页正是主人来看「它怎么了」的地方。
	const homeless = extensions.filter((ext) => (ext.provides ?? []).length === 0);

	const links = connections.data ?? [];
	const card = (ext: ExtensionDTO) => (
		<ExtensionCard
			key={ext.id}
			ext={ext}
			connections={links}
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
						(正连着的插件会被断开,配置全留),打开就地装起来。换掉一份**已经装着的**
						拓展的代码,才要重启一次 —— 已经加载的代码在进程里换不掉。
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
					 */}
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						<ExtensionInstallSlot />
					</div>
				</>
			)}
		</div>
	);
}
