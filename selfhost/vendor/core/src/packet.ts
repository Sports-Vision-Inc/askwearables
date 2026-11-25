// The packet builder: the one response contract every agent receives.
import type { ComputeResult, LeveledFinding } from "./compute.js";
import { canonicalJson, contentId, estimateTokens, sha256Hex } from "./hash.js";
import type { Finding, Level, Packet } from "./types.js";

export const PACKET_VERSION = "1" as const;
export const MAX_PACKET_TOKENS = 400;

function atLevel(f: LeveledFinding, level: Level): Finding {
  const base = { metric: f.metric } as Finding;
  if (f.unknown_reason) base.unknown_reason = f.unknown_reason;
  switch (level) {
    case 0:
      return { ...base, flag: f.l0.flag, statement: f.l0.statement };
    case 1:
      return { ...base, direction: f.l1.direction, magnitude: f.l1.magnitude, statement: f.l1.statement };
    case 2:
    case 3: {
      const out: Finding = { ...base, direction: f.l1.direction, magnitude: f.l1.magnitude, statement: f.l2.statement };
      if (f.l2.value !== undefined) out.value = f.l2.value;
      if (f.l2.unit !== undefined) out.unit = f.l2.unit;
      if (f.l2.values) out.values = f.l2.values;
      if (level === 3 && f.l3) out.raw = f.l3.raw;
      return out;
    }
  }
}

/**
 * Build the packet at one release level. The packet holds nothing below its level, never a grade or
 * diagnosis, and is byte-identical for the same spec, level, data_version and as_of hour.
 */
export async function buildPacket(result: ComputeResult, level: Level): Promise<Packet> {
  const findings = result.findings.map((f) => atLevel(f, level));
  const dq = { ...result.quality, caveats: [...result.quality.caveats] };
  const body = {
    packet_version: PACKET_VERSION,
    level,
    operation: result.spec.operation,
    metrics: result.spec.metrics,
    window: result.spec.window,
    findings,
    data_quality: dq,
    as_of: result.as_of,
    data_version: result.data_version,
    not_medical_advice: true as const,
  };
  const packet_id = await contentId("pk", { spec: result.spec, level, data_version: result.data_version, as_of: result.as_of });
  const packet: Packet = { ...body, packet_id };
  if (level < 3) shrinkToLimit(packet);
  return packet;
}

/** Keep level 0-2 packets at or under the token limit: drop the oldest values first, then extra caveats. */
function shrinkToLimit(p: Packet) {
  const tooBig = () => estimateTokens(p) > MAX_PACKET_TOKENS;
  for (const f of p.findings) {
    while (tooBig() && f.values && f.values.length > 3) f.values.shift();
  }
  while (tooBig() && p.data_quality.caveats.length > 2) p.data_quality.caveats.pop();
  for (const f of p.findings) if (tooBig() && f.values) delete f.values;
}

export async function packetHash(p: Packet): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(p))}`;
}

export function serializePacket(p: Packet): string {
  return canonicalJson(p);
}
