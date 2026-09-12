# Triage Labels

Three axes. Every issue carries **exactly one** status label; type and area labels are optional and area can repeat.

## Status (exactly one, mutually exclusive)

The skills speak in terms of five canonical triage roles; this table maps them to our label strings.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

`needs-triage` is applied automatically when an issue is opened (`.github/workflows/issue-triage.yml`, runs from the default branch). Moving an issue along means **replacing** the status label, not adding a second one.

## Type (optional, usually one)

GitHub defaults, kept as they are: `bug`, `enhancement`, `question`, `documentation`, `duplicate`. `invalid`, `good first issue` and `help wanted` were removed — a single-maintainer project never used them; "invalid" is just `wontfix`.

## Area (optional, repeatable, `area:` prefix)

Cut by product surface, not by source directory:

| Label            | Covers                                                      |
| ---------------- | ----------------------------------------------------------- |
| `area:push`      | Push delivery and bot connections (OneBot, official QQ bot) |
| `area:live`      | Live stream monitoring and cards                            |
| `area:dynamic`   | Dynamic feed monitoring and cards                           |
| `area:extension` | Extensions, marketplace, bridge and thin plugins            |
| `area:update`    | In-app self-update                                          |
| `area:desktop`   | Desktop app (macOS / Windows)                               |
| `area:docker`    | Docker image and deployment                                 |
| `area:web`       | Dashboard UI                                                |

## Creating labels

All labels exist in the repo today. Descriptions are English. To recreate from scratch:

```bash
gh label create needs-triage    --color "fbca04" --description "Maintainer needs to evaluate"
gh label create needs-info      --color "d4c5f9" --description "Waiting on reporter for more information"
gh label create ready-for-agent --color "0e8a16" --description "Fully specified, AFK-ready"
gh label create ready-for-human --color "1d76db" --description "Needs human implementation"
for a in push live dynamic extension update desktop docker web; do
  gh label create "area:$a" --color "c2e0c6" --description "<see table above>"
done
```
