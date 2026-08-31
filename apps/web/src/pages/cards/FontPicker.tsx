/**
 * 字体选择器 —— 取代原来那个手填 `font-family` 的输入框。
 *
 * 形态照背景图廊那套(上传 / 列表 / 删盘 / 409 拦截提示),但选的是**一款**而不是一串:
 * 卡片同一时刻只能用一种字体,没有轮换的说法。三档:
 *
 *   默认(交给渲染那台机器) · 主人自己传的每一款 · 手填家族名(高级)
 *
 * **不摆「内置字体」行。** 曾经摆过思源黑 / 思源宋 —— 那是 Docker 镜像塞进去的
 * (容器里本来一个中文字体都没有),可桌面版出图用的是主人自己机器上的 Chrome,
 * Windows / macOS 默认都没有 Noto CJK,那两行在桌面版全是哑弹。而 Win/mac 本来就
 * 自带中文字体,「默认」这一档在三种环境下都挑得到能用的字,不需要我们替它点名。
 * 要指定具体某款:上传字体文件(两端都作数),或走「手填」用本机装过的。
 */

import { MAX_FONT_ASSET_BYTES } from "@bilibili-notify/internal/constants";
import {
	AddFileButton,
	Btn,
	ErrorNote,
	Icon,
	IconButton,
	SELECTED_LANGUAGE,
	WarnNote,
} from "@bilibili-notify/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { TInput } from "../../components/forms";
import { ApiError, api } from "../../services/api";
import {
	type FontChoice,
	fontSelection,
	fontSizeWarning,
	pickDefaultFont,
	pickFamilyFont,
	pickUploadedFont,
} from "./font-ops";

interface FontListResponse {
	ok: boolean;
	/** `size` 是文件字节数 —— 大字体提醒按**当前选中的那款**算,就靠它。 */
	fonts: Array<{ id: string; name: string; size?: number }>;
}

