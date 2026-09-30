# Activity API — `POST /api/activity`

Any program can tell memglow what an AI agent just did with a note: an agent framework, a custom
tool, a script, a plugin for an editor memglow has no adapter for. The ready-made adapters
(`adapters/`) and the MCP proxy (`mcp-proxy/`) use exactly this endpoint.

## Enable it

The endpoint exists only when the server has a token of 32 characters or more:

```bash
export MEMGLOW_TOKEN=$(openssl rand -hex 32)      # memglow init writes one to ~/.memglow/token
MEMORY_DIR=~/notes npx github:R0zumnik/memglow
```

Without `MEMGLOW_TOKEN`, or with a missing or wrong token, the endpoint answers the same `404` as
any unknown URL: it does not reveal itself.

## Request

```
POST /api/activity
Authorization: Bearer <MEMGLOW_TOKEN>
Content-Type: application/json

{ "type": "read", "ids": ["alice", "people/bob.md"], "source": "my-agent" }
```

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | `read`, `search` or `write` — the colour of the flash (cyan, violet, red-orange) |
| `ids` | yes | note references (also accepted as `slugs`); see below |
| `source` | no | label shown in the live journal: `a-z`, `0-9`, `-`, 1 to 20 characters (else `agent`) |
| `demo` | no | `true`: animate the page but keep the event out of the history and out of the Memory cost counts |

**Note references.** Each id is reduced to a note name: the last path segment, without `.md`
(`people/bob.md`, `memory://people/bob` and `bob` all mean the note `bob.md`). `snake_case` and
upper case are also tried as kebab-case. Ids that match no existing note are dropped, so sending a
wrong or made-up id is harmless. At most 50 ids are read and 20 kept.

**Never send content.** Only names are needed; memglow never needs the text of a note, a prompt
or a tool result.

## Responses

| Status | Meaning |
|---|---|
| `204` | accepted: the notes light up in every open viewer |
| `202` | valid request but nothing to show (no known note, or unknown `type`) |
| `400` | body is not JSON |
| `404` | endpoint disabled, or missing / wrong token |
| `413` | body larger than 4 KB |
| `429` | more than 30 events per second (all senders together) |

## Examples

### curl

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $(cat ~/.memglow/token)" \
  -H 'Content-Type: application/json' \
  -d '{"type":"write","ids":["project-roadmap"],"source":"curl"}' \
  http://127.0.0.1:4747/api/activity
```

### Python (standard library only)

```python
import json, pathlib, urllib.request

def memglow(kind, ids, source="python", url="http://127.0.0.1:4747"):
    token = (pathlib.Path.home() / ".memglow" / "token").read_text().strip()
    req = urllib.request.Request(
        url + "/api/activity",
        data=json.dumps({"type": kind, "ids": ids, "source": source}).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=3).close()
    except Exception:
        pass  # never let the viewer disturb the agent

memglow("search", ["alice", "project-roadmap"])
```

### Node.js (18+, no dependency)

```js
const fs = require("fs");
const os = require("os");
const path = require("path");

async function memglow(type, ids, source = "node", url = "http://127.0.0.1:4747") {
  const token = fs.readFileSync(path.join(os.homedir(), ".memglow", "token"), "utf8").trim();
  try {
    await fetch(url + "/api/activity", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ type, ids, source }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* never let the viewer disturb the agent */ }
}

memglow("read", ["alice"]);
```

## Good practice for a hook

- **Never block the agent.** Send in the background (or with a short timeout) and ignore every
  error; memglow being down must change nothing. The bundled adapters spawn a detached sender
  that gives up after 3 s.
- **Print nothing** unless the agent requires an answer on stdout.
- **Keep the token out of logs and command lines**: read it from `~/.memglow/token` or an
  environment variable.
- If you only need writes, you may not need a hook at all: memglow already notices every note
  whose body changes on disk (see [Works with](../README.md#works-with)). Such a write is counted
  in Memory cost too; if your hook reports the same write within 15 seconds, it is counted once.

## The saved view — `GET` / `PUT /api/view` (used by the page)

The page itself saves its view (settings, bubble layout, camera) on the instance; you do not need
this route for hooks. It is behind `MEMGLOW_PASSWORD` like the page. `GET` returns
`{ settings, positions, pinned, camera, updated }`. `PUT` takes any of these parts (a part sent
replaces the saved one; `{"reset": true}` clears the layout and keeps the settings) and answers
`204`. A `PUT` must carry `X-Memglow: 1` and an `Origin` of the same host, otherwise `403`; body
over 256 KB: `413`; not a JSON object: `400`; too many writes: `429`. Unknown settings, values out
of bounds and ids of notes that do not exist are dropped.
