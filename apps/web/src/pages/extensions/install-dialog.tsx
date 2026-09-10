import { Btn, HintNote, ModalShell, Pill } from "@bilibili-notify/ui";
import { ExtensionInstallSlot } from "./install-slot";

/**
 * 「装一个拓展」那个弹窗 —— 列表页右上角那颗钮开的。
 *
 * 🔴 本体一个拓展都不带(主人 2026-09-09 推翻 ADR-0012 决策 34),所以**新装的 BN 打开
 * 拓展页必然是空的**:这里不是「上传」两个字,它是这台机器上唯一一份「拓展怎么来」的说明。
 *
 * 两条来路都写,而且**都能走通**:就在这儿传一个包上来(装完当场就跑),或者自己把目录
 * 放进 `<dataDir>/extensions/`(服务器上更顺手,代价是要重启一次)。
 */
export function ExtensionInstallDialog({ onClose }: { onClose: () => void }) {
	return (
		<ModalShell
			width={540}
			onCancel={onClose}
			title="装一个拓展"
			description="拓展给 BN 接上外面的东西 —— 比如把 koishi / AstrBot 里配好的机器人借过来当推送目标。它们不随 BN 一起发,装不装、装哪个由主人定。"
			bodyClassName="px-5 pb-4 pt-4"
		>
			<div className="flex flex-col gap-3.5">
				{/* 来路一:就在这儿传上来。新装的是热的 —— 装完当场跑起来,不用重启。 */}
				<section className="flex flex-col gap-2.5">
					<div className="flex items-center gap-2">
						<span className="text-bn-xs font-bold text-bn-text-secondary">① 传一个包上来</span>
						<Pill subtle size="sm" color="var(--color-bn-success)">
							现在能用
						</Pill>
					</div>
					<ExtensionInstallSlot />
				</section>

				{/* 来路二:手放 —— 服务器上更顺手。 */}
				<section className="flex flex-col gap-2.5 border-t border-bn-border-subtle pt-3.5">
					<div className="flex items-center gap-2">
						<span className="text-bn-xs font-bold text-bn-text-secondary">② 自己放进去</span>
						<Pill subtle size="sm" color="var(--color-bn-text-tertiary)">
							服务器上更顺手
						</Pill>
					</div>
					<ol className="ml-4 list-decimal text-bn-xs leading-[1.7] text-bn-text-secondary">
						<li>
							拿到拓展包(一个目录,里头是 <span className="font-mono">extension.json</span> 与{" "}
							<span className="font-mono">index.mjs</span>)
						</li>
						<li>
							整个放进{" "}
							<span className="font-mono">&lt;dataDir&gt;/extensions/&lt;拓展 id&gt;/</span>
						</li>
						<li>
							重启 BN 一次 —— 它就出现在列表里,
							<strong className="text-bn-text-primary">默认是关着的</strong>
							(从①传上来的不用重启,当场就在)
						</li>
					</ol>
					<p className="text-bn-2xs leading-[1.7] text-bn-text-tertiary">
						目录名要和清单里的 <span className="font-mono">id</span> 一致,对不上会在列表里
						列出来并说明原因。
					</p>
				</section>

				{/*
				 * 开发版走的还是**上面第②条**,只是那几下由 devtools 代劳(决策 35)——
				 * 不说的话下一个人会以为仓里那个目录还会被自动扫到(2026-09-10 起不会了)。
				 */}
				<HintNote className="leading-[1.7]">
					开发版不用自己动手:左下角 devtools 的
					<strong className="text-bn-text-secondary">「拓展」</strong>那一组能把仓里构建好的{" "}
					<span className="font-mono">dist</span> 装进来(软链,
					<strong className="text-bn-text-secondary">装完当场就出现在列表里</strong>),
					还能在改完代码之后<strong className="text-bn-text-secondary">重载</strong>
					—— 换代码不必重启整个 server。
				</HintNote>

				<div className="flex justify-end pt-1">
					<Btn variant="outline" size="md" onClick={onClose}>
						关闭
					</Btn>
				</div>
			</div>
		</ModalShell>
	);
}
