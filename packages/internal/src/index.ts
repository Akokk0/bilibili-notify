/**
 * internal 的根入口 —— 领域值的本体都在各领域文件,这里只放转出语句。
 */

export * from "./ai";
export * from "./ai-tool";
export * from "./auth-state";
export * from "./card-skin";
export * from "./devtools";
export * from "./features";
export * from "./format";
export * from "./history";
export * from "./http";
export * from "./identity";
export * from "./image-ref";
export * from "./key-value-store";
export * from "./link-preview";
export * from "./live";
export * from "./live-monitor";
export * from "./membership";
export * from "./platform";
export * from "./platform-descriptor";
export * from "./post";
export * from "./problem";
/**
 * 推送源契约 —— 核心的三个 adapter 与拓展的桥都实现它。见 `push-source.ts` 的文件头。
 */
export {
	type AddressCandidate,
	type ConnectionAuth,
	type ConnectionCandidate,
	type InboundGroupMessage,
	type InboundHandlers,
	type InboundMeta,
	type InboundPrivateMessage,
	inboundIdentity,
	type PlatformAdapter,
	type PlatformAdapterContext,
	type PlatformAdapterDescriptor,
	type ProbeResult,
} from "./push-source";
export * from "./push-target";
export * from "./result";
export * from "./schema";
export * from "./settings-field";
export * from "./source";
export * from "./timezone";
export * from "./update";
export * from "./util";
