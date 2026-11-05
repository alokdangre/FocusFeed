"""User-scoped DynamoDB judgments; generation keys make clear atomic and durable."""

import threading
import time
from decimal import Decimal

try:
    from .accounts import data_table
    from .video_cache import JudgmentCache, probability
except ImportError:
    from accounts import data_table
    from video_cache import JudgmentCache, probability


class UserJudgmentCache:
    def __init__(self, subject: str):
        self.subject = subject
        self.lock = threading.RLock()
        self.inflight = {}
        self.clock = time.time
        self.available = True

    def generation(self) -> int:
        result = data_table().get_item(Key={"pk": "USER#" + self.subject, "sk": "CACHE"}, ConsistentRead=True)
        return int(result.get("Item", {}).get("generation", 0))

    def partition(self, epoch: int) -> str:
        return f"USER#{self.subject}#CACHE#{epoch}"

    def lookup(self, keys: list[str]) -> tuple[int, dict]:
        # Fail closed on storage failure. Do not silently turn an outage into
        # uncached, unbounded provider spending in the hosted API.
        epoch, hits, now = self.generation(), {}, self.clock()
        store = data_table()
        for key in keys:
            item = store.get_item(Key={"pk": self.partition(epoch), "sk": key}, ConsistentRead=True).get("Item", {})
            value = probability({"type": "noul", "noul": float(item.get("probability", -1))})
            if value is not None and item.get("createdAt", now + 1) <= now < item.get("expiresAt", 0):
                hits[key] = (value, float(item["expiresAt"]))
        return epoch, hits

    def save(self, entries: list[tuple[str, float, int]], epoch: int) -> None:
        now, store = int(self.clock()), data_table()
        # A result from before clear can only write the old generation partition;
        # new requests never look there. TTL subsequently removes the old items.
        with store.batch_writer() as batch:
            for key, value, ttl in entries:
                batch.put_item(Item={"pk": self.partition(epoch), "sk": key,
                    "probability": Decimal(str(value)), "createdAt": now, "expiresAt": now + ttl})

    def clear(self) -> None:
        data_table().update_item(Key={"pk": "USER#" + self.subject, "sk": "CACHE"},
            UpdateExpression="ADD generation :one", ExpressionAttributeValues={":one": 1})


def scoped_cache(principal):
    if principal.local:
        # Local data also has a separate directory, never the old global cache.
        from pathlib import Path
        import os
        path = Path(os.getenv("FOCUSFEED_CACHE_PATH", str(Path(__file__).parent / ".cache" / "judgments.sqlite3")))
        return JudgmentCache(path.parent / "users" / principal.subject / path.name)
    return UserJudgmentCache(principal.subject)