/** 一行可选项。选中态用 aria-pressed 表达 —— 读屏读得出,测试也查得到。 */
function Row({
	active,
	label,
	hint,
	onPick,
	right,
}: {
	active: boolean;
	label: string;
	hint?: string;
	onPick: () => void;
	right?: React.ReactNode;
}) {
	return (
		<div
			// 同 sidebar 会话行:描边与底色都在这一层,里面那个 button 只是可点区域。
			data-bn={active ? "option option-active" : "option"}
			// 选中态整句吃 SELECTED_LANGUAGE(border 宽度随句子走,所以闲置分支自带)——
			// 此前是自配的 bg-bn-pink/8 纱,配方与 Subs 分组胶囊那句定案各漂各的。
			className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition ${
				active
					? SELECTED_LANGUAGE
					: "border border-bn-border-subtle hover:border-bn-border hover:bg-bn-surface/60"
			}`}
		>
			<button
				type="button"
				onClick={onPick}
				aria-pressed={active}
				className="flex min-w-0 flex-1 flex-col items-start text-left"
			>
				<span
					className={`truncate text-bn-sm font-bold ${
						active ? "text-bn-pink" : "text-bn-text-primary"
					}`}
				>
					{label}
				</span>
				{hint ? <span className="text-bn-2xs text-bn-text-tertiary">{hint}</span> : null}
			</button>
			{right}
		</div>
	);
}

export function FontPicker({
	value,
	onChange,
	onAssetDeleted,
}: {
	value: FontChoice;
	onChange: (next: FontChoice) => void;
	/**
	 * 删盘成功后的回调(在本 picker 自身 onChange 剔除之外)。Cards 页借它清扫页面上
	 * 其他仍选着这款字体的样式草稿 —— 否则那些字段带着悬空 id 落盘成幽灵引用。
	 */
	onAssetDeleted?: (id: string) => void;
}) {
	const qc = useQueryClient();
	const [uploading, setUploading] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const list = useQuery({
		queryKey: ["card-font-assets"],
		queryFn: () => api.get<FontListResponse>("/api/cards/font-assets"),
	});
	const fonts = list.data?.fonts ?? [];
	const sel = fontSelection(value, list.data ? fonts.map((f) => f.id) : null);
	/**
	 * 大到会影响出图的提醒。**从当前选中那款派生**,不是上传时存下来的一句话:存成
	 * state 的话切走不消(横幅还在说一款已经不用了的字体)、重载就没(而正被 OOM 折磨
	 * 的主人恰恰是重载之后来看这块界面的)。与 err 分开:那是失败,这是收下了但要打个
	 * 招呼。
	 */
	const warn =
		sel.kind === "uploaded" ? fontSizeWarning(fonts.find((f) => f.id === sel.id)?.size ?? 0) : null;

	const onFile = async (file: File | undefined) => {
		if (!file) return;
		setErr(null);
		setUploading(true);
		try {
			const form = new FormData();
			form.append("file", file);
			const res = await api.upload<{ ok: boolean; id?: string; err?: string }>(
				"/api/cards/font-asset",
				form,
			);
			if (!res.ok || !res.id) throw new Error(res.err ?? "上传失败");
			await qc.invalidateQueries({ queryKey: ["card-font-assets"] });
			// 传上来的当场选用,否则像没反应。大字体那句提醒不在这儿说 —— 它由「当前选中
			// 的是哪款、那款多大」派生,列表刷新后自然就出来了,切走 / 重载也都对得上。
			onChange(pickUploadedFont(value, res.id));
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setUploading(false);
		}
	};

	const onDelete = async (id: string) => {
		setErr(null);
		try {
			await api.delete(`/api/cards/font-asset/${id}`);
			if (value.fontAsset === id) onChange(pickDefaultFont(value));
			// 通知页面清扫其他仍选着这款的样式草稿(必须在删盘成功后、409 拦截不触发)。
			onAssetDeleted?.(id);
			await qc.invalidateQueries({ queryKey: ["card-font-assets"] });
		} catch (e) {
			if (e instanceof ApiError && e.status === 409) {
				const by = (e.body as { referencedBy?: string[] } | undefined)?.referencedBy ?? [];
				setErr(`仍被使用,无法删除：${by.join("、")}`);
			} else {
				setErr((e as Error).message);
			}
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<Row
				active={sel.kind === "default"}
				label="默认（交给渲染那台机器）"
				hint="Docker 里是思源黑体，Windows 是微软雅黑，macOS 交给系统挑"
				onPick={() => onChange(pickDefaultFont(value))}
			/>

			{fonts.map((f) => (
				<Row
					key={f.id}
					active={sel.kind === "uploaded" && sel.id === f.id}
					label={f.name}
					hint="主人自己传的"
					onPick={() => onChange(pickUploadedFont(value, f.id))}
					right={
						<IconButton
							icon={<Icon.close size={11} />}
							label={`删除 ${f.name}`}
							title="从字体库删除"
							tone="danger"
							shape="pill"
							onClick={() => onDelete(f.id)}
						/>
					}
				/>
			))}

			{/* 选着一款已经不在字体库里的 —— 显式摆出来。悄悄回落成默认的话,主人只会
			    觉得「我选的字体自己变回去了」,而界面上没有任何线索。 */}
			{sel.kind === "missing" ? (
				<div className="flex items-center gap-2 rounded-lg border border-dashed border-bn-danger-border bg-bn-danger-soft px-2.5 py-1.5">
					<span className="flex-1 text-bn-xs text-bn-danger-text">
						选中的字体文件已不在字体库里,当前实际用的是兜底字体
					</span>
					<Btn variant="danger-outline" size="sm" onClick={() => onChange(pickDefaultFont(value))}>
						清除
					</Btn>
				</div>
			) : null}

			<div className="flex items-center gap-2">
				<AddFileButton
					accept=".woff2,.woff,.ttf,.otf"
					uploading={uploading}
					onFile={onFile}
					className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-bn-xs font-bold"
				>
					<Icon.plus size={13} />
					上传字体
				</AddFileButton>
				{/* 上限从共享常量算,别硬写:写死的话调了 MAX_FONT_ASSET_BYTES 这句话还在
				    说旧数字,主人等完一次上传才被告知一个跟按钮旁边写的不一样的上限。 */}
				<span className="text-bn-2xs text-bn-text-tertiary">
					{`woff2 / woff / ttf / otf，单款 ${Math.round(MAX_FONT_ASSET_BYTES / 1024 / 1024)}MB 以内 —— 优先用 woff2，同一套字通常只占 ttf 的三分之一`}
				</span>
			</div>

			{/* 手填:给桌面版主人用本机装的字体留的路 —— 苹方 / 微软雅黑这些填了就作数。
			    容器里没装的字体填了不生效,所以这一档摆在最后并把两边的话都说明白。 */}
			<details
				className="rounded-lg border border-bn-border-subtle px-2.5 py-1.5"
				open={sel.kind === "custom"}
			>
				<summary className="cursor-pointer text-bn-xs font-bold text-bn-text-secondary">
					手填字体名（高级）
				</summary>
				<div className="mt-1.5 flex flex-col gap-1">
					<TInput
						ariaLabel="手填字体名"
						value={sel.kind === "custom" ? sel.family : ""}
						placeholder="例如 PingFang SC"
						onChange={(v) => onChange(pickFamilyFont(value, v))}
					/>
					{/* 长句走字符串表达式:留成 JSX 文本的话,格式化器会按宽度折行,而 JSX 把
					    行首尾的换行连同缩进一并吃掉 —— 「Docker 容器」正好断在那儿就会粘成
					    「Docker容器」。 */}
					<span className="text-bn-2xs text-bn-text-tertiary">
						要<strong>渲染那台机器</strong>
						{
							"上装过这个字体才作数：桌面版填系统自带的（苹方、微软雅黑）就行；Docker 容器里只装了思源黑体 / 思源宋体（Noto CJK），填别的不会生效 —— 那种情况请把字体文件传上来"
						}
					</span>
				</div>
			</details>

			{err ? <ErrorNote size="sm">{err}</ErrorNote> : null}
			{/* 提醒不是错误:字体已经收下并选用了,只是大到会影响出图,得让主人心里有数。 */}
			{warn ? <WarnNote size="sm">{warn}</WarnNote> : null}
		</div>
	);
}
