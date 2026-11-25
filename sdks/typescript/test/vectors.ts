// Shared signing vectors. sdks/python/tests/test_signing.py asserts the same values.
export const VECTOR = {
  secret: "awsig_test_secret",
  timestamp: 1764000000,
  nonce: "nonce_0123456789abcdef",
  post: {
    method: "POST",
    path: "/v1/ask",
    body: '{"question":"How did I sleep this week?"}',
    bodySha256: "a8b7892ebafeffb3771338007f06dd84cd8c161bfe6a9383b0fc2af6343c1c27",
    signature: "c00036058439b1f4ebdabccdc459f531e1e671cd7d372dfa312456ce9cb6e604",
  },
  get: {
    method: "GET",
    path: "/v1/capabilities",
    body: "",
    bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    signature: "6460c6bb22e06738d1a8cf33e34ab59e1c5da68de06f50922ceb2ab05113500e",
  },
};
