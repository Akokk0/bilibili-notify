// Vue 3 JSX 类型与 react-jsx transform 的兼容补丁：
// 使用 react-jsx 模式时，子节点以 children prop 传递，
// 但 Vue 的 HTMLAttributes 未声明此属性，需手动增强。
export {};

declare module "@vue/runtime-dom" {
	interface HTMLAttributes {
		children?: unknown;
	}
	interface SVGAttributes {
		children?: unknown;
	}
}
