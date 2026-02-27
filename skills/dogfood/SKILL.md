---
name: dogfood
description: Systematic exploratory QA for web apps using human-browser on a logged-in personal Chrome profile. Produces a reproducible markdown report with evidence screenshots.
allowed-tools: Bash(human-browser:*)
---

# Dogfood for human-browser

Use this skill when asked to dogfood, QA, exploratory test, bug hunt, or quality review a web app.

This workflow is optimized for `human-browser`, so it can reuse the user's real logged-in profile and test authenticated flows reliably.

## Inputs

Required:
- Target URL

Optional:
- Scope (for example: "billing only", "onboarding only")
- Output directory (default: `./dogfood-output`)
- Session label (default: target host slug + timestamp)

## Output contract

Always produce:
- `report.md` (structured issue report)
- `screenshots/` (evidence PNG files)
- `logs/console.ndjson` (console evidence)
- `logs/network.ndjson` (network evidence)

No issue should be reported without evidence path(s) and repro steps.

## Setup

Create output paths and initialize report:

```bash
OUTPUT_DIR="${OUTPUT_DIR:-./dogfood-output}"
SESSION_LABEL="${SESSION_LABEL:-$(date +%Y%m%d-%H%M%S)}"
RUN_DIR="$OUTPUT_DIR/$SESSION_LABEL"
mkdir -p "$RUN_DIR/screenshots" "$RUN_DIR/logs"
cp skills/dogfood/templates/dogfood-report-template.md "$RUN_DIR/report.md"
```

Open target and stabilize:

```bash
human-browser open "$TARGET_URL"
human-browser wait --load networkidle --timeout 20000
```

Start log capture:

```bash
human-browser console start
human-browser network start
```

## Exploration loop

For each major page or feature area:

1. Take snapshot
```bash
human-browser --json snapshot --interactive --compact --depth 4 > "$RUN_DIR/logs/snapshot-$(date +%H%M%S).json"
```

2. Take baseline screenshot
```bash
human-browser screenshot "$RUN_DIR/screenshots/page-$(date +%H%M%S).png" --full
```

3. Exercise key user actions
- Navigation
- Create / edit / delete flows
- Form validation
- Empty and error states

4. Check runtime evidence
```bash
human-browser --json console dump --clear >> "$RUN_DIR/logs/console.ndjson"
human-browser --json network dump --clear >> "$RUN_DIR/logs/network.ndjson"
```

## Repro-first issue documentation

When an issue appears, stop and document immediately.

For each issue:

1. Capture evidence screenshots:
- before action
- action result (broken state)

2. Record exact repro steps in report.

3. Append issue entry to `report.md` using this minimum shape:
- ID
- Severity (`critical`, `high`, `medium`, `low`)
- Area/page
- Repro steps
- Expected result
- Actual result
- Evidence paths

Example evidence commands:

```bash
human-browser screenshot "$RUN_DIR/screenshots/issue-003-step-1.png"
human-browser screenshot "$RUN_DIR/screenshots/issue-003-result.png" --full
human-browser --json console dump --clear >> "$RUN_DIR/logs/console.ndjson"
```

## Ref-safe interactions

If using refs (`@e1`, `e1`, `ref=e1`), always bind actions to the same snapshot:

```bash
human-browser --json snapshot --interactive > "$RUN_DIR/logs/current-snapshot.json"
# Read snapshot_id from the JSON file, then:
human-browser click @e1 --snapshot <snapshot_id>
human-browser fill @e2 "value" --snapshot <snapshot_id>
```

If you hit `STALE_SNAPSHOT`, take a fresh snapshot and retry with the new `snapshot_id`.

## Wrap up

Stop collectors and finalize:

```bash
human-browser --json console dump --clear >> "$RUN_DIR/logs/console.ndjson"
human-browser --json network dump --clear >> "$RUN_DIR/logs/network.ndjson"
human-browser console stop
human-browser network stop
```

Update report summary with:
- total issues
- severity breakdown
- top 3 risks
- recommended next fixes

Then return:
- run directory path
- issue count summary
- highest severity findings

