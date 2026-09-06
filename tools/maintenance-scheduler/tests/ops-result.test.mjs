import { describe, expect, it } from "vitest";
import { verifiedProbe } from "../../../infrastructure/tencent-scf/maintenance-scheduler/ops.mjs";
describe("deployment probe gates", () => {
  it("rejects HTTP-success responses containing a SCF execution failure", () => {
    expect(() => verifiedProbe({Result:{RetMsg:JSON.stringify({errorCode:-1,stackTrace:"Error: state unavailable\ninternal stack"})}})).toThrow("Read-only probe failed: Error: state unavailable");
    expect(() => verifiedProbe({Result:{RetMsg:"{}"}})).toThrow("Read-only probe failed");
    const body={mode:"shadow",connectivity:[{ok:true},{ok:true}],state:{backend:"cloudflare"}};
    expect(verifiedProbe({Result:{RetMsg:JSON.stringify(body)}})).toEqual(body);
  });
});
