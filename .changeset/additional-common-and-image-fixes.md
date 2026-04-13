---
"koishi-plugin-bilibili-notify-image": patch
"koishi-plugin-bilibili-notify-live": patch
"koishi-plugin-bilibili-notify": patch
---

feat(image): add ADDITIONAL_TYPE_COMMON (game card) renderer; fix additional render order for AV/FORWARD types; fix FORWARD double-rendering additional; improve single image layout with 长图 badge; update reserve/goods/common button to pink rounded-rectangle style; remove arrow.png

fix(live): fix word cloud and live summary not sent when AI is disabled

refactor(core): move subList to core, unify bili list/ll output style, fix bili ll race condition
