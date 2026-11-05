"""Operator-only replay of a durable billing inbox event, with a fresh event ID."""

import argparse
import time
import uuid

from .accounts import table
from .dodo import identifier


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", required=True)
    parser.add_argument("--environment", choices=("test_mode", "live_mode"), required=True)
    parser.add_argument("--event-id", required=True)
    args = parser.parse_args()
    prefix = "DODO#" + args.environment + "#EVENT#"
    target = table(args.table)
    previous = target.get_item(Key={"pk": prefix + identifier(args.event_id), "sk": "EVENT"}, ConsistentRead=True).get("Item")
    if not previous:
        parser.error("Billing inbox event not found in that environment")
    event_id = uuid.uuid4().hex
    item = {"pk": prefix + event_id, "sk": "EVENT", "eventId": event_id, "kind": previous["kind"],
            "resource": previous["resource"], "status": "pending", "createdAt": int(time.time()),
            "expiresAt": int(time.time()) + 30 * 86400}
    if "subject" in previous:
        item["subject"] = previous["subject"]
    target.put_item(Item=item, ConditionExpression="attribute_not_exists(pk)")
    print("Queued billing reconciliation event " + event_id)


if __name__ == "__main__":
    main()
