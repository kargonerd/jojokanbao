import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialAdminHandler } from "../src/edgeone/credential-admin";

afterEach(() => vi.unstubAllGlobals());
describe("credential administration authorization", () => {
  it.each([undefined, ["librarian"], ["moderator"], "admin"])("rejects non-admin server roles %s", async (roles) => {
    const createCredentialStore = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({id:"reader",app_metadata:{jojo_roles:roles},user_metadata:{jojo_roles:["admin"]}})));
    const response = await createCredentialAdminHandler({ createCredentialStore })({
      env:{VITE_SUPABASE_URL:"https://db.example",VITE_SUPABASE_PUBLISHABLE_KEY:"public"},
      request:new Request("https://agent.example/gateway/credentials",{method:"POST",headers:{Authorization:"Bearer reader-session"},body:"{}"}),
    });
    expect(response.status).toBe(403);
    expect(createCredentialStore).not.toHaveBeenCalled();
  });
  it("verifies an admin session with the auth server before parsing uploads", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({id:"admin",app_metadata:{jojo_roles:["admin"]}}));
    vi.stubGlobal("fetch", fetcher);
    const response = await createCredentialAdminHandler()({
      env:{VITE_SUPABASE_URL:"https://db.example",VITE_SUPABASE_PUBLISHABLE_KEY:"public"},
      request:new Request("https://agent.example/gateway/credentials",{method:"POST",headers:{Authorization:"Bearer admin-session"},body:"{}"}),
    });
    expect(response.status).toBe(400);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://db.example/auth/v1/user");
  });
});
