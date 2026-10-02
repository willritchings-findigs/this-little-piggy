"""Anthropic wrapper. Two execution paths sharing one request builder:
  sync  : call_tool()            — calibration / small runs / retries (prompt caching on the static system block)
  batch : submit_batch()/collect_batch() — production runs via the Message Batches API (lower cost, no client-side rate limiting)
Static system prompt + tool schema are identical across requests, so they are marked for prompt caching.
Requires ANTHROPIC_API_KEY. Confirm current batch pricing/limits and model strings at https://docs.claude.com before the production run."""
import json, os, time
import anthropic, jsonschema
from config import CODED

_client = None
def client():
    global _client
    if _client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY not set. Add it to .env, or use the agent-mode fallback in CLAUDE_CODE_PROMPT.md.")
        _client = anthropic.Anthropic()
    return _client

def split_template(template):
    static, user = template.split("<!-- USER_MESSAGE -->", 1)
    return static.strip(), user.strip()

def build_params(system_static, user_text, schema, tool_name, model, max_tokens=8000):
    return {"model": model, "max_tokens": max_tokens, "temperature": 0,
            "system": [{"type": "text", "text": system_static, "cache_control": {"type": "ephemeral"}}],
            "tools": [{"name": tool_name, "description": "Record the structured coding.", "input_schema": schema}],
            "tool_choice": {"type": "tool", "name": tool_name},
            "messages": [{"role": "user", "content": user_text}]}

def _extract(msg, schema):
    block = next(b for b in msg.content if b.type == "tool_use")
    jsonschema.validate(block.input, schema)
    u = msg.usage
    return block.input, {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
                         "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0, "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0}

def call_tool(params, schema, retries=5):
    last = None
    for attempt in range(retries):
        try:
            return _extract(client().messages.create(**params), schema)
        except (anthropic.RateLimitError, anthropic.APIStatusError, anthropic.APIConnectionError) as e:
            last = e; time.sleep(min(60, 2 ** attempt * 3))
        except (jsonschema.ValidationError, StopIteration) as e:
            last = e
            params = dict(params)
            params["messages"] = [{"role": "user", "content": params["messages"][0]["content"] + f"\n\nYour previous output failed schema validation: {str(e)[:300]}. Fix it."}]
    raise RuntimeError(f"LLM call failed after {retries} attempts: {last}")

# ---------------- Batch API ----------------
def _state(tag): return CODED / f"batch_{tag}.json"

def submit_batch(tag, requests, chunk=5000):
    """requests: list of (custom_id, params). Writes batch ids to data/coded/batch_<tag>.json (resumable)."""
    st = json.loads(_state(tag).read_text()) if _state(tag).exists() else {"batches": []}
    for i in range(0, len(requests), chunk):
        part = requests[i:i + chunk]
        b = client().messages.batches.create(requests=[{"custom_id": cid, "params": p} for cid, p in part])
        st["batches"].append({"id": b.id, "n": len(part)}); _state(tag).write_text(json.dumps(st, indent=1))
        print(f"[ok] submitted batch {b.id} ({len(part)} requests)")
    return st

def collect_batch(tag, schema, on_result, poll_seconds=60):
    """Polls until all batches for `tag` end, then calls on_result(custom_id, coding, usage) for each valid result.
    Returns list of custom_ids that failed (API error or schema-invalid) for sync retry."""
    st = json.loads(_state(tag).read_text()); failed = []
    for b in st["batches"]:
        while True:
            info = client().messages.batches.retrieve(b["id"])
            if info.processing_status == "ended": break
            print(f"  batch {b['id']}: {info.request_counts}"); time.sleep(poll_seconds)
        for r in client().messages.batches.results(b["id"]):
            if r.result.type != "succeeded": failed.append(r.custom_id); continue
            try:
                coding, usage = _extract(r.result.message, schema); on_result(r.custom_id, coding, usage)
            except Exception:
                failed.append(r.custom_id)
    print(f"[ok] collected '{tag}'; failed/invalid: {len(failed)} (retry these with the sync path)")
    return failed
