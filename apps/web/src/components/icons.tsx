/**
 * Icon registry — inline SVG, all stroke/fill via currentColor so callers can
 * tint with Tailwind text-* utilities. Ported from `.bn-design/shared.jsx`'s
 * Icon object. Keep glyph parity with the design source — design tweaks land
 * in both places.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function svg(size: number | undefined, props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
	return {
		width: size,
		height: size,
		...props,
	};
}

const stroke = (paths: React.ReactNode, strokeWidth = 2) =>
	function StrokeIcon({ size = 16, ...rest }: IconProps) {
		return (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
				focusable="false"
				{...svg(size, rest)}
			>
				{paths}
			</svg>
		);
	};

const filled = (paths: React.ReactNode) =>
	function FilledIcon({ size = 16, ...rest }: IconProps) {
		return (
			<svg
				viewBox="0 0 24 24"
				fill="currentColor"
				aria-hidden="true"
				focusable="false"
				{...svg(size, rest)}
			>
				{paths}
			</svg>
		);
	};

export const Icon = {
	search: stroke(
		<>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</>,
	),
	plus: stroke(<path d="M12 5v14M5 12h14" />, 2.4),
	close: stroke(<path d="M6 6l12 12M18 6 6 18" />),
	// 相框 + 太阳 + 远山 —— 聊天输入框的「加图片」用它。
	image: stroke(
		<>
			<rect x="3" y="4" width="18" height="16" rx="2.5" />
			<circle cx="8.5" cy="9.5" r="1.6" />
			<path d="m4 17 4.5-4.5 3.5 3.5 3-2.5L20 18" />
		</>,
	),
	bell: filled(
		<path d="M12 2a6 6 0 0 0-6 6v3.5l-2 3.5h16l-2-3.5V8a6 6 0 0 0-6-6Zm-2 17a2 2 0 1 0 4 0Z" />,
	),
	live: filled(
		<path d="M3 6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v3l4-2v10l-4-2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />,
	),
	dyn: filled(<path d="M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3Zm1 0v8h8a9 9 0 0 0-8-8Z" />),
	sc: filled(
		<path d="M12 2 4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4Zm0 4 4 2v4c0 3-2 5-4 6-2-1-4-3-4-6V8l4-2Z" />,
	),
	guard: filled(<path d="M12 1 3 5v7c0 5 4 9 9 11 5-2 9-6 9-11V5l-9-4Z" />),
	check: stroke(<path d="m5 12 5 5L20 7" />, 3),
	/**
	 * 裸感叹号笔画 —— 跟 {@link Icon.check} 配对，供嵌进圆底徽章里当状态标记。
	 * 别退回文本字符 `!`：`!` 的墨迹只占 baseline 以上，行盒下方那截 descender
	 * 空白照样算进垂直居中，圆里看着就是整体往上偏一截（而且偏多少还随字体变）。
	 * 这里墨迹上下沿是 3.5 / 20.5，对 viewBox 严格对称，缩到什么尺寸都在正中。
	 * 三角警告牌是另一种语义，用 {@link Icon.warning}。
	 */
	exclaim: stroke(
		<>
			<path d="M12 5v9.5" />
			<path d="M12 19h.01" />
		</>,
		3,
	),
	download: stroke(
		<>
			<path d="M12 3v11m0 0 4-4m-4 4-4-4" />
			<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
		</>,
	),
	edit: stroke(<path d="M14 4l6 6L9 21H3v-6L14 4Z" />),
	trash: stroke(
		<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6" />,
	),
	refresh: stroke(
		<>
			<path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
			<path d="M21 3v5h-5" />
		</>,
	),
	ai: filled(<path d="M12 2 14 9l7 2-7 2-2 7-2-7-7-2 7-2 2-7Z" />),
	filter: stroke(<path d="M3 5h18l-7 9v6l-4-2v-4L3 5Z" />),
	qq: filled(
		<path d="M12 2c-3.5 0-6 2.5-6 6 0 1.5.4 2.8 1 3.8-1.5 2-2.5 4-2.5 6 0 .5.4 1 1 1l2-1c.4 1 1.4 2 2.5 2 0 0 .5 1 2 1s2-1 2-1c1.1 0 2.1-1 2.5-2l2 1c.6 0 1-.5 1-1 0-2-1-4-2.5-6 .6-1 1-2.3 1-3.8 0-3.5-2.5-6-6-6Z" />,
	),
	discord: filled(
		<path d="M19 5c-1.5-.7-3-1.2-4.7-1.5l-.2.4a13 13 0 0 0-4.2 0L9.7 3.5C8 3.8 6.5 4.3 5 5 2.4 9 1.7 12.7 2 16.4c2 1.5 4 2.4 5.8 3l.5-.6c-.7-.3-1.3-.6-1.9-1l.5-.4a13 13 0 0 0 10.3 0l.5.4c-.6.4-1.2.7-1.9 1l.5.6c1.9-.6 3.8-1.5 5.8-3 .4-4.3-.6-7.9-2.6-11.5ZM9 14.4c-1 0-1.9-1-1.9-2.2 0-1.1.8-2.2 1.9-2.2 1 0 1.9 1 1.9 2.2 0 1.2-.8 2.2-1.9 2.2Zm6 0c-1 0-1.9-1-1.9-2.2 0-1.1.8-2.2 1.9-2.2 1 0 1.9 1 1.9 2.2 0 1.2-.8 2.2-1.9 2.2Z" />,
	),
	telegram: filled(<path d="m22 3-20 8 6 2 2 7 3-4 5 4 4-17ZM10 14l8-6-6 7-2-1Z" />),
	eye: stroke(
		<>
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
			<circle cx="12" cy="12" r="3" />
		</>,
	),
	chat: stroke(<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8l-4 4V6a1 1 0 0 1 1-1Z" />),
	gift: stroke(
		<>
			<path d="M3 9h18v4H3z" />
			<path d="M5 13v8h14v-8M12 9v12" />
			<path d="M12 9c-2 0-4-1-4-3s2-3 4 0c2-3 4-2 4 0s-2 3-4 3Z" />
		</>,
	),
	user: stroke(
		<>
			<circle cx="12" cy="8" r="4" />
			<path d="M4 21a8 8 0 0 1 16 0" />
		</>,
	),
	star: filled(<path d="m12 2 3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1 3-7Z" />),
	heart: filled(<path d="M12 21s-8-5-8-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6-8 11-8 11h-2Z" />),
	mic: stroke(
		<>
			<rect x="9" y="3" width="6" height="12" rx="3" />
			<path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
		</>,
	),
	list: stroke(<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />),
	anchor: stroke(
		<>
			<circle cx="12" cy="4" r="2" />
			<path d="M12 6v15M7 11h10M5 14a7 7 0 0 0 14 0" />
		</>,
	),
	sparkle: stroke(<path d="M12 2v6m0 8v6M2 12h6m8 0h6M5 5l4 4m6 6 4 4M5 19l4-4m6-6 4-4" />),
	fire: filled(
		<path d="M12 2c2 5 6 6 6 12a6 6 0 0 1-12 0c0-3 1-4 2-5 0 2 1 3 2 3 0-4 1-7 2-10Z" />,
	),
	drag: filled(
		<>
			<circle cx="9" cy="6" r="1.5" />
			<circle cx="15" cy="6" r="1.5" />
			<circle cx="9" cy="12" r="1.5" />
			<circle cx="15" cy="12" r="1.5" />
			<circle cx="9" cy="18" r="1.5" />
			<circle cx="15" cy="18" r="1.5" />
		</>,
	),
	link: stroke(
		<>
			<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
			<path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
		</>,
	),
	sliders: stroke(
		<>
			<line x1="4" y1="6" x2="20" y2="6" />
			<line x1="4" y1="12" x2="20" y2="12" />
			<line x1="4" y1="18" x2="20" y2="18" />
			<circle cx="9" cy="6" r="2" />
			<circle cx="15" cy="12" r="2" />
			<circle cx="9" cy="18" r="2" />
		</>,
	),
	logout: stroke(
		<>
			<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
			<path d="M16 17l5-5-5-5" />
			<path d="M21 12H9" />
		</>,
	),
	// 以下五个是为了替掉界面上当图标用的 emoji（⚠ ☐ ✂ 🕊️ 🏆）。emoji 的长相由
	// 系统字体决定 —— 同一处警告在 macOS 是黄底黑感叹号、在 Windows 是另一副样子、
	// 在缺字体的 Linux 上直接是豆腐块，而且彩色 emoji 混在单色图标里也不成体系。
	warning: stroke(
		<>
			<path d="M12 3.2 1.8 20.8h20.4L12 3.2Z" />
			<path d="M12 10v4" />
			<path d="M12 17.2h.01" />
		</>,
	),
	/** 空心方框 —— 与 {@link Icon.check} 配对表示「未选中」。 */
	square: stroke(<rect x="4" y="4" width="16" height="16" rx="3" />),
	scissors: stroke(
		<>
			<circle cx="6" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
			<path d="M20 4 8.12 15.88" />
			<path d="M14.47 14.48 20 20" />
			<path d="M8.12 8.12 12 12" />
		</>,
	),
	/** 羽毛 —— 鸽王。与卡片模板 `SVG_FEATHER` 同一套语义，别只改一边。 */
	feather: stroke(
		<>
			<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" />
			<path d="M16 8 2 22" />
			<path d="M17.5 15H9" />
		</>,
	),
	/**
	 * 侧栏收起 / 展开 —— 一个面板框加一根竖分隔线,箭头指向动作方向。
	 * 两个是**镜像**关系而非同一个图标转 180°:框和分隔线的位置不动,只有箭头掉头,
	 * 转整个图标会把分隔线也甩到另一边,看着像换了个部件。
	 */
	panelCollapse: stroke(
		<>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M9 3v18" />
			<path d="m16 15-3-3 3-3" />
		</>,
	),
	panelExpand: stroke(
		<>
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M9 3v18" />
			<path d="m14 9 3 3-3 3" />
		</>,
	),
	/** 齿轮 —— 设置。与 {@link Icon.sliders}(参数调节)不同语义,别混用。 */
	gear: stroke(
		<>
			<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
			<circle cx="12" cy="12" r="3" />
		</>,
	),
	/** 左箭头 —— 返回上一层。 */
	arrowLeft: stroke(
		<>
			<path d="M19 12H5" />
			<path d="M12 19l-7-7 7-7" />
		</>,
	),
	/** 上箭头 —— 聊天发送键。朝上而非朝右,与主流对话框一致。 */
	arrowUp: stroke(<path d="M12 19V6M6 12l6-6 6 6" />, 2.4),
	/** 奖杯 —— 勤奋 UP。与卡片模板 `SVG_TROPHY` 同一套语义。 */
	trophy: stroke(
		<>
			<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
			<path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
			<path d="M4 22h16" />
			<path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
			<path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
			<path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
		</>,
	),
} as const;

export type IconName = keyof typeof Icon;
