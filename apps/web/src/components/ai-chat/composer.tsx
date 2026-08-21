import type { MaidSkillDTO } from "@bilibili-notify/contract";
import { Icon, IconButton, MenuItem } from "@bilibili-notify/ui";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useSkinText } from "../../store/skin";
import { matchSkills } from "./skills";

/**
 * 聊天输入框 —— 一根 textarea、一颗「+」二级菜单(添加图片 / 女仆技能)、一颗
 * 发送键,外加 `/` 唤起的技能菜单。
 *
 * 空态与对话态用的是**同一个**实例(位置不同而已),所以状态都收在这里:两层菜单
 * 的开合、高亮项、焦点。放到外层的话,两处各持一份就会出现「空态里打了半句
 * `/锐`,发完第一句切到对话态,菜单还挂着」这种鬼影。
 *
 * 「+」菜单与 `/` 唤起的技能菜单是**两层独立的东西**:前者是个固定两项的小菜单
 * (点按钮开合、Esc / 点外关闭),后者是打 `/` 触发的搜索式列表(随输入过滤、
 * ↑↓ 选择)。合并成一层的话,「+」选了技能之后残留的搜索态会立刻又弹出后者,
 * 界面会连闪两层菜单。
 */

/** 一张已经传好的附件。上传发生在 Composer **外面**,它只负责显示与去留。 */
/**
 * 输入框最高长到这儿,再长就自己滚。
 *
 * 导出是给测试的:高度这件事只能靠这个数字对齐,写死两份迟早对不上。
 */
export const COMPOSER_MAX_HEIGHT = 150;

export interface ComposerAttachment {
	/** 服务端资产 id,随消息一起发出去。 */
	id: string;
	/** 显示用地址(`/api/ai/assets/<id>`)。 */
	url: string;
}

/** 一条消息最多带几张图 —— 与服务端 `MAX_CHAT_IMAGES_PER_MESSAGE` 同口径。 */
export const MAX_ATTACHMENTS = 4;

export interface ComposerProps {
	value: string;
	onChange: (next: string) => void;
	/** 提交。调用方负责把 value 清空(成功时)或留着(失败时让主人重试)。 */
	onSubmit: () => void;
	/** 等回复期间禁用发送。 */
	busy: boolean;
	autoFocus?: boolean;
	/** 女仆的名字,进 placeholder。取自人格配置,不写死。 */
	aiName: string;
	/** 已经传好的附件。缺省空数组 —— 没接附件功能的调用方不必改。 */
	attachments?: ComposerAttachment[];
	/** 主人挑了文件。上传由调用方做,传完把结果塞回 `attachments`。 */
	/**
	 * 挑好的图。收 `File[]` 而不是 `FileList` —— 粘贴板给的是一颗颗
	 * `DataTransferItem`,凑不出 FileList,而这两条路本该汇进同一个入口。
	 */
	onPickFiles?: (files: readonly File[]) => void;
	/** 去掉某一张。给的是 **id 不是下标** —— 下标会在数组变短后指错人。 */
	onRemoveAttachment?: (id: string) => void;
	/**
	 * 动作行左侧的附加控件(如「深度思考」开关)。以插槽递进来而不是在这里写死:
	 * Composer 不该知道全局配置长什么样,它只管排版位置。
	 */
	extras?: ReactNode;
	/**
	 * 可用的女仆技能 —— `/` 唤起的那份菜单。缺省空数组:技能拉不到时斜杠只是
	 * 一个普通字符,聊天照常。
	 */
	skills?: readonly MaidSkillDTO[];
}

