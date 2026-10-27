"""Bounded persistence of raw Jev video/topic judgments, never hide/show actions."""

import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import Future
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

MAX_QUESTIONS = 96
# Conservative serialized-byte budgets, not a tokenizer or a promise of exact tokens.
MAX_REQUEST_BYTES = 48_000
MAX_QUESTION_CONTEXT_BYTES = 24_000


def encoded_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def probability(answer: Any) -> float | None:
    value = answer.get("noul") if isinstance(answer, dict) and answer.get("type") == "noul" else None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and 0 <= value <= 1 else None


class JudgmentCache:
    def __init__(self, path: str | Path, *, max_entries: int = 10_000, clock: Callable = time.time):
        self.path = str(path)
        self.max_entries = max_entries
        self.clock = clock
        self.lock = threading.RLock()
        self.inflight: dict[tuple[int, str], Future] = {}
        self.available = True

    @contextmanager
    def connect(self):
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=0.5)
        try:
            db.execute("CREATE TABLE IF NOT EXISTS generation (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL)")
            db.execute("INSERT OR IGNORE INTO generation VALUES (1, 0)")
            db.execute("""CREATE TABLE IF NOT EXISTS judgments (
                key TEXT PRIMARY KEY, probability REAL NOT NULL CHECK(probability BETWEEN 0 AND 1),
                created REAL NOT NULL, expires REAL NOT NULL, accessed REAL NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS expiry ON judgments(expires)")
            db.execute("CREATE INDEX IF NOT EXISTS recency ON judgments(accessed)")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def lookup(self, keys: list[str]) -> tuple[int, dict[str, tuple[float, float]]]:
        try:
            with self.lock, self.connect() as db:
                epoch = db.execute("SELECT epoch FROM generation WHERE id=1").fetchone()[0]
                now = self.clock()
                db.execute("DELETE FROM judgments WHERE expires <= ?", (now,))
                placeholders = ",".join("?" for _ in keys)
                rows = db.execute(f"SELECT key, probability, expires FROM judgments WHERE key IN ({placeholders}) AND created <= ? AND expires > ?", [*keys, now, now]).fetchall() if keys else []
                result = {key: (value, expires) for key, value, expires in rows if probability({"type": "noul", "noul": value}) is not None}
                db.executemany("UPDATE judgments SET accessed=? WHERE key=?", [(now, key) for key in result])
                self.available = True
                return epoch, result
        except (OSError, sqlite3.Error):
            self.available = False
            return -1, {}

    def save(self, entries: list[tuple[str, float, int]], epoch: int) -> None:
        if epoch < 0:
            return
        try:
            with self.lock, self.connect() as db:
                # Take the SQLite write lock before checking the generation, also across processes.
                db.execute("UPDATE generation SET epoch=epoch WHERE id=1")
                if db.execute("SELECT epoch FROM generation WHERE id=1").fetchone()[0] != epoch:
                    return
                now = self.clock()
                db.executemany("INSERT OR REPLACE INTO judgments VALUES (?, ?, ?, ?, ?)",
                    [(key, value, now, now + ttl, now) for key, value, ttl in entries])
                db.execute("DELETE FROM judgments WHERE expires <= ?", (now,))
                db.execute("DELETE FROM judgments WHERE key IN (SELECT key FROM judgments ORDER BY accessed DESC, created DESC, key LIMIT -1 OFFSET ?)", (self.max_entries,))
        except (OSError, sqlite3.Error):
            self.available = False

    def clear(self) -> None:
        with self.lock, self.connect() as db:
            db.execute("UPDATE generation SET epoch=epoch+1 WHERE id=1")
            db.execute("DELETE FROM judgments")


_registry: dict[str, JudgmentCache] = {}
_registry_lock = threading.Lock()


def default_cache() -> JudgmentCache:
    fallback = Path("/tmp/focusfeed") if os.getenv("AWS_LAMBDA_FUNCTION_NAME") else Path(__file__).parent / ".cache"
    path = os.getenv("FOCUSFEED_CACHE_PATH", str(fallback / "judgments.sqlite3"))
    with _registry_lock:
        if path not in _registry:
            _registry[path] = JudgmentCache(path)
        return _registry[path]


def pair_key(payload: dict, video_id: str, vi: int, oi: int, question: dict, namespace: dict) -> str:
    normalized = json.dumps(question, sort_keys=True, ensure_ascii=False)
    normalized = normalized.replace(f"videos[{vi}]", "video").replace(f"objectives[{oi}]", "objective")
    identity = {"schema": "video-topic-probability-v1", "namespace": namespace, "model": payload["model"],
        "videoId": video_id, "video": payload["state"]["videos"][vi],
        "objective": payload["state"]["objectives"][oi], "question": normalized}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def compact(payload: dict, pairs: list[tuple]) -> dict:
    video_indices = sorted({pair[1] for pair in pairs})
    topic_indices = sorted({pair[2] for pair in pairs})
    questions = {}
    for qid, vi, oi, _key in pairs:
        question = json.loads(json.dumps(payload["questions"][qid]))
        text = question["instructions"]["question"]
        question["instructions"]["question"] = text.replace(f"videos[{vi}]", f"videos[{video_indices.index(vi)}]").replace(f"objectives[{oi}]", f"objectives[{topic_indices.index(oi)}]")
        questions[qid] = question
    return {"model": payload["model"], "state": {
        "videos": [payload["state"]["videos"][i] for i in video_indices],
        "objectives": [payload["state"]["objectives"][i] for i in topic_indices]}, "questions": questions}


def within_budget(payload: dict) -> bool:
    if len(payload["questions"]) > MAX_QUESTIONS or encoded_size(payload) > MAX_REQUEST_BYTES:
        return False
    return all(encoded_size({"state": payload["state"], "question": q}) <= MAX_QUESTION_CONTEXT_BYTES for q in payload["questions"].values())


def split_requests(payload: dict, pairs: list[tuple]) -> list[dict]:
    batches, selected = [], []
    for pair in pairs:
        candidate = compact(payload, [*selected, pair])
        if not within_budget(candidate):
            if selected:
                batches.append(compact(payload, selected))
            selected = [pair]
            if not within_budget(compact(payload, selected)):
                raise ValueError("A video/topic judgment exceeds the configured context budget.")
        else:
            selected.append(pair)
    if selected:
        batches.append(compact(payload, selected))
    return batches


def ttl_for(video: dict, value: float) -> int:
    if video["format"] in ("live", "premiere") or 0.1 < value < 0.7:
        return 300
    if video["description"] == "not supplied" or video["channel_id"] == "not supplied":
        return 3600
    return 86400


def evaluate(payload: dict, video_ids: list[str], dispatch: Callable, namespace: dict,
             *, cache: JudgmentCache | None = None) -> dict:
    cache = cache or default_cache()
    enabled = os.getenv("FOCUSFEED_CACHE_ENABLED", "true").lower() not in ("0", "false", "no")
    # Moving aliases do not provide a stable model identity for persistent judgments.
    enabled = enabled and re.fullmatch(r"jev-\d+\.\d+\.\d+", payload["model"]) is not None
    pairs = []
    for qid, question in payload["questions"].items():
        match = re.fullmatch(r"v(\d+)_o(\d+)_match", qid)
        if not match:
            raise ValueError("Unexpected video question identity.")
        vi, oi = map(int, match.groups())
        pairs.append((qid, vi, oi, pair_key(payload, video_ids[vi], vi, oi, question, namespace)))
    # Claim missing pairs atomically. Other threads share the result, not its policy action.
    with cache.lock:
        epoch, hits = cache.lookup([p[3] for p in pairs]) if enabled else (-1, {})
        owned, waiting = [], []
        for pair in pairs:
            key = pair[3]
            if key in hits:
                continue
            flight_key = (epoch, key)
            if enabled and epoch >= 0 and flight_key in cache.inflight:
                waiting.append((pair, cache.inflight[flight_key]))
            else:
                owned.append(pair)
                if enabled and epoch >= 0:
                    cache.inflight[flight_key] = Future()
    answers = {qid: {"type": "noul", "noul": hits[key][0]} for qid, _vi, _oi, key in pairs if key in hits}
    usage = {"input_tokens": 0, "output_tokens": 0}
    calls = 0
    resolved_model = payload["model"]
    shared = set()
    expiries = {qid: hits[key][1] for qid, _vi, _oi, key in pairs if key in hits}
    try:
        for outbound in split_requests(payload, owned):
            result = dispatch(outbound)
            calls += 1
            if not isinstance(result, dict) or not isinstance(result.get("answers"), dict):
                raise ValueError("TypeSafe response is missing the answers map.")
            resolved_model = result.get("model", payload["model"])
            if enabled and resolved_model != payload["model"]:
                raise ValueError("TypeSafe returned a different model than the pinned model.")
            for name in usage:
                value = result.get("usage", {}).get(name, 0)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                    usage[name] += value
            for qid in outbound["questions"]:
                if qid in result["answers"]:
                    answers[qid] = result["answers"][qid]
            # Preserve unexpected IDs for the caller's diagnostics; never persist them.
            for qid, answer in result["answers"].items():
                if qid not in payload["questions"]:
                    answers[qid] = answer
        entries = []
        for qid, vi, _oi, key in owned:
            value = probability(answers.get(qid))
            ttl = ttl_for(payload["state"]["videos"][vi], value) if value is not None else 30
            expiries[qid] = cache.clock() + ttl
            if value is not None and resolved_model == payload["model"]:
                entries.append((key, value, ttl))
        if enabled:
            cache.save(entries, epoch)
        with cache.lock:
            for qid, _vi, _oi, key in owned:
                future = cache.inflight.pop((epoch, key), None)
                if future is not None:
                    future.set_result((probability(answers.get(qid)), resolved_model, expiries[qid]))
    except BaseException as error:
        with cache.lock:
            for _qid, _vi, _oi, key in owned:
                future = cache.inflight.pop((epoch, key), None)
                if future is not None:
                    future.set_exception(error)
        raise
    for (qid, _vi, _oi, _key), future in waiting:
        value, resolved_model, expires = future.result(timeout=25)
        expiries[qid] = expires
        if value is not None:
            answers[qid] = {"type": "noul", "noul": value}
            shared.add(qid)
    by_video = {}
    for index, video_id in enumerate(video_ids):
        relevant = [p for p in pairs if p[1] == index]
        cached = sum(p[3] in hits for p in relevant)
        reused = sum(p[0] in shared for p in relevant)
        source = "cache" if cached == len(relevant) else "shared" if reused == len(relevant) else "model" if not cached and not reused else "mixed"
        by_video[video_id] = {"source": source, "hits": cached, "shared": reused, "questions": len(relevant),
            "expiresAt": int(min(expiries.get(p[0], cache.clock() + 30) for p in relevant) * 1000)}
    return {"model": resolved_model, "answers": answers, "usage": usage, "cache": {
        "enabled": enabled, "available": cache.available, "hits": len(hits), "shared": len(shared),
        "misses": len(owned), "providerCalls": calls, "providerQuestions": len(owned), "byVideo": by_video}}
