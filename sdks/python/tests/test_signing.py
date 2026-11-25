import hashlib
import hmac
import unittest

import _setup  # noqa: F401
from askwearables import canonical_string, hmac_sha256_hex, new_nonce, sha256_hex, sign_request, verify_webhook

# The same vectors as sdks/typescript/test/vectors.ts: both SDKs must produce identical signatures.
SECRET = "awsig_test_secret"
TS = 1764000000
NONCE = "nonce_0123456789abcdef"
POST_BODY = '{"question":"How did I sleep this week?"}'
POST_SIG = "c00036058439b1f4ebdabccdc459f531e1e671cd7d372dfa312456ce9cb6e604"
GET_SIG = "6460c6bb22e06738d1a8cf33e34ab59e1c5da68de06f50922ceb2ab05113500e"


class SigningTest(unittest.TestCase):
    def test_body_hash(self) -> None:
        self.assertEqual(sha256_hex(POST_BODY), "a8b7892ebafeffb3771338007f06dd84cd8c161bfe6a9383b0fc2af6343c1c27")
        self.assertEqual(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")

    def test_canonical_string(self) -> None:
        self.assertEqual(canonical_string("1", "n", "post", "/v1/ask", "h"), "1\nn\nPOST\n/v1/ask\nh")

    def test_shared_vectors(self) -> None:
        h = sign_request(SECRET, "POST", "/v1/ask", POST_BODY, timestamp=TS, nonce=NONCE)
        self.assertEqual(h, {"X-AskWearables-Timestamp": str(TS), "X-AskWearables-Nonce": NONCE, "X-AskWearables-Signature": POST_SIG})
        g = sign_request(SECRET, "GET", "/v1/capabilities", b"", timestamp=TS, nonce=NONCE)
        self.assertEqual(g["X-AskWearables-Signature"], GET_SIG)

    def test_hmac(self) -> None:
        self.assertEqual(hmac_sha256_hex("k", "m"), hmac.new(b"k", b"m", hashlib.sha256).hexdigest())

    def test_nonces(self) -> None:
        seen = set()
        for _ in range(200):
            n = new_nonce()
            self.assertRegex(n, r"^[A-Za-z0-9_-]{16,64}$")
            seen.add(n)
        self.assertEqual(len(seen), 200)

    def test_webhook(self) -> None:
        body = '{"type":"grant.created","grant_id":"gr_1"}'
        sig = "sha256=" + hmac.new(b"whsec_x", f"1700000000.{body}".encode(), hashlib.sha256).hexdigest()
        self.assertTrue(verify_webhook("whsec_x", "1700000000", sig, body, now=1700000100))
        self.assertFalse(verify_webhook("whsec_x", "1700000000", sig, body + " ", now=1700000100))
        self.assertFalse(verify_webhook("whsec_x", "1700000000", sig, body, now=1700001000))
        self.assertFalse(verify_webhook("whsec_x", None, sig, body))


if __name__ == "__main__":
    unittest.main()
