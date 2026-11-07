import { Icon, MenuItem } from "@bilibili-notify/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n";

export interface SubscriptionCardMenuProps {
	/** 订阅当前是否启用,决定开关项文案(禁用 / 启用)。 */
	enabled: boolean;
	/** 浮层左上角坐标(已由 computeMenuPosition 算好翻转 / clamp)。 */
	x: number;
	y: number;
	onClose: () => void;
	onEdit: () => void;
	onToggleEnabled: () => void;
	/** Copies the source's original external id. */
	onCopyExternalId: () => void;
	copyLabel: string;
	/** 编辑这条订阅挂的标签(ADR-0034)。 */
	onEditTags: () => void;
	onDelete: () => void;
}

interface MenuItemDef {
	key: string;
	label: string;
	icon: ReactNode;
	onSelect: () => void;
	danger?: boolean;
}

export function SubscriptionCardMenu({
	enabled,
	x,
	y,
	onClose,
	onEdit,
	onToggleEnabled,
	onCopyExternalId,
	copyLabel,
	onEditTags,
	onDelete,
}: SubscriptionCardMenuProps) {
	const tx = useT();
	const menuRef = useRef<HTMLDivElement>(null);

	// Esc 关闭。
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	// 菜单外按下关闭(点内不关)。
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [onClose]);

	const items: MenuItemDef[] = [
		{
			key: "edit",
			label: tx("sourceUi.pages.up.UpCardMenu.label.1"),
			icon: <Icon.edit size={14} />,
			onSelect: onEdit,
		},
		{
			key: "toggle",
			label: enabled
				? tx("sourceUi.pages.up.UpCardMenu.label.2")
				: tx("sourceUi.pages.up.UpCardMenu.label.3"),
			icon: <Icon.bell size={14} />,
			onSelect: onToggleEnabled,
		},
		{ key: "copy", label: copyLabel, icon: <Icon.link size={14} />, onSelect: onCopyExternalId },
		{
			key: "tags",
			label: tx("sourceUi.pages.up.UpCardMenu.label.5"),
			icon: <Icon.list size={14} />,
			onSelect: onEditTags,
		},
		{
			key: "delete",
			label: tx("sourceUi.pages.up.UpCardMenu.label.6"),
			icon: <Icon.trash size={14} />,
			onSelect: onDelete,
			danger: true,
		},
	];

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			// inline 只留运行时坐标 —— 层级归分层表管。
			style={{ position: "fixed", left: x, top: y }}
			data-bn="glass-strong"
			className="z-bn-menu min-w-40 overflow-hidden rounded-lg border border-bn-border bg-bn-surface py-1 shadow-bn-elev"
		>
			{items.map((it) => (
				<MenuItem
					key={it.key}
					role="menuitem"
					danger={it.danger}
					icon={it.icon}
					onClick={() => {
						it.onSelect();
						onClose();
					}}
				>
					{it.label}
				</MenuItem>
			))}
		</div>,
		document.body,
	);
}
