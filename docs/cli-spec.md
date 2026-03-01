# CLI Spec (`human-browser`)

## Global options

- `--json`: machine-friendly JSON output
- `--config <path>`: config file path (default: `~/.human-browser/config.json`)
- `--timeout <ms>`: daemon command timeout (default: `10000`)
- `--queue-mode hold|fail`: behavior when extension is offline
  - `hold`: wait for reconnect until timeout
  - `fail`: immediately return `DISCONNECTED`

## Commands

- `human-browser init [--host 127.0.0.1] [--port 18765] [--max-events 500] [--force] [--show-token]`
  - creates config with shared token
  - `--force` で再初期化しても既存 token は維持される（daemon との token 不整合防止）
- `human-browser ws [--show-token]`
  - prints websocket endpoint (`token` is hidden unless `--show-token` is specified)
- `human-browser rotate-token [--show-token]`
  - rotates shared token in config
  - 実行後は daemon再起動と拡張のtoken更新が必要
- `human-browser daemon`
  - starts local daemon
- `human-browser status`
  - connection/session status
- `human-browser tabs`
  - list tabs from extension
- `human-browser diff snapshot [--baseline <file>] [--selector <sel>] [--compact] [--depth <n>]`
  - 現在のsnapshotと比較対象（前回snapshotまたは baseline ファイル）を行単位でdiff
- `human-browser diff screenshot --baseline <file> [--output <file>] [--threshold <0-1>] [--selector <sel>] [--full]`
  - 現在のスクリーンショットを baseline 画像とピクセル比較
- `human-browser diff url <url1> <url2> [--screenshot] [--full] [--wait-until <load|domcontentloaded|networkidle>] [--selector <sel>] [--compact] [--depth <n>]`
  - 2 URL を順に開いて snapshot diff（必要なら screenshot diff も）を返す
- `human-browser use <active|tab_id>`
  - select target tab
- `human-browser snapshot [--tab <active|tab_id>] [--interactive] [--cursor] [--compact] [--depth <N>] [--selector <css>]`
  - returns deterministic tree with refs and `snapshot_id`
  - default is full-context snapshot (content + interactive). `--interactive` narrows output to interactive candidates only.
- `human-browser click <selector|@ref> [--snapshot <snapshot_id>] [--nth <index|-1>]`
- `human-browser fill <selector|@ref> <value> [--snapshot <snapshot_id>] [--nth <index|-1>]`
  - ref (`@eN`/`ref=eN`/`eN`) を使う場合は `--snapshot` 必須
  - `--nth` で同一selectorの一致候補を選択（`0`始まり、`-1` は末尾）
  - `input[type=file]` を対象にする場合は `<value>` にローカルファイルパスを渡す
- `human-browser keypress <key> [--tab <active|tab_id>]`
- `human-browser scroll <x> <y> [--tab <active|tab_id>]`
- `human-browser navigate <url> [--tab <active|tab_id>]`
- `human-browser open <url> [--tab <active|tab_id>]`
- `human-browser close [--tab <active|tab_id>]`
- `human-browser hover <selector|@ref> [--snapshot <snapshot_id>]`
- `human-browser screenshot [selector] [path] [--full] [--tab <active|tab_id>]`
- `human-browser pdf <path> [--tab <active|tab_id>]`
- `human-browser eval <javascript> [--tab <active|tab_id>]`
- `human-browser get text <selector|@ref> [--snapshot <snapshot_id>]`
- `human-browser get value <selector|@ref> [--snapshot <snapshot_id>]`
- `human-browser get html [selector|@ref] [--snapshot <snapshot_id>]`
- `human-browser wait <selector|milliseconds> [--timeout <ms>] [--tab <active|tab_id>]`
- `human-browser wait --text <text> [--timeout <ms>] [--tab <active|tab_id>]`
- `human-browser wait --url <pattern> [--timeout <ms>] [--tab <active|tab_id>]`
- `human-browser wait --load <load|domcontentloaded|networkidle> [--timeout <ms>] [--tab <active|tab_id>]`
- `human-browser wait --fn <expression> [--timeout <ms>] [--tab <active|tab_id>]`
- `human-browser cookies [get]`
- `human-browser cookies set <name> <value> [--url <url>]`
- `human-browser cookies delete <name> [--url <url>]`
- `human-browser cookies clear`
- `human-browser network start|stop [--tab <active|tab_id>]`
- `human-browser network dump|requests [--filter <text>] [--clear] [--tab <active|tab_id>]`
- `human-browser console [start|stop|dump] [--clear] [--tab <active|tab_id>]`
- `human-browser record start <path.webm> [--tab <active|tab_id>] [--fps <1-30>]`
  - 定期的に screenshot を取得して録画を開始（`ffmpeg` 必須）
- `human-browser record stop`
  - 録画を停止し、`.webm` を保存
- `human-browser record restart <path.webm> [--tab <active|tab_id>] [--fps <1-30>]`
  - 現在の録画を停止して新しい録画を開始
- `human-browser reconnect`
  - request bridge reconnect
- `human-browser reset`
  - drop session snapshot and request extension reset
- `human-browser diagnose [--limit <N>]`
  - recent events/disconnect/reconnect history

## Error model

All errors are structured:

```json
{
  "ok": false,
  "error": {
    "code": "STALE_SNAPSHOT",
    "message": "Snapshot mismatch...",
    "details": {},
    "recovery": {
      "next_command": "human-browser snapshot",
      "reconnect_required": false,
      "reset_session_recommended": false
    }
  }
}
```

Core codes:

- `DISCONNECTED`
- `TIMEOUT` (`details.phase`: `wait_for_extension` / `extension_response`)
- `NO_SUCH_REF`
- `STALE_SNAPSHOT`
- `NO_ACTIVE_SNAPSHOT`
- `EXTENSION_ERROR`
- `BAD_REQUEST`
- `UNAUTHORIZED`
- `INTERNAL`
