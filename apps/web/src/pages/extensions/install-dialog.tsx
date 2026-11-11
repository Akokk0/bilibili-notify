import { Btn, HintNote, ModalShell, MonoChip, Pill } from "@bilibili-notify/ui";
import { useExtensions } from "../../hooks/useExtensions";
import { useT } from "../../i18n";
import { CopyControl } from "./declarative/parts";
import { ExtensionInstallSlot } from "./install-slot";

/**
 * 「装一个拓展」那个弹窗 —— 列表页右上角那颗钮开的。
 *
 * 🔴 本体一个拓展都不带(主人 2026-09-09 推翻 ADR-0012 决策 34),所以**新装的 BN 打开
 * 拓展页必然是空的**:这里不是「上传」两个字,它是这台机器上唯一一份「拓展怎么来」的说明。
 *
 * 两条来路都写,而且**都能走通**:就在这儿传一个包上来(装完当场就跑),或者自己把目录
 * 放进装载根(服务器上更顺手,代价是要重启一次)。
 *
 * 🔴 装载根印**服务端报的那一串**(`ExtensionsResponse.root`):1.0 起数据在
 * `<dataDir>/generations/<序号>/` 里,在用的是哪一代只有服务端知道;照老说法放进
 * `<dataDir>/extensions/` 的包永远不会被装上。服务端没报(回退到了老版本)才照老说法写 ——
 * 那种服务端用的正是老位置。
 */
export function ExtensionInstallDialog({
	onClose,
	onInstalled,
}: {
	onClose: () => void;
	onInstalled?: (id: string) => void;
}) {
	const t = useT();
	// 与拓展页同一个键,弹窗是从那一页开的,这一口通常已经在缓存里。
	const root = useExtensions().data?.root;
	return (
		<ModalShell
			width={540}
			onCancel={onClose}
			title={t("extensions.dialog.title")}
			description={t("extensions.dialog.description")}
			bodyClassName="px-5 pb-4 pt-4"
		>
			<div className="flex flex-col gap-3.5">
				{/* 来路一:就在这儿传上来。新装的是热的 —— 装完当场跑起来,不用重启。 */}
				<section className="flex flex-col gap-2.5">
					<div className="flex items-center gap-2">
						<span className="text-bn-xs font-bold text-bn-text-secondary">
							{t("extensions.dialog.upload")}
						</span>
						<Pill subtle size="sm" color="var(--color-bn-success)">
							{t("extensions.dialog.available")}
						</Pill>
					</div>
					<ExtensionInstallSlot onInstalled={onInstalled} />
				</section>

				{/* 来路二:手放 —— 服务器上更顺手。 */}
				<section className="flex flex-col gap-2.5 border-t border-bn-border-subtle pt-3.5">
					<div className="flex items-center gap-2">
						<span className="text-bn-xs font-bold text-bn-text-secondary">
							{t("extensions.dialog.manual")}
						</span>
						<Pill subtle size="sm" color="var(--color-bn-text-tertiary)">
							{t("extensions.dialog.server")}
						</Pill>
					</div>
					<ol className="ml-4 list-decimal text-bn-xs leading-[1.7] text-bn-text-secondary">
						<li>
							{t("extensions.dialog.packageStart")}
							<span className="font-mono">extension.json</span> {t("extensions.dialog.and")}{" "}
							<span className="font-mono">index.mjs</span>
							{t("extensions.dialog.packageEnd")}
						</li>
						{root ? (
							<li>
								{t("extensions.dialog.root")}
								{/* 不拼 `/<拓展 id>/`:Windows 上这一串是反斜杠分隔的。路径要照抄,不截断。 */}
								<div className="mt-1 flex items-center gap-1.5">
									<MonoChip className="min-w-0 flex-1 break-all px-[9px] py-[5px]">{root}</MonoChip>
									<CopyControl iconOnly label={t("extensions.dialog.copyRoot")} text={root} />
								</div>
							</li>
						) : (
							<li>
								{t("extensions.dialog.fallbackStart")}{" "}
								<span className="font-mono">{t("extensions.dialog.fallbackPath")}</span>
							</li>
						)}
						<li>
							{t("extensions.dialog.restart")}
							<strong className="text-bn-text-primary">{t("extensions.dialog.disabled")}</strong>
							{t("extensions.dialog.uploadNoRestart")}
						</li>
					</ol>
					<p className="text-bn-2xs leading-[1.7] text-bn-text-tertiary">
						{t("extensions.dialog.idStart")}
						<span className="font-mono">id</span> {t("extensions.dialog.idEnd")}
					</p>
				</section>

				{/*
				 * 开发版走的还是**上面第②条**,只是那几下由 devtools 代劳(决策 35)——
				 * 不说的话下一个人会以为仓里那个目录还会被自动扫到(2026-09-10 起不会了)。
				 * 只在开发构建里渲染:正式版没有 devtools,这段话对用户是指向不存在的东西的谜语。
				 * `import.meta.env.DEV` 是编译期常量,生产构建里这一枝整个折掉。
				 */}
				{import.meta.env.DEV || import.meta.env.BN_DEVELOPMENT_RUNTIME ? (
					<HintNote className="leading-[1.7]">
						{t("extensions.dialog.devStart")}
						<strong className="text-bn-text-secondary">{t("extensions.dialog.devGroup")}</strong>
						{t("extensions.dialog.devBuild")} <span className="font-mono">dist</span>{" "}
						{t("extensions.dialog.devLink")}
						<strong className="text-bn-text-secondary">
							{t("extensions.dialog.devImmediate")}
						</strong>
						{t("extensions.dialog.devReloadStart")}
						<strong className="text-bn-text-secondary">{t("extensions.dialog.devReload")}</strong>
						{t("extensions.dialog.devReloadEnd")}
					</HintNote>
				) : null}

				<div className="flex justify-end pt-1">
					<Btn variant="outline" size="md" onClick={onClose}>
						{t("extensions.dialog.close")}
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}
