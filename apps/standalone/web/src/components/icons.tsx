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
} as const;

export type IconName = keyof typeof Icon;
