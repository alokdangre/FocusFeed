"""Offline infrastructure/packaging security contracts, not deployed-AWS evidence."""

import tempfile
import unittest
from pathlib import Path

import yaml

from backend.package_lambda import RUNTIME_FILES, copy_runtime


class CfnLoader(yaml.SafeLoader):
    pass


def tagged(loader, tag, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {tag: value}


CfnLoader.add_multi_constructor("!", tagged)


class InfrastructureTests(unittest.TestCase):
    def setUp(self):
        with (Path(__file__).resolve().parents[1] / "template.yaml").open() as stream:
            self.template = yaml.load(stream, Loader=CfnLoader)

    def test_application_has_read_only_entitlement_permissions_and_no_public_grant_route(self):
        resources = self.template["Resources"]
        properties = resources["ClassifierFunction"]["Properties"]
        policies = properties["Policies"]
        access = [entry for policy in policies for entry in policy.get("Statement", []) if entry["Resource"] == {"GetAtt": "AccessTable.Arn"}]
        self.assertEqual(access, [{"Effect": "Allow", "Action": "dynamodb:GetItem", "Resource": {"GetAtt": "AccessTable.Arn"}}])
        self.assertEqual([policy["DynamoDBCrudPolicy"]["TableName"] for policy in policies if "DynamoDBCrudPolicy" in policy], [{"Ref": "UserDataTable"}])
        self.assertEqual(properties["Environment"]["Variables"]["FOCUSFEED_AUTH_MODE"], "required")
        paths = {event["Properties"]["Path"] for event in properties["Events"].values()}
        self.assertEqual(paths, {"/health", "/account", "/account/logout", "/classify", "/objectives/classify", "/channels/classify", "/cache/clear", "/jobs/{jobId}"})

    def test_worker_is_private_and_policy_and_entitlements_are_read_only(self):
        resources = self.template["Resources"]
        worker = resources["JobWorkerFunction"]["Properties"]
        self.assertEqual(worker["Timeout"], 240)
        self.assertEqual(worker["Events"]["Jobs"]["Type"], "DynamoDB")
        self.assertEqual(worker["Events"]["Jobs"]["Properties"]["StartingPosition"], "TRIM_HORIZON")
        self.assertEqual(resources["JobTable"]["Properties"]["StreamSpecification"]["StreamViewType"], "KEYS_ONLY")
        for name in ("ClassifierFunction", "JobWorkerFunction"):
            policies = resources[name]["Properties"]["Policies"]
            for table in ("AccessTable", "ConfigTable"):
                access = [entry["Action"] for policy in policies for entry in policy.get("Statement", []) if entry["Resource"] == {"GetAtt": table + ".Arn"}]
                self.assertEqual(access, ["dynamodb:GetItem"])
        self.assertNotIn("TYPESAFE_API_KEY", self.template["Globals"]["Function"]["Environment"]["Variables"])
        self.assertNotIn("TYPESAFE_API_KEY", resources["ClassifierFunction"]["Properties"]["Environment"]["Variables"])
        self.assertIn("TYPESAFE_API_KEY", worker["Environment"]["Variables"])

    def test_cognito_public_client_requires_confirmation_and_gateway_auth_is_on_by_default(self):
        resources = self.template["Resources"]
        self.assertEqual(resources["UserPool"]["Properties"]["AutoVerifiedAttributes"], ["email"])
        client = resources["UserPoolClient"]["Properties"]
        self.assertFalse(client["GenerateSecret"]); self.assertTrue(client["EnableTokenRevocation"])
        self.assertEqual(client["AllowedOAuthFlows"], ["code"])
        self.assertIn("focusfeed/ai", client["AllowedOAuthScopes"])
        api = resources["FocusFeedApi"]["Properties"]
        self.assertEqual(api["Auth"]["DefaultAuthorizer"], "AccountAuthorizer")
        events = resources["ClassifierFunction"]["Properties"]["Events"]
        self.assertEqual([name for name, event in events.items() if event["Properties"].get("Auth", {}).get("Authorizer") == "NONE"], ["Health"])
        self.assertNotIn("*", api["CorsConfiguration"]["AllowOrigins"])
        for name in ("UserDataTable", "AccessTable"):
            self.assertTrue(resources[name]["Properties"]["SSESpecification"]["SSEEnabled"])
            self.assertTrue(resources[name]["Properties"]["PointInTimeRecoverySpecification"]["PointInTimeRecoveryEnabled"])

    def test_runtime_packaging_excludes_secrets_tests_and_operator_command(self):
        with tempfile.TemporaryDirectory() as folder:
            source, destination = Path(folder) / "source", Path(folder) / "artifact"
            source.mkdir()
            for name in RUNTIME_FILES: (source / name).write_text("# runtime", encoding="utf-8")
            for name in (".env", "admin_access.py", "admin_policy.py", "admin_billing.py", "test_access.py"): (source / name).write_text("do not ship", encoding="utf-8")
            copy_runtime(destination, source)
            self.assertEqual({item.name for item in destination.iterdir()}, set(RUNTIME_FILES))
        self.assertEqual(self.template["Resources"]["ClassifierFunction"]["Metadata"]["BuildMethod"], "makefile")

    def test_only_private_billing_worker_can_write_entitlements_and_secrets_are_isolated(self):
        resources = self.template["Resources"]
        self.assertEqual(self.template["Parameters"]["EnableBilling"]["Default"], "false")
        self.assertEqual(self.template["Parameters"]["DodoEnvironment"]["Default"], "test_mode")
        for name in ("DodoApiKey", "DodoWebhookSecret"):
            self.assertTrue(self.template["Parameters"][name]["NoEcho"])
        for name in ("BillingApiFunction", "BillingWebhookFunction"):
            resource = resources[name]
            self.assertEqual(resource["Condition"], "BillingEnabled")
            self.assertNotIn("AccessTable", str(resource["Properties"]["Policies"]))
        receiver = resources["BillingWebhookFunction"]["Properties"]
        self.assertNotIn("DODO_API_KEY", receiver["Environment"]["Variables"])
        self.assertEqual(receiver["Policies"][0]["Statement"][0]["Action"], "dynamodb:PutItem")
        api = resources["BillingApiFunction"]["Properties"]
        self.assertNotIn("DODO_WEBHOOK_SECRET", api["Environment"]["Variables"])
        self.assertEqual([name for name, event in api["Events"].items() if event["Properties"].get("Auth", {}).get("Authorizer") == "NONE"], ["ReturnPage"])
        worker = resources["BillingWorkerFunction"]["Properties"]
        self.assertTrue(all(event["Type"] != "HttpApi" for event in worker["Events"].values()))
        writes = [entry for policy in worker["Policies"] for entry in policy.get("Statement", []) if entry["Resource"] == {"GetAtt": "AccessTable.Arn"}]
        self.assertEqual(writes[0]["Action"], ["dynamodb:GetItem", "dynamodb:PutItem"])
        inbox = worker["Events"]["Inbox"]["Properties"]
        self.assertEqual(inbox["StartingPosition"], "TRIM_HORIZON")
        self.assertEqual(inbox["DestinationConfig"]["OnFailure"]["Type"], "SQS")
        self.assertEqual(resources["BillingTable"]["Properties"]["StreamSpecification"]["StreamViewType"], "KEYS_ONLY")
