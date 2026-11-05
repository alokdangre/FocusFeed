"""Operator-only policy editor. Requires separate write access to ConfigTable."""

import argparse
import json
from pathlib import Path

from .accounts import table
from .controls import Policy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--show", action="store_true")
    action.add_argument("--file", type=Path)
    action.add_argument("--pause", action="store_true")
    action.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    target = table(args.table)
    existing = target.get_item(Key={"id": "policy"}, ConsistentRead=True).get("Item")
    current = Policy.model_validate_json(existing["document"]) if existing else Policy()
    if args.show:
        print(current.model_dump_json(indent=2))
        return
    value = Policy.model_validate_json(args.file.read_text()) if args.file else current.model_copy(update={"aiEnabled": not args.pause})
    value.revision = current.revision + 1
    condition = {"ConditionExpression": "document = :previous", "ExpressionAttributeValues": {":previous": existing["document"]}} if existing else {"ConditionExpression": "attribute_not_exists(id)"}
    target.put_item(Item={"id": "policy", "document": value.model_dump_json()}, **condition)
    print(json.dumps({"updated": True, "policy": value.model_dump()}, indent=2))


if __name__ == "__main__":
    main()
