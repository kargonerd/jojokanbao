import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import { requestTencent } from "../purge-cache.mjs";

test("uses the existing tccli profile with a JSON file, normalizes its response and cleans up", async () => {
  let input;
  const payload = { ZoneId: "zone-example", Type: "purge_url", Targets: ["https://example.test/catalog.jox"] };
  const result = await requestTencent({
    action: "CreatePurgeTask", credential: null, endpoint: "teo.tencentcloudapi.com", payload,
    runCli: async (command, args, options) => {
      assert.equal(command, "tccli");
      assert.equal(args[1], "CreatePurgeTask");
      input = args[3].slice("file://".length);
      assert.deepEqual(JSON.parse(await readFile(input, "utf8")), payload);
      assert.equal(options.windowsHide, true);
      assert.equal(args.some(arg => /secretId|secretKey|token/.test(arg)), false);
      return { stdout: JSON.stringify({ JobId: "cache-job", FailedList: [] }) };
    },
  });
  assert.equal(result.Response.JobId, "cache-job");
  await assert.rejects(access(input));
});

test("preserves domain mismatch for zone fallback and removes the temporary request on failure", async () => {
  let input;
  await assert.rejects(requestTencent({
    action: "CreatePurgeTask", credential: null, endpoint: "teo.tencentcloudapi.com", payload: {},
    runCli: async (_command, args) => {
      input = args[3].slice("file://".length);
      throw Object.assign(new Error("cli failed"), { stderr: "InvalidParameter.DomainNotFound" });
    },
  }), /InvalidParameter.DomainNotFound/);
  await assert.rejects(access(input));
});
