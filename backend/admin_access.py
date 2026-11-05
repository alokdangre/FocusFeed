"""Operator-only temporary grants until Stage 3 payment webhooks exist.

Run with a separate IAM principal allowed to write AccessTable. The application
Lambda role only has GetItem and cannot execute this operation successfully.
There is deliberately no HTTP route or extension message for changing access.
"""

import argparse
from datetime import datetime, timezone

import boto3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", required=True, help="AccessTableName from SAM outputs")
    parser.add_argument("--user-id", required=True, help="Verified Cognito sub, not an email address")
    parser.add_argument("--until", help="Explicit UTC expiry, e.g. 2026-12-01T00:00:00Z")
    parser.add_argument("--revoke", action="store_true")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    if args.revoke:
        status, until = "revoked", int(now.timestamp())
    else:
        try:
            date = datetime.fromisoformat((args.until or "").replace("Z", "+00:00"))
            if date.tzinfo is None or date <= now:
                raise ValueError()
            status, until = "active", int(date.timestamp())
        except ValueError:
            parser.error("Provide --revoke or an explicit future --until timestamp with timezone.")
    boto3.resource("dynamodb").Table(args.table).put_item(Item={"userId": args.user_id,
        "status": status, "accessUntil": until, "source": "operator-beta", "updatedAt": int(now.timestamp())})
    print(f"Access {status} for {args.user_id} until {datetime.fromtimestamp(until, timezone.utc).isoformat()}")


if __name__ == "__main__":
    main()
