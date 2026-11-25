import json
import unittest

import _setup
from askwearables import OPERATIONS, AskWearables


class OpenApiTest(unittest.TestCase):
    def setUp(self) -> None:
        with open(_setup.OPENAPI, encoding="utf-8") as f:
            self.doc = json.load(f)

    def test_operations_match_document(self) -> None:
        in_doc = {}
        for path, item in self.doc["paths"].items():
            for method, op in item.items():
                params = {p["name"] for p in op.get("parameters", [])}
                in_doc[op["operationId"]] = {"method": method.upper(), "path": path, "user_header": "X-AskWearables-User" in params}
        self.assertEqual(in_doc, OPERATIONS)

    def test_client_methods(self) -> None:
        for name in ["ask", "query", "capabilities", "get_packet", "create_user", "create_grant_link", "ingest", "usage"]:
            self.assertTrue(callable(getattr(AskWearables, name)), name)

    def test_enums_the_types_rely_on(self) -> None:
        s = self.doc["components"]["schemas"]
        self.assertEqual(s["GrantRequest"]["properties"]["purpose"]["enum"], ["scheduling", "training_advice", "sleep_coaching", "general_wellness", "personal_research"])
        self.assertEqual(s["GrantRequest"]["properties"]["max_level"]["enum"], [0, 1, 2, 3])
        self.assertEqual(s["AskResponse"]["properties"]["status"]["enum"], ["ok", "denied", "unsupported"])
        self.assertEqual(set(s["GrantRequest"]["required"]), {"purpose", "metrics", "max_level", "max_window_days", "daily_packet_budget", "days"})


if __name__ == "__main__":
    unittest.main()
