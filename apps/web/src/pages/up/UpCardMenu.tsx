import { Icon } from "@bilibili-notify/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface UpCardMenuProps {
	/** 订阅当前是否启用,决定开关项文案(禁用 / 启用)。 */
	enabled: boolean;
	/** 浮层左上角坐标(已由 computeMenuPosition 算好翻转 / clamp)。 */
	x: number;
	y: number;
	onClose: () => void;
	onEdit: () => void;
	onToggleEnabled: () => void;
	onCopyUid: () => void;
	onAddToGroup: () => void;
	onDelete: () => void;
}

interface MenuItemDef {
	key: string;
	label: string;
	icon: ReactNode;
	onSelect: () => void;
	danger?: boolean;
}

export function UpCardMenu({
	enabled,
	x,
	y,
	onClose,
	onEdit,
	onToggleEnabled,
	onCopyUid,
	onAddToGroup,
	onDelete,
}: UpCardMenuProps) {
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
		{ key: "edit", label: "编辑详情", icon: <Icon.edit size={14} />, onSelect: onEdit },
		{
			key: "toggle",
			label: enabled ? "禁用订阅" : "启用订阅",
			icon: <Icon.bell size={14} />,
			onSelect: onToggleEnabled,
		},
		{ key: "copy", label: "复制 UID", icon: <Icon.link size={14} />, onSelect: onCopyUid },
		{ key: "group", label: "编辑分组", icon: <Icon.list size={14} />, onSelect: onAddToGroup },
		{
			key: "delete",
			label: "删除订阅",
			icon: <Icon.trash size={14} />,
			onSelect: onDelete,
			danger: true,
		},
	];

	return createPortal(
		<div
			ref={menuRef}
			role="menu"
			style={{ position: "fixed", left: x, top: y, zIndex: 60 }}
			data-bn="glass-strong"
			className="min-w-40 overflow-hidden rounded-lg border border-bn-border bg-bn-surface py-1 shadow-bn-elev"
		>
			{items.map((it) => (
				<button
					key={it.key}
					type="button"
					role="menuitem"
					onClick={() => {
						it.onSelect();
						onClose();
					}}
					className={`flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left text-[13px] transition hover:bg-bn-surface-muted ${
						it.danger ? "text-bn-danger-text" : "text-bn-text-primary"
					}`}
				>
					<span className={it.danger ? "text-bn-danger-text" : "text-bn-text-secondary"}>
						{it.icon}
					</span>
					{it.label}
				</button>
			))}
		</div>,
		document.body,
	);
}
