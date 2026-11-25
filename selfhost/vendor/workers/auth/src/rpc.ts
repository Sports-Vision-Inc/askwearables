// The RPC surface other Workers see through their AUTH service binding.
import type { ValidatedAccessToken } from "@cloudflare/workers-oauth-provider";

export interface AgentTokenProps {
  userId: string;
  agentId: string;
  grantId: string;
}

export interface AuthRpc {
  validateToken(resource: string, token: string): Promise<ValidatedAccessToken<AgentTokenProps> | null>;
  /** The signed-in owner for a session cookie value, or null. */
  sessionUser(cookieValue: string): Promise<{ userId: string; role: string } | null>;
  /** Revoke OAuth grants (and their tokens) for one agent, or all agents when clientId is null. */
  revokeAgentTokens(userId: string, clientId: string | null): Promise<number>;
}

export const SESSION_COOKIE = "__Secure-aw_session";
