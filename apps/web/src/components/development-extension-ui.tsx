import { type ComponentType, createContext, useContext } from "react";

/** 页面只声明两个插槽；实现仍由App唯一的开发入口提供。 */
export interface DevelopmentMountNoteProps {
	id: string;
	linkedTo?: string;
	onUnmount?: () => void;
}

export interface DevelopmentExtensionUi {
	Button: ComponentType;
	Note: ComponentType<DevelopmentMountNoteProps>;
}

export const DevelopmentExtensionUiContext = createContext<DevelopmentExtensionUi | null>(null);

export function DevelopmentMountButtonSlot() {
	const ui = useContext(DevelopmentExtensionUiContext);
	return ui ? <ui.Button /> : null;
}

export function DevelopmentMountNoteSlot(props: DevelopmentMountNoteProps) {
	const ui = useContext(DevelopmentExtensionUiContext);
	return ui ? <ui.Note {...props} /> : null;
}
