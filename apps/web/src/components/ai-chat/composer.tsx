import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { type AiSkill, matchSkills } from "./skills";

/**
 * 聊天输入框 —— 一根 textarea、一个技能入口、一颗发送键,外加 `/` 唤起的技能菜单。
 *
 * 空态与对话态用的是**同一个**实例(位置不同而已),所以状态都收在这里:菜单开合、
 * 高亮项、焦点。放到外层的话,两处各持一份就会出现「空态里打了半句 `/锐`,发完
 * 第一句切到对话态,菜单还挂着」这种鬼影。
 */

/** 一张已经传好的附件。上传发生在 Composer **外面**,它只负责显示与去留。 */
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
	onPickFiles?: (files: FileList) => void;
	/** 去掉某一张。给的是 **id 不是下标** —— 下标会在数组变短后指错人。 */
	onRemoveAttachment?: (id: string) => void;
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
}: ComposerProps) {
	const fileRef = useRef<HTMLInputElement>(null);
	const full = attachments.length >= MAX_ATTACHMENTS;
	const [focus, setFocus] = useState(false);
	const [index, setIndex] = useState(0);
	/** Esc 关掉菜单后,得等下一次输入变化才重新弹 —— 否则 Esc 按了跟没按一样。 */
	const [closed, setClosed] = useState(false);
	const taRef = useRef<HTMLTextAreaElement>(null);

	const matches = matchSkills(value);
	const showMenu = matches.length > 0 && !closed;
	// 只有图、一个字没打也算数 —— 拖一张图进来直接回车是最自然的用法,那时
	// 「这是什么」纯属多余,图本身就是问题。
	const canSend = !busy && (value.trim().length > 0 || attachments.length > 0);

	// 匹配项变少时高亮可能指到列表外(打 `/锐` 只剩一条,而高亮停在第 3 条),
	// 那时 Enter 会选中 undefined。收敛回合法范围。
	useEffect(() => {
		setIndex((i) => (i >= matches.length ? 0 : i));
	}, [matches.length]);

	const pick = (s: AiSkill) => {
		// 补一个空格:选完技能光标停在命令后面,主人接着打就是追加要求。
		onChange(`${s.cmd} `);
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
					className="bn-anim-cmd-in absolute inset-x-1 bottom-full z-10 mb-2.5 overflow-hidden rounded-[14px] border border-bn-border bg-bn-surface-strong shadow-bn-elev"
					role="listbox"
					aria-label="女仆技能"
				>
					<div className="p-[5px]">
						{matches.map((s, k) => (
							<button
								key={s.cmd}
								type="button"
								role="option"
								aria-selected={k === index}
								onClick={() => pick(s)}
								onMouseEnter={() => setIndex(k)}
								className={`block w-full rounded-[9px] px-[11px] py-2 text-left transition-colors ${
									k === index ? "bn-chat-accent-soft" : "bg-transparent"
								}`}
							>
								<div className="flex items-center gap-2">
									<span className="bn-chat-accent font-mono text-[13px] font-semibold">
										{s.cmd}
									</span>
									<span className="rounded-[5px] bg-bn-code-bg px-[7px] py-px text-[10.5px] font-semibold text-bn-text-secondary">
										女仆技能
									</span>
								</div>
								<div className="mt-0.5 truncate text-xs text-bn-text-tertiary">{s.desc}</div>
							</button>
						))}
					</div>
					<div className="flex gap-3.5 border-t border-bn-border-subtle px-[13px] py-[7px] text-[11px] text-bn-text-secondary">
						<span>↑↓ 选择</span>
						<span>Enter 确认</span>
						<span>Esc 关闭</span>
					</div>
				</div>
			) : null}

			<div
				className={`rounded-[28px] border bg-bn-surface p-2 transition ${
					focus
						? "bn-chat-accent-focus"
						: "border-bn-border shadow-[0_8px_22px_rgba(24,18,45,0.08)]"
				}`}
			>
				{attachments.length > 0 ? (
					<div className="flex flex-wrap gap-2 px-1.5 pt-1 pb-2.5">
						{attachments.map((a) => (
							<div key={a.id} className="group relative">
								<img
									src={a.url}
									alt="待发送的图片"
									className="h-16 w-16 rounded-[10px] border border-bn-border object-cover"
								/>
								<button
									type="button"
									aria-label="移除图片"
									title="移除"
									onClick={() => onRemoveAttachment?.(a.id)}
									className="-right-1.5 -top-1.5 absolute grid h-5 w-5 cursor-pointer place-items-center rounded-full border border-bn-border bg-bn-surface text-bn-text-secondary shadow-sm transition-colors hover:text-bn-text-primary"
								>
									<Icon.close size={12} />
								</button>
							</div>
						))}
					</div>
				) : null}

				<div className="flex items-end gap-2.5">
					<input
						ref={fileRef}
						type="file"
						accept="image/png,image/jpeg,image/webp"
						multiple
						hidden
						onChange={(e) => {
							if (e.target.files?.length) onPickFiles?.(e.target.files);
							// 清空 value:同一张图连挑两次时 change 不会再触发,看着就像点了没反应。
							e.target.value = "";
						}}
					/>
					<button
						type="button"
						title={full ? `最多 ${MAX_ATTACHMENTS} 张` : "添加图片"}
						aria-label="添加图片"
						disabled={full}
						onClick={() => fileRef.current?.click()}
						className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center self-center rounded-full text-bn-text-secondary transition-colors hover:bg-bn-hover-muted disabled:cursor-not-allowed disabled:opacity-40"
					>
						<Icon.image size={18} />
					</button>
					<button
						type="button"
						title="技能"
						aria-label="唤起女仆技能"
						onClick={() => {
							onChange("/");
							setClosed(false);
							taRef.current?.focus();
						}}
						className="grid h-9 w-9 shrink-0 cursor-pointer place-items-center self-center rounded-full text-bn-text-secondary transition-colors hover:bg-bn-hover-muted"
					>
						<Icon.plus size={19} />
					</button>
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
						onFocus={() => setFocus(true)}
						// 延后收焦点态:点技能菜单里的项会先触发 blur,立刻收会让菜单在
						// click 落地前就消失,于是那一下点了个寂寞。
						onBlur={() => setTimeout(() => setFocus(false), 120)}
						placeholder={`给${aiName}发消息,输入 / 唤起技能`}
						aria-label="聊天输入"
						className="max-h-[150px] flex-1 resize-none self-center border-none bg-transparent px-0.5 py-2 text-[16.5px] leading-relaxed text-bn-text-primary outline-none placeholder:text-bn-text-secondary"
					/>
					<button
						type="button"
						title="发送"
						aria-label="发送"
						disabled={!canSend}
						onClick={onSubmit}
						className={`grid h-11 w-11 shrink-0 place-items-center self-end rounded-full transition ${
							canSend
								? "bn-chat-accent-grad bn-chat-accent-glow cursor-pointer text-white"
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
