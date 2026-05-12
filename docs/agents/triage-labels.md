# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## First-time setup

Only `wontfix` exists in this repo today. Before any skill applies the other four labels, create them once:

```bash
gh label create needs-triage    --color "fbca04" --description "Maintainer needs to evaluate"
gh label create needs-info      --color "d4c5f9" --description "Waiting on reporter for more information"
gh label create ready-for-agent --color "0e8a16" --description "Fully specified, AFK-ready"
gh label create ready-for-human --color "1d76db" --description "Needs human implementation"
```
