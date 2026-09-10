import { GlassPanel, HintNote, Icon, Pill } from "@bilibili-notify/ui";

/**
 * 拓展页的**开箱那一屏** —— 一个拓展都没装时它就是整页。
 *
 * 🔴 本体一个拓展都不带(主人 2026-09-09 推翻 ADR-0012 决策 34),所以**新装的 BN 打开
 * 这一页必然是空的**:这一屏不是「空态提示」,它是这台机器上唯一一份「拓展怎么来」的说明。
 * 只写一句「还没有装任何拓展」等于让主人去翻文档。
 *
 * 两条来路都写,包括**还没建好的那条**:藏起来的话主人会以为按钮在别的页面,来回找;
 * 明说「还没做」他就知道该走下面那条。
 */
export function ExtensionsEmpty() {
	return (
		<GlassPanel
			accent="var(--color-bn-pink)"
			icon={<Icon.extension size={17} />}
			title="还没有装任何拓展"
			subtitle="拓展给 BN 接上外面的东西 —— 比如把 koishi / AstrBot 里配好的机器人借过来当推送目标。它们不随 BN 一起发,装不装、装哪个由主人定。"
		>
			<div className="flex flex-col gap-4">
				<div className="grid gap-4 md:grid-cols-2">
					{/* 来路一:面板安装 —— 签名镜像那条链还没建,如实说。 */}
					<div className="flex flex-col gap-2 rounded-bn-card border border-dashed border-bn-inactive/50 p-4 opacity-75">
						<div className="flex items-center gap-2">
							<span className="text-bn-sm font-bold text-bn-text-secondary">① 在面板里装</span>
							<Pill subtle color="var(--color-bn-warning)">
								还没做
							</Pill>
						</div>
						<p className="text-bn-xs leading-relaxed text-bn-text-tertiary">
							从我们签过名的镜像下载、验签、原子落盘。这条路要先建完一整套分发流水线,排在后面 ——
							在那之前用右边那条。
						</p>
					</div>

					{/* 来路二:手放 —— 今天唯一能走通的。 */}
					<div className="flex flex-col gap-2.5 rounded-bn-card border border-bn-border bg-bn-surface p-4">
						<div className="flex items-center gap-2">
							<span className="text-bn-sm font-bold text-bn-text-primary">② 自己放进去</span>
							<Pill subtle color="var(--color-bn-success)">
								现在能用
							</Pill>
						</div>
						<ol className="ml-4 list-decimal text-bn-xs leading-loose text-bn-text-secondary">
							<li>
								拿到拓展包(一个目录,里头是 <span className="font-mono">extension.json</span> 与{" "}
								<span className="font-mono">index.mjs</span>)
							</li>
							<li>
								整个放进{" "}
								<span className="font-mono">&lt;dataDir&gt;/extensions/&lt;拓展 id&gt;/</span>
							</li>
							<li>
								重启 BN 一次 —— 它就出现在这一页,
								<strong className="text-bn-text-primary">默认是关着的</strong>
							</li>
						</ol>
						<p className="border-t border-dashed border-bn-border pt-2 text-bn-xs leading-relaxed text-bn-text-tertiary">
							目录名要和清单里的 <span className="font-mono">id</span> 一致,对不上会在这一页
							列出来并说明原因。
						</p>
					</div>
				</div>

				{/*
				 * 开发版走的还是**上面第②条**,只是那几下由 devtools 代劳(决策 35)——
				 * 不说的话下一个人会以为仓里那个目录还会被自动扫到(2026-09-10 起不会了)。
				 */}
				<HintNote>
					开发版不用自己动手:左下角 devtools 的
					<strong className="text-bn-text-secondary">「拓展」</strong>那一组能把仓里构建好的{" "}
					<span className="font-mono">dist</span> 装进来(软链),还能在改完代码之后
					<strong className="text-bn-text-secondary">重载</strong> —— 换代码不必重启整个 server。
				</HintNote>
			</div>
		</GlassPanel>
	);
}
