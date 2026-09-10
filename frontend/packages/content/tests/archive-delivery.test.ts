import { describe, expect, it, vi } from "vitest";
import { loadArchivePdf } from "../src/archive-delivery";
import { JoxClient, transformJoxBytes } from "../src/jox";
import { gzipSync, strToU8 } from "fflate";

function fixture(publication = "rmrb", issue = "1976-10-09") {
  const newspaper = publication === "rmrb" || publication === "ckxx";
  const indexKey = `content/newspapers/${publication}/index.jox`;
  const itemPath = newspaper ? `items/${issue.slice(0, 4)}/${issue.slice(5, 7)}/${issue}/manifest.jox` : `items/${issue.slice(0, 4)}/${issue}/manifest.jox`;
  const manifestKey = `${indexKey.slice(0, -9)}${itemPath}`;
  const objects: Record<string, unknown> = {
    "catalog.jox": { formatVersion: "jojo-catalog/1", datasets: [{ datasetId: publication, indexObject: indexKey }] },
    [indexKey]: { formatVersion: "jojo-delivery-index/1", datasetId: publication,
      ...(newspaper ? { itemPath: "items/{YYYY}/{MM}/{YYYY-MM-DD}/manifest.jox" } : { items: [{ itemKey: issue, manifestObject: itemPath }] }),
    },
    [manifestKey]: { formatVersion: "jojo-item-manifest/1", itemId: `${publication}:${issue}`, datasetId: publication,
      assets: [{ type: "pdf", role: "issue-pdf", mediaType: "application/pdf", object: "assets/changed-name.pdf.jox", sha256: "new-revision" }],
    },
  };
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const key = new URL(String(input)).pathname.slice(1);
    if (!(key in objects)) return new Response(null, { status: 404 });
    return new Response(transformJoxBytes(gzipSync(strToU8(JSON.stringify(objects[key]))), key).slice().buffer);
  });
  return { objects, manifestKey, fetchFn, client: new JoxClient("https://cdn.example/", fetchFn) };
}

describe("Archive Delivery PDFs", () => {
  it.each([["rmrb", "1976-10-09", "19761009"], ["ckxx", "1976-09-10", "19760910"],
    ["hq", "196419", "196419"], ["rmhb", "197292", "197292"], ["sjzs", "196513", "196513"]] as const)(
    "resolves %s from the catalog, index and manifest", async (publication, itemKey, routeId) => {
      const { client, manifestKey, fetchFn } = fixture(publication, itemKey);
      const objectKey = manifestKey.replace("manifest.jox", "assets/changed-name.pdf.jox");
      await expect(loadArchivePdf(client, publication, routeId)).resolves.toEqual({ objectKey, url: `https://cdn.example/${objectKey}?v=new-revision` });
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(fetchFn.mock.calls.every(([input]) => !/\/(RMRB|CKXX|HQ|RMHB|SJZS)\//.test(String(input)))).toBe(true);
    },
  );

  it("reports a missing PDF without requesting an old directory", async () => {
    const { client, objects, manifestKey, fetchFn } = fixture();
    Object.assign(objects[manifestKey] as object, { availability: { pdf: "missing" } });
    await expect(loadArchivePdf(client, "rmrb", "19761009")).rejects.toThrow("暂无 PDF");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("rejects the wrong issue rather than showing another day's PDF", async () => {
    const { client, objects, manifestKey } = fixture();
    Object.assign(objects[manifestKey] as object, { itemId: "rmrb:1976-10-08" });
    await expect(loadArchivePdf(client, "rmrb", "19761009")).rejects.toThrow("不匹配");
  });

  it("rejects impossible dates before fetching", async () => {
    const { client, fetchFn } = fixture();
    await expect(loadArchivePdf(client, "rmrb", "19760231")).rejects.toThrow("无效");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
