import { useAdminSession } from "./session";

export async function adminFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) useAdminSession.setState({ user: null, ready: true, error: "登录已失效，请重新登录。" });
  if (response.status === 403) void useAdminSession.getState().restore();
  return response;
}
