/// <reference types="vite/client" />

// vite.config.ts 经 `define` 注入,release workflow 可用 env 覆盖源码占位版本。
declare const __WEB_VERSION__: string;
