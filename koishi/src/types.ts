import type { SubscriptionOp } from "@bilibili-notify/internal";

// Re-export the new canonical SubscriptionOp type for downstream consumers.
export type { SubscriptionOp };

// Legacy aliases kept for koishi event typing compatibility.
// Downstream packages that previously imported SubChange/SubscriptionOp from here
// now get the new platform-neutral SubscriptionOp.