export function Composer({
	value,
	onChange,
	onSubmit,
	busy,
	autoFocus,
	aiName,
	attachments = [],
	onPickFiles,
	onRemoveAttachment,
	extras,
	skills = [],
}: ComposerProps) {
	const fileRef = useRef<HTMLInputElement>(null);
	const full = attachments.length >= MAX_ATTACHMENTS;
	// 皮肤文案槽:皮肤给了 chatPlaceholder 就整句替换默认提示。
	const skinPlaceholder = useSkinText("chatPlaceholder");
	const [focus, setFocus] = useState(false);
	const [index, setIndex] = useState(0);
	/** Esc 关掉菜单后,得等下一次输入变化才重新弹 —— 否则 Esc 按了跟没按一样。 */
	const [closed, setClosed] = useState(false);
	/** 「+」二级菜单的开合 —— 与上面 `/` 那层技能搜索菜单各管各的状态。 */
	const [actionsOpen, setActionsOpen] = useState(false);
	const actionsRef = useRef<HTMLDivElement>(null);
	const taRef = useRef<HTMLTextAreaElement>(null);

	// 「+」菜单开着时:点外部 / 按 Esc 关闭。只在展开时挂监听,与 header 的
	// 主题下拉同一套写法。
	useEffect(() => {
		if (!actionsOpen) return;
		const onDocClick = (e: MouseEvent) => {
			if (!actionsRef.current?.contains(e.target as Node)) setActionsOpen(false);
		};
		const onKey = (e: KeyboardEvent | globalThis.KeyboardEvent) => {
			if (e.key === "Escape") setActionsOpen(false);
		};
		document.addEventListener("mousedown", onDocClick);
		document.addEventListener("keydown", onKey as (e: globalThis.KeyboardEvent) => void);
		return () => {
			document.removeEventListener("mousedown", onDocClick);
			document.removeEventListener("keydown", onKey as (e: globalThis.KeyboardEvent) => void);
		};
	}, [actionsOpen]);

	// 内容长到这儿就不再长高,改成自己滚 —— 再长下去输入框会把整页吃掉。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只按 value 重算,函数体里不读别的
	useLayoutEffect(() => {
		const el = taRef.current;
		if (!el) return;
		// 先归零再读 scrollHeight:不归零的话读到的是「当前高度」的那个较大值,
		// 框只会越来越高、从不回落(删字之后留一个空荡荡的大框)。
		el.style.height = "auto";
		// jsdom 不排版,scrollHeight 恒为 0 —— 那时别把高度写成 0px。
		if (el.scrollHeight > 0)
			el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
	}, [value]);

	const matches = matchSkills(value, skills);
	const showMenu = matches.length > 0 && !closed;
	// 只有图、一个字没打也算数 —— 拖一张图进来直接回车是最自然的用法,那时
	// 「这是什么」纯属多余,图本身就是问题。
	const canSend = !busy && (value.trim().length > 0 || attachments.length > 0);

	// 匹配项变少时高亮可能指到列表外(打 `/锐` 只剩一条,而高亮停在第 3 条),
	// 那时 Enter 会选中 undefined。收敛回合法范围。
	useEffect(() => {
		setIndex((i) => (i >= matches.length ? 0 : i));
	}, [matches.length]);

	const pick = (s: MaidSkillDTO) => {
		// 补一个空格:选完技能光标停在命令后面,主人接着打就是追加要求。
		onChange(`/${s.name} `);
		setClosed(true);
		taRef.current?.focus();
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (showMenu) {
			const n = matches.length;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setIndex((i) => (i + 1) % n);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setIndex((i) => (i - 1 + n) % n);
				return;
			}
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				const picked = matches[Math.min(index, n - 1)];
				if (picked) pick(picked);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setClosed(true);
				return;
			}
		}
		// Shift+Enter 换行,Enter 发送 —— 与主流对话框一致。
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (canSend) onSubmit();
		}
	};

	return (
		<div className="relative mx-auto w-full max-w-[720px]">
			{showMenu ? (
				<div
					data-bn="glass-strong"
					className="bn-anim-cmd-in absolute inset-x-1 bottom-full z-bn-raised mb-2.5 overflow-hidden rounded-bn-card border border-bn-border bg-bn-surface-strong shadow-bn-elev"
					role="listbox"
					aria-label="女仆技能"
				>
					<div className="p-[5px]">
						{matches.map((s, k) => (
							<button
								key={s.name}
								type="button"
								role="option"
								aria-selected={k === index}
								onClick={() => pick(s)}
								onMouseEnter={() => setIndex(k)}
								className={`block w-full rounded-bn-sm px-[11px] py-2 text-left transition-colors ${
									k === index ? "bn-chat-accent-soft" : "bg-transparent"
								}`}
							>
								<div className="flex items-center gap-2">
									<span className="bn-chat-accent font-mono text-bn-base font-semibold">
										/{s.name}
									</span>
									<span className="rounded-bn-xs bg-bn-code-bg px-[7px] py-px text-bn-2xs font-semibold text-bn-text-secondary">
										{s.builtin ? "内置" : "自定义"}
									</span>
								</div>
								<div className="mt-0.5 truncate text-xs text-bn-text-tertiary">{s.description}</div>
							</button>
						))}
					</div>
					<div className="flex gap-3.5 border-t border-bn-border-subtle px-[13px] py-[7px] text-bn-xs text-bn-text-secondary">
						<span>↑↓ 选择</span>
						<span>Enter 确认</span>
						<span>Esc 关闭</span>
					</div>
				</div>
			) : null}

			<div
				className={`rounded-bn-xl border bg-bn-surface p-2 transition ${
					focus ? "bn-chat-accent-focus" : "border-bn-border shadow-bn-card"
				}`}
			>
				{attachments.length > 0 ? (
					<div className="flex flex-wrap gap-2 px-1.5 pt-1 pb-2.5">
						{attachments.map((a) => (
							<div key={a.id} className="group relative">
								<img
									src={a.url}
									alt="待发送的图片"
									className="h-16 w-16 rounded-bn-sm border border-bn-border object-cover"
								/>
								<IconButton
									icon={<Icon.close size={12} />}
									label="移除图片"
									title="移除"
									shape="pill"
									surface="filled"
									className="-right-1.5 -top-1.5 absolute"
									onClick={() => onRemoveAttachment?.(a.id)}
								/>
							</div>
						))}
					</div>
				) : null}

				{/* 学 DeepSeek 的两段式:输入框独占一行,下面单独一条工具栏(+ / 深度思考
				    这类开关 / 发送键)。曾经这些按钮跟输入框挤在同一行,内容一多输入区
				    反而被越挤越窄;分行之后输入区永远占满宽度,工具栏也有地方把开关
				    做成带文字的胶囊,不必缩成一个谁都认不出的图标。 */}
				<textarea
					ref={taRef}
					rows={1}
					// biome-ignore lint/a11y/noAutofocus: 聊天页是主人主动点开的整页覆盖层,打开就该能直接打字
					autoFocus={autoFocus}
					value={value}
					onChange={(e) => {
						onChange(e.target.value);
						setClosed(false);
						setIndex(0);
					}}
					onKeyDown={onKeyDown}
					// 截图直接粘上来是最顺手的动作;逼主人先存盘再点「+」去找那个
					// 文件,是把一步拆成三步。
					//
					// **不拦默认行为**:从网页复制的内容常常图文混在一起(clipboard
					// 里同时有 text/plain 和一张图),吞掉这一下就等于把文字也吃了。
					// 图归图收着,文字照旧粘进输入框。
					onPaste={(e) => {
						const picked: File[] = [];
						for (const item of e.clipboardData?.items ?? []) {
							if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
							const file = item.getAsFile();
							if (file) picked.push(file);
						}
						if (picked.length > 0) onPickFiles?.(picked);
					}}
					onFocus={() => setFocus(true)}
					// 延后收焦点态:点技能菜单里的项会先触发 blur,立刻收会让菜单在
					// click 落地前就消失,于是那一下点了个寂寞。
					onBlur={() => setTimeout(() => setFocus(false), 120)}
					placeholder={skinPlaceholder ?? `给${aiName}发消息,输入 / 唤起技能`}
					aria-label="聊天输入"
					className="w-full resize-none overflow-y-auto border-none bg-transparent px-2 pt-1.5 pb-1 text-bn-lg leading-relaxed text-bn-text-primary outline-none placeholder:text-bn-text-secondary"
				/>

				<div className="flex items-center justify-between gap-2 px-1 pt-1 pb-0.5">
					<div className="flex min-w-0 items-center gap-1.5">
						<input
							ref={fileRef}
							type="file"
							accept="image/png,image/jpeg,image/webp"
							multiple
							hidden
							onChange={(e) => {
								if (e.target.files?.length) onPickFiles?.([...e.target.files]);
								// 清空 value:同一张图连挑两次时 change 不会再触发,看着就像点了没反应。
								e.target.value = "";
							}}
						/>
						<div className="relative shrink-0" ref={actionsRef}>
							<IconButton
								icon={<Icon.plus size={19} />}
								label="添加"
								title="添加图片或唤起女仆技能"
								size="xl"
								shape="pill"
								ariaHasPopup
								ariaExpanded={actionsOpen}
								onClick={() => setActionsOpen((v) => !v)}
							/>
							{actionsOpen ? (
								<div
									role="menu"
									aria-label="更多"
									data-bn="glass-strong"
									className="bn-anim-cmd-in absolute bottom-full left-0 z-bn-raised mb-2 w-44 overflow-hidden rounded-bn-card border border-bn-border bg-bn-surface-strong p-1 shadow-bn-elev"
								>
									<MenuItem
										role="menuitem"
										icon={<Icon.image size={16} />}
										disabled={full}
										onClick={() => {
											fileRef.current?.click();
											setActionsOpen(false);
										}}
									>
										添加图片
									</MenuItem>
									<MenuItem
										role="menuitem"
										icon={<Icon.sparkle size={16} />}
										onClick={() => {
											onChange("/");
											setClosed(false);
											setActionsOpen(false);
											taRef.current?.focus();
										}}
									>
										女仆技能
									</MenuItem>
								</div>
							) : null}
						</div>
						{extras}
					</div>
					<button
						type="button"
						title="发送"
						aria-label="发送"
						disabled={!canSend}
						onClick={onSubmit}
						data-bn="btn"
						className={`grid h-9 w-9 shrink-0 place-items-center rounded-bn-pill transition ${
							canSend
								? "bn-chat-accent-grad bn-chat-accent-glow cursor-pointer text-bn-on-solid"
								: "cursor-default bg-bn-hover-muted text-bn-text-secondary"
						}`}
					>
						<Icon.arrowUp size={19} />
					</button>
				</div>
			</div>
		</div>
	);
}
