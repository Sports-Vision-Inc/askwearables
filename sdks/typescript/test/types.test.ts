// The hand-written response types must stay compatible with the generated (looser) ones.
import { describe, expectTypeOf, it } from "vitest";
import type {
  Capabilities, CapabilitiesResponseBody, CreatedUser, CreateUserResponseBody, GrantLink, CreateGrantLinkResponseBody,
  IngestResult, IngestResponseBody, UsageDay, UsageResponseBody, QueryResult, AskResponse, PublicMetricId, QuerySpec, MetricId, GrantRequest,
} from "../src/index.js";

describe("types", () => {
  it("refine the generated types", () => {
    expectTypeOf<Capabilities>().toMatchTypeOf<CapabilitiesResponseBody>();
    expectTypeOf<CreatedUser>().toMatchTypeOf<CreateUserResponseBody>();
    expectTypeOf<GrantLink>().toMatchTypeOf<CreateGrantLinkResponseBody>();
    expectTypeOf<IngestResult>().toMatchTypeOf<IngestResponseBody>();
    expectTypeOf<UsageDay[]>().toMatchTypeOf<UsageResponseBody>();
    expectTypeOf<AskResponse>().toMatchTypeOf<QueryResult>();
    expectTypeOf<PublicMetricId>().toEqualTypeOf<QuerySpec["metrics"][number]>();
    expectTypeOf<MetricId>().toEqualTypeOf<GrantRequest["metrics"][number]>();
  });
});
