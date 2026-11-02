#!/usr/bin/env python3
"""Calculate Pi session costs with Pydantic's maintained genai-prices engine.

This module is intentionally a thin adapter. It normalizes Pi usage/provider
labels and delegates every price lookup and arithmetic operation to the pinned
``genai-prices`` package. Gateway-labeled providers retain gateway metadata;
Reader uses the same engine for API-equivalent session visibility while Page 4
keeps them on its recorded gateway-ledger path. Unknown models, invalid timestamps, and unavailable engine data remain visible
as unpriced; an expired cache continues using its last known-good data while the
feed refreshes. No local rate table or fallback formula is used.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

_ENGINE_STATE: dict[str, object] | None = None
ENGINE_TIMEOUT_SECONDS = 30
GATEWAY_PROVIDER_MARKERS = (
    "cpa",
    "sub2api",
    "cli-proxy-api",
    "cliproxy",
    "proxy-api",
)


def is_gateway_provider(provider) -> bool:
    normalized = str(provider or "").strip().lower().replace("_", "-")
    return any(marker in normalized for marker in GATEWAY_PROVIDER_MARKERS)


def value(mapping, *names, default=None):
    for name in names:
        if name in mapping and mapping[name] is not None:
            return mapping[name]
    return default


def integer(mapping, *names, default=0):
    raw = value(mapping, *names, default=default)
    try:
        result = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"token count is not an integer: {names}") from exc
    if result < 0:
        raise ValueError(f"token count cannot be negative: {names}")
    return result


def engine_cli_path() -> Path | None:
    configured = os.environ.get("PI_GENAI_PRICES_CLI", "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.extend((
        Path(__file__).resolve().parent.parent / "genai-prices" / "cli.cjs",
        Path.home() / ".agents" / "skills" / "pi-sync-maintenance" / "genai-prices" / "cli.cjs",
    ))
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def node_binary() -> str | None:
    configured = os.environ.get("PI_GENAI_PRICES_NODE", "").strip()
    if configured and Path(configured).expanduser().is_file():
        return str(Path(configured).expanduser())
    return shutil.which("node")


def _run_engine(payload=None, command="-"):
    cli = engine_cli_path()
    node = node_binary()
    if cli is None or node is None:
        return None
    try:
        completed = subprocess.run(
            [node, str(cli), command],
            input="" if command == "state" else json.dumps(payload, ensure_ascii=False),
            capture_output=True,
            text=True,
            timeout=ENGINE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    try:
        return json.loads(completed.stdout.strip())
    except (TypeError, ValueError):
        return None


def _engine_state() -> dict[str, object]:
    global _ENGINE_STATE
    if _ENGINE_STATE is not None:
        return dict(_ENGINE_STATE)
    raw = _run_engine(command="state")
    if isinstance(raw, dict):
        _ENGINE_STATE = {
            "source": raw.get("source"),
            "status": str(raw.get("status") or "unavailable"),
            "packageVersion": raw.get("packageVersion"),
            "revision": raw.get("revision"),
            "updatedAt": raw.get("updatedAt"),
            "failureReason": raw.get("failureReason"),
            "failureAt": raw.get("failureAt"),
            "available": True,
        }
    else:
        _ENGINE_STATE = {
            "source": "unavailable",
            "status": "unavailable",
            "packageVersion": None,
            "revision": None,
            "updatedAt": None,
            "failureReason": "genai-prices CLI unavailable",
            "failureAt": None,
            "available": False,
        }
    return dict(_ENGINE_STATE)


def state() -> dict[str, object]:
    return _engine_state()


def cache_path() -> Path:
    configured = os.environ.get("XDG_CACHE_HOME", "").strip()
    root = Path(configured) if configured else Path.home() / ".cache"
    return root / "pi-sync-maintenance" / "genai-prices-v2.json"


def package_version() -> str | None:
    return _engine_state().get("packageVersion")


def service_tier_for(*sources):
    """Preserve observed response tiers, then explicit tiers, then request intent."""
    for keys in (("response_service_tier",), ("serviceTier", "service_tier"), ("request_service_tier",)):
        for source in sources:
            if not isinstance(source, dict):
                continue
            for key in keys:
                tier = source.get(key)
                if isinstance(tier, str) and tier.strip():
                    return tier.strip().lower()
    return ""


def _image_usage_fields(usage):
    """Keep image partitions explicit; missing provider usage is never free."""
    if not any(key in usage for key in ("inputImage", "outputImage", "usageAvailable")):
        return {}
    fields = {key: usage.get(key, 0) for key in ("inputImage", "outputImage")}
    if any(isinstance(count, bool) or not isinstance(count, int) or count < 0 for count in fields.values()):
        return {"inputImage": 0, "outputImage": 0, "usageAvailable": False}
    return {**fields, "usageAvailable": usage.get("usageAvailable", True) is True}


def _normalized_engine_request(item):
    item = item if isinstance(item, dict) else {}
    usage = item.get("usage") or {}
    input_tokens = integer(usage, "input", "inputTokens", "input_tokens", default=0)
    cache_read_tokens = integer(usage, "cacheRead", "cachedInputTokens", "cache_read_tokens", default=0)
    cache_write_tokens = integer(usage, "cacheWrite", "cacheWriteTokens", "cache_write_tokens", default=0)
    cache_write_1h_tokens = min(
        integer(usage, "cacheWrite1h", "cacheWrite1hTokens", "cache_write_1h_tokens", default=0),
        cache_write_tokens,
    )
    output_tokens = integer(usage, "output", "outputTokens", "output_tokens", default=0)
    reasoning_tokens = integer(usage, "reasoning", "reasoningTokens", "reasoning_tokens", default=0)
    total_tokens = integer(usage, "totalTokens", "total_tokens", "tokens", default=0)
    return {
        "model": item.get("model"),
        "provider": item.get("provider"),
        "timestamp": item.get("timestamp"),
        "serviceTier": service_tier_for(item, usage),
        "usage": {
            "input": input_tokens,
            "cacheRead": cache_read_tokens,
            "cacheWrite": cache_write_tokens,
            "cacheWrite1h": cache_write_1h_tokens,
            "output": output_tokens,
            "reasoning": reasoning_tokens,
            "totalTokens": total_tokens,
            **_image_usage_fields(usage),
        },
    }


def price_usages(items):
    """Price usage records through the shared Node engine.

    Gateway labels retain billing metadata for consumers that use an
    authoritative ledger, while Reader keeps its existing API-equivalent
    estimate for session-level visibility.
    """
    requests = [_normalized_engine_request(item) for item in items]
    if not requests:
        return []
    records = _run_engine(requests)
    if not isinstance(records, list) or len(records) != len(requests):
        return [None] * len(requests)
    result = [None] * len(requests)
    for index, record in enumerate(records):
        if not isinstance(record, dict) or record.get("configured") is not True:
            continue
        if "inputImage" in requests[index]["usage"] and (record.get("rates") or {}).get("imageTokenPricing") is not True:
            continue
        tier = requests[index]["serviceTier"]
        if tier and (record.get("rates") or {}).get("serviceTier") != tier:
            continue
        cost = record.get("cost")
        if not isinstance(cost, dict):
            continue
        result[index] = {
            "cost": cost,
            "rates": record.get("rates") or {},
            "engine": record.get("engine"),
            "model": record.get("model"),
            "provider": record.get("provider"),
        }
    return result


def price_usage(
    model,
    provider,
    input_tokens=0,
    cache_read_tokens=0,
    cache_write_tokens=0,
    output_tokens=0,
    reasoning_tokens=0,
    timestamp=None,
    cache_write_1h_tokens=0,
    service_tier="",
):
    """Compatibility API backed directly by the shared Node engine."""
    return price_usages([{
        "model": model,
        "provider": provider,
        "timestamp": timestamp,
        "serviceTier": service_tier,
        "usage": {
            "input": input_tokens,
            "cacheRead": cache_read_tokens,
            "cacheWrite": cache_write_tokens,
            "cacheWrite1h": cache_write_1h_tokens,
            "output": output_tokens,
            "reasoning": reasoning_tokens,
        },
    }])[0]


def _usage_payload(input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, cache_write_1h_tokens=0):
    input_tokens = max(0, int(input_tokens or 0))
    cache_read_tokens = max(0, int(cache_read_tokens or 0))
    cache_write_tokens = max(0, int(cache_write_tokens or 0))
    return {
        "input": input_tokens,
        "cacheRead": cache_read_tokens,
        "cacheWrite": cache_write_tokens,
        "cacheWrite1h": min(max(0, int(cache_write_1h_tokens or 0)), cache_write_tokens),
        "output": max(0, int(output_tokens or 0)),
        "reasoning": max(0, int(reasoning_tokens or 0)),
        "totalTokens": input_tokens + cache_read_tokens + cache_write_tokens + max(0, int(output_tokens or 0)),
    }


def _rate_snapshot(rate_snapshots):
    if not rate_snapshots:
        state = _engine_state()
        return {
            "currency": "USD",
            "source": "",
            "priceEngine": "genai-prices",
            "priceEngineVersion": state["packageVersion"],
            "priceDataRevision": state["revision"],
            "priceTableStatus": state["status"],
            "priceTableFailureReason": state["failureReason"],
            "priceTableFailureAt": state["failureAt"],
        }
    keys = {
        (
            snap.get("priceTableId"),
            snap.get("contextTier"),
            snap.get("inputPerMillion"),
            snap.get("cachedInputPerMillion"),
            snap.get("cacheWritePerMillion"),
            snap.get("outputPerMillion"),
            snap.get("source"),
            snap.get("priceEngineVersion"),
            snap.get("priceDataRevision"),
        )
        for snap in rate_snapshots
    }
    if len(keys) == 1:
        return dict(rate_snapshots[0])
    state = _engine_state()
    sources = sorted({snap.get("source") or "" for snap in rate_snapshots if snap.get("source")})
    return {
        "currency": "USD",
        "inputPerMillion": None,
        "cachedInputPerMillion": None,
        "cacheWritePerMillion": None,
        "outputPerMillion": None,
        "source": ";".join(sources),
        "priceEngine": "genai-prices",
        "priceEngineVersion": state["packageVersion"],
        "priceDataRevision": state["revision"],
        "priceTableStatus": state["status"],
        "priceTableFailureReason": state["failureReason"],
        "priceTableFailureAt": state["failureAt"],
        "mixedRates": True,
    }


def session_search_roots():
    home = Path.home()
    roots = []
    for candidate in (
        home / "Sync" / "pi-state" / "agent" / "sessions",
        Path(os.environ.get("PI_CODING_AGENT_DIR", home / ".pi" / "agent")) / "sessions",
        Path(os.environ.get("PI_CODING_AGENT_SESSION_DIR", home / ".pi-sessions-local")),
    ):
        if candidate.exists() and candidate not in roots:
            roots.append(candidate)
    return roots


def find_current_session():
    hints = [
        os.environ.get("PI_SUBAGENT_PARENT_SESSION"),
        os.environ.get("PI_SESSION_ID"),
        os.environ.get("PI_CODING_AGENT_SESSION_ID"),
    ]
    hints = [hint for hint in hints if hint]
    candidates = []
    for root in session_search_roots():
        candidates.extend(root.rglob("*.jsonl"))
    if not candidates:
        raise FileNotFoundError("no Pi session JSONL found under known session roots")
    if hints:
        matched = [path for path in candidates if any(hint in path.name for hint in hints)]
        if matched:
            return max(matched, key=lambda path: path.stat().st_mtime)
    return max(candidates, key=lambda path: path.stat().st_mtime)


def read_pi_session(path):
    totals = {
        "inputTokens": 0,
        "cachedInputTokens": 0,
        "cacheWriteTokens": 0,
        "outputTokens": 0,
        "reasoningTokens": 0,
    }
    providers = set()
    models = set()
    current_provider = ""
    current_model = ""
    assistant_messages = 0
    summary_usage_records = 0
    usage_records = 0
    priced_messages = 0
    priced_usage_records = 0
    missing_price_models = set()
    gateway_providers = set()
    gateway_usage_records = 0
    session_cost = 0.0
    rate_snapshots = []
    cost_by_model = {}
    message_costs = {}
    pricing_inputs = []
    pricing_meta = []
    summary_types = {"compaction", "branch_summary"}

    with Path(path).open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON at {path}:{line_number}") from exc

            entry_type = entry.get("type")
            message = entry.get("message") or {}
            if entry_type == "model_change":
                current_provider = str(entry.get("provider") or current_provider or "unknown")
                current_model = str(entry.get("modelId") or current_model or "unknown")
                continue

            if entry_type == "message":
                if message.get("role") == "assistant":
                    current_provider = str(message.get("provider") or current_provider or "unknown")
                    current_model = str(message.get("model") or current_model or "unknown")
                usage = message.get("usage") or {}
                if message.get("role") != "assistant" or not usage:
                    continue
                assistant_messages += 1
                provider = str(message.get("provider") or current_provider or "unknown")
                model = str(message.get("model") or current_model or "unknown")
            elif entry_type in summary_types:
                usage = entry.get("usage") or {}
                if not usage:
                    continue
                summary_usage_records += 1
                provider = str(entry.get("provider") or current_provider or "unknown")
                model = str(entry.get("model") or current_model or "unknown")
            elif entry_type == "custom":
                data = entry.get("data") or {}
                usage = entry.get("usage") or data.get("usage") or {}
                if not usage:
                    continue
                provider = str(data.get("provider") or entry.get("provider") or current_provider or "unknown")
                model = str(data.get("model") or entry.get("model") or current_model or "unknown")
            else:
                continue

            timestamp = entry.get("timestamp") or message.get("timestamp")
            usage_records += 1
            providers.add(provider)
            models.add(model)
            input_tokens = integer(usage, "input", default=0)
            cached_tokens = integer(usage, "cacheRead", default=0)
            cache_write_tokens = integer(usage, "cacheWrite", default=0)
            cache_write_1h_tokens = min(integer(usage, "cacheWrite1h", default=0), cache_write_tokens)
            output_tokens = integer(usage, "output", default=0)
            reasoning_tokens = integer(usage, "reasoning", default=0)
            gateway = is_gateway_provider(provider)
            if gateway:
                gateway_providers.add(provider)
                gateway_usage_records += 1
            totals["inputTokens"] += input_tokens
            totals["cachedInputTokens"] += cached_tokens
            totals["cacheWriteTokens"] += cache_write_tokens
            totals["outputTokens"] += output_tokens
            totals["reasoningTokens"] += reasoning_tokens

            bucket_key = f"{provider}/{model}"
            bucket = cost_by_model.setdefault(bucket_key, {
                "provider": provider,
                "model": model,
                "usageRecords": 0,
                "pricedUsageRecords": 0,
                "inputTokens": 0,
                "cachedInputTokens": 0,
                "cacheWriteTokens": 0,
                "outputTokens": 0,
                "cost": None,
            })
            bucket["usageRecords"] += 1
            bucket["inputTokens"] += input_tokens
            bucket["cachedInputTokens"] += cached_tokens
            bucket["cacheWriteTokens"] += cache_write_tokens
            bucket["outputTokens"] += output_tokens
            pricing_inputs.append({
                "model": model,
                "provider": provider,
                "timestamp": timestamp,
                "serviceTier": service_tier_for(message, entry, entry.get("data"), usage),
                "usage": {
                    "input": input_tokens,
                    "cacheRead": cached_tokens,
                    "cacheWrite": cache_write_tokens,
                    "cacheWrite1h": cache_write_1h_tokens,
                    "output": output_tokens,
                    "reasoning": reasoning_tokens,
                    **_image_usage_fields(usage),
                },
            })
            pricing_meta.append({
                "entryType": entry_type,
                "entryId": entry.get("id"),
                "bucketKey": bucket_key,
                "gateway": gateway,
            })

    for meta, priced in zip(pricing_meta, price_usages(pricing_inputs)):
        if priced is None:
            if not meta["gateway"]:
                missing_price_models.add(meta["bucketKey"])
            continue
        request_cost = float(priced["cost"]["total"])
        session_cost += request_cost
        bucket = cost_by_model[meta["bucketKey"]]
        bucket["cost"] = (bucket["cost"] or 0.0) + request_cost
        bucket["pricedUsageRecords"] += 1
        priced_usage_records += 1
        rate_snapshots.append(priced["rates"])
        if meta["entryType"] == "message":
            priced_messages += 1
            if meta["entryId"]:
                message_costs[str(meta["entryId"])] = round(request_cost, 10)

    fully_priced = (
        usage_records > 0
        and priced_usage_records == usage_records
    )
    billing_mode = (
        "gateway"
        if gateway_usage_records == usage_records and usage_records
        else "mixed"
        if gateway_usage_records
        else "api"
    )
    engine = _engine_state()
    rate_payload = _rate_snapshot(rate_snapshots)
    return {
        "scope": "current Pi session cumulative",
        "session": str(Path(path)),
        "provider": ",".join(sorted(providers)) or "unknown",
        "model": ",".join(sorted(models)) or "unknown",
        "assistantMessages": assistant_messages,
        "summaryUsageRecords": summary_usage_records,
        "usageRecords": usage_records,
        "pricedMessages": priced_messages,
        "pricedUsageRecords": priced_usage_records,
        "missingPriceModels": sorted(missing_price_models),
        "billingMode": billing_mode,
        "gatewayProviders": sorted(gateway_providers),
        "gatewayUsageRecords": gateway_usage_records,
        "costByModel": cost_by_model,
        "messageCosts": message_costs,
        "priceTable": {
            "engine": ["genai-prices"],
            "status": engine["status"],
            "packageVersion": engine["packageVersion"],
            "revision": engine["revision"],
            "updatedAt": engine["updatedAt"],
            "failureReason": engine["failureReason"],
            "failureAt": engine["failureAt"],
        },
        "usage": {
            **totals,
            "totalTokens": totals["inputTokens"]
            + totals["cachedInputTokens"]
            + totals["cacheWriteTokens"]
            + totals["outputTokens"],
        },
        "rates": rate_payload,
        "cost": {
            "currency": "USD",
            "amount": round(session_cost, 10) if fully_priced else None,
            "status": "calculated" if fully_priced else ("unavailable" if usage_records else "usage_unavailable"),
        },
    }


def compact_line(item):
    usage = item["usage"]
    cost = item["cost"]
    rates = item.get("rates") or {}
    amount = cost["amount"]
    amount_text = f"{amount:.6f}" if amount is not None else "n/a"
    missing = item.get("missingPriceModels") or []
    missing_text = f" missing={','.join(missing)}" if missing else ""
    summary_count = item.get("summaryUsageRecords", 0)
    summary_text = f" summaries={summary_count}" if summary_count else ""
    return (
        f"{item['provider']}/{item['model']} "
        f"tokens={usage['totalTokens']} "
        f"in={usage['inputTokens']} cache={usage['cachedInputTokens']} "
        f"out={usage['outputTokens']} reason={usage['reasoningTokens']} "
        f"cost={amount_text} {cost['currency']} status={cost['status']} "
        f"billing={item.get('billingMode') or 'api'} "
        f"table={rates.get('priceTableId') or '-'} tableStatus={rates.get('priceTableStatus') or '-'} "
        f"tier={rates.get('contextTier') or '-'} "
        f"src={rates.get('source') or '-'}{summary_text}{missing_text}"
    )


def emit(item, compact=False):
    print(compact_line(item) if compact else json.dumps(item, ensure_ascii=False))


def _price_json_records(items):
    requests = []
    usage_payloads = []
    for item in items:
        usage = item.get("usage") or {}
        input_tokens = integer(usage, "input", "inputTokens", "input_tokens", default=0)
        cache_read_tokens = integer(usage, "cacheRead", "cachedInputTokens", "cache_read_tokens", default=0)
        cache_write_tokens = integer(usage, "cacheWrite", "cacheWriteTokens", "cache_write_tokens", default=0)
        cache_write_1h_tokens = min(
            integer(usage, "cacheWrite1h", "cacheWrite1hTokens", "cache_write_1h_tokens", default=0),
            cache_write_tokens,
        )
        output_tokens = integer(usage, "output", "outputTokens", "output_tokens", default=0)
        reasoning_tokens = integer(usage, "reasoning", "reasoningTokens", "reasoning_tokens", default=0)
        requests.append({
            "model": item.get("model"),
            "provider": item.get("provider"),
            "timestamp": item.get("timestamp"),
            "serviceTier": service_tier_for(item, usage),
            "usage": {
                "input": input_tokens,
                "cacheRead": cache_read_tokens,
                "cacheWrite": cache_write_tokens,
                "cacheWrite1h": cache_write_1h_tokens,
                "output": output_tokens,
                "reasoning": reasoning_tokens,
                **_image_usage_fields(usage),
            },
        })
        usage_payloads.append(_usage_payload(
            input_tokens,
            cache_read_tokens,
            cache_write_tokens,
            output_tokens,
            reasoning_tokens,
            cache_write_1h_tokens,
        ))
        usage_payloads[-1].update(_image_usage_fields(usage))

    result = []
    for item, usage, priced in zip(items, usage_payloads, price_usages(requests)):
        row = {
            "configured": priced is not None,
            "model": str(item.get("model") or ""),
            "provider": str(item.get("provider") or ""),
            "usage": usage,
        }
        if priced is None:
            row.update({
                "status": "unavailable",
                "reason": "网关会话金额由 CPA/Sub2API 账本提供" if is_gateway_provider(item.get("provider")) else "genai-prices 未匹配 provider/model/time 或计价数据不可用",
            })
        else:
            row.update({
                "cost": priced["cost"],
                "rates": priced["rates"],
                "engine": priced.get("engine"),
                "status": "calculated",
            })
        result.append(row)
    return result


def _price_json_record(item):
    return _price_json_records([item])[0]


def read_json_input(path):
    stream = sys.stdin if path == "-" else Path(path).open(encoding="utf-8")
    try:
        return json.load(stream)
    finally:
        if stream is not sys.stdin:
            stream.close()


def self_test():
    state = _engine_state()
    assert state["available"] and state["packageVersion"]

    for model, provider in (
        ("gpt-5.6-sol", "openai"),
        ("deepseek-v4-flash", "deepseek"),
        ("minimax-m3", "minimax"),
        ("grok-4.6", "x-ai"),
        ("glm-5.2", "zhipuai"),
    ):
        priced = price_usage(model, provider, input_tokens=100, output_tokens=10, timestamp="2026-08-26T18:00:00Z")
        assert priced is not None and priced["engine"] == "pydantic"
        assert priced["rates"]["priceEngine"] == "genai-prices"
        assert abs(
            priced["cost"]["total"]
            - sum(priced["cost"][key] for key in ("input", "cacheRead", "cacheWrite", "output"))
        ) < 1e-12

    for provider in (
        "CPA GPT",
        "CPA Antigravity",
        "Sub2API 国产",
        "Sub2API Grok",
        "Sub2API Claude",
        "Sub2API WorkBuddy",
    ):
        priced = price_usage("gpt-5.6-luna", provider, input_tokens=100, output_tokens=10, timestamp="2026-08-26T18:00:00Z")
        assert priced is not None and priced["engine"] == "pydantic"

    official = price_usage("minimax-m3", "minimax", input_tokens=100, output_tokens=10, timestamp="2026-08-26T18:00:00Z")
    workbuddy = price_usage("minimax-m3", "WorkBuddy", input_tokens=100, output_tokens=10, timestamp="2026-08-26T18:00:00Z")
    prefixed = price_usage("WorkBuddy/minimax-m3", "WorkBuddy", input_tokens=100, output_tokens=10, timestamp="2026-08-26T18:00:00Z")
    assert official is not None and workbuddy is not None and prefixed is not None
    assert official["cost"] == workbuddy["cost"] == prefixed["cost"]
    assert price_usage("minimax-m3-free", "Sub2API 国产", input_tokens=100, timestamp="2026-08-26T18:00:00Z") is None
    assert price_usage("unknown-model", "WorkBuddy", input_tokens=100, timestamp="2026-08-26T18:00:00Z") is None
    assert price_usage("gpt-5.6-sol", "CPA GPT", input_tokens=100, timestamp="not-a-time") is None
    assert price_usage("gpt-5.6-sol", "CPA GPT", input_tokens=100) is None
    assert price_usage("gpt-5.5-pro", "openai", cache_read_tokens=100, timestamp="2026-08-26T18:00:00Z") is None
    assert price_usage("gpt-5.5", "openai", cache_write_tokens=100, timestamp="2026-08-26T18:00:00Z") is None

    with tempfile.TemporaryDirectory() as directory:
        session_path = Path(directory) / "session.jsonl"
        entries = [
            {"type": "session", "version": 3, "id": "self-test"},
            {"type": "message", "id": "known", "timestamp": "2026-08-26T18:00:00Z", "message": {
                "role": "assistant", "provider": "WorkBuddy", "model": "minimax-m3",
                "usage": {"input": 100, "output": 10},
            }},
            {"type": "message", "id": "unknown", "timestamp": "2026-08-26T18:00:00Z", "message": {
                "role": "assistant", "provider": "WorkBuddy", "model": "unknown-model",
                "usage": {"input": 100, "output": 10},
            }},
        ]
        session_path.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")
        result = read_pi_session(session_path)
        assert result["usageRecords"] == 2
        assert result["pricedUsageRecords"] == 1
        assert result["missingPriceModels"] == ["WorkBuddy/unknown-model"]
        assert result["cost"]["amount"] is None
        assert result["cost"]["status"] == "unavailable"
        assert result["messageCosts"]["known"] > 0
        assert result["costByModel"]["WorkBuddy/unknown-model"]["cost"] is None
        assert result["priceTable"]["engine"] == ["genai-prices"]

        gateway_path = Path(directory) / "gateway.jsonl"
        gateway_path.write_text("".join(json.dumps({
            "type": "message",
            "id": "gateway",
            "timestamp": "2026-08-26T18:00:00Z",
            "message": {
                "role": "assistant",
                "provider": "Sub2API GPT",
                "model": "gpt-5.6-luna",
                "usage": {"input": 100, "output": 10},
            },
        }) + "\n"), encoding="utf-8")
        gateway_result = read_pi_session(gateway_path)
        assert gateway_result["billingMode"] == "gateway"
        assert gateway_result["gatewayProviders"] == ["Sub2API GPT"]
        assert gateway_result["missingPriceModels"] == []
        assert gateway_result["cost"]["amount"] is not None
        assert gateway_result["cost"]["status"] == "calculated"

    batch = _price_json_record({
        "model": "minimax-m3",
        "provider": "WorkBuddy",
        "usage": {"input": 100, "output": 10},
        "timestamp": "2026-08-26T18:00:00Z",
    })
    assert batch["configured"] is True and batch["engine"] == "pydantic"
    print("self-test-ok")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command")
    parser.add_argument("--compact", action="store_true", help="one-line summary")
    now = sub.add_parser("now", help="auto-find current session")
    now.add_argument("--json", action="store_true")
    path_cmd = sub.add_parser("path", help="calculate a given session path")
    path_cmd.add_argument("path")
    path_cmd.add_argument("--compact", action="store_true")
    price_cmd = sub.add_parser("price-json", help="price one usage object or an array through genai-prices")
    price_cmd.add_argument("input", nargs="?", default="-")
    sub.add_parser("self-test")

    argv = sys.argv[1:]
    commands = {"now", "path", "price-json", "self-test"}
    if argv and not argv[0].startswith("-") and argv[0] not in commands:
        argv = ["path", *argv]
    args = parser.parse_args(argv)

    if args.command == "self-test":
        self_test()
        return
    if args.command == "price-json":
        payload = read_json_input(args.input)
        records = payload if isinstance(payload, list) else [payload]
        print(json.dumps(_price_json_records(records), ensure_ascii=False))
        return
    if args.command == "now":
        item = read_pi_session(find_current_session())
        emit(item, compact=not args.json)
        return
    if args.command == "path":
        item = read_pi_session(args.path)
        emit(item, compact=args.compact)
        return
    item = read_pi_session(find_current_session())
    emit(item, compact=True)


if __name__ == "__main__":
    main()
