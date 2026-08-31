const BETA_HOSTNAME = "beta.jojokanbao.cn";

type WebMiddlewareContext = {
  next: () => Response | Promise<Response>;
  request: Request;
};

export async function middleware(context: WebMiddlewareContext): Promise<Response> {
  const response = await context.next();
  const hostname = new URL(context.request.url).hostname.toLowerCase();

  if (hostname !== BETA_HOSTNAME) return response;

  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const config = {
  matcher: ["/:path*"],
};
