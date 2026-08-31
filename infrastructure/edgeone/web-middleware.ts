const ACCESS_PATH = "/__beta/access";
const LOGOUT_PATH = "/__beta/logout";
const ACCESS_COOKIE = "__Host-jojo_beta_access";
const DEFAULT_BETA_HOST = "beta.jojokanbao.cn";
const DEFAULT_SESSION_HOURS = 24 * 7;
const MAX_FORM_BYTES = 4 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

type WebMiddlewareContext = {
  env?: Readonly<Record<string, string | undefined>>;
  next: () => Response | Promise<Response>;
  request: Request;
};

function betaHosts(environment: Readonly<Record<string, string | undefined>>): Set<string> {
  const configured = environment.JOJO_BETA_HOSTS?.trim() || DEFAULT_BETA_HOST;
  return new Set(
    configured
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

function sessionSeconds(environment: Readonly<Record<string, string | undefined>>): number {
  const configured = Number(environment.JOJO_BETA_SESSION_HOURS);
  const hours = Number.isFinite(configured) && configured >= 1 && configured <= 24 * 30
    ? configured
    : DEFAULT_SESSION_HOURS;
  return Math.floor(hours * 60 * 60);
}

function hexBytes(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes.buffer;
}

function bytesHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesHex(digest);
}

function equalHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sessionSignature(expiresAt: number, passwordHash: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexBytes(passwordHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`jojo-beta-access:v1:${expiresAt}`),
  );
  return bytesHex(signature);
}

async function sessionToken(expiresAt: number, passwordHash: string): Promise<string> {
  return `v1.${expiresAt}.${await sessionSignature(expiresAt, passwordHash)}`;
}

function cookieValue(headers: Headers, name: string): string | undefined {
  for (const item of (headers.get("cookie") || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

async function hasValidSession(request: Request, passwordHash: string): Promise<boolean> {
  const token = cookieValue(request.headers, ACCESS_COOKIE);
  const match = /^v1\.(\d+)\.([0-9a-f]{64})$/i.exec(token || "");
  if (!match) return false;
  const expiresAt = Number(match[1]);
  const signature = match[2];
  if (!signature) return false;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const expected = await sessionSignature(expiresAt, passwordHash);
  return equalHex(expected, signature.toLowerCase());
}

function accessCookie(token: string, maxAge: number): string {
  return [
    `${ACCESS_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function clearAccessCookie(): string {
  return `${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    Location: location,
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function configurationError(): Response {
  return new Response("Beta access is not configured.", {
    status: 503,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function accessPage(invalid = false): Response {
  const error = invalid
    ? '<p class="error" role="alert">通行码不正确，请检查后再试。</p>'
    : "";
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>JOJO Beta · 内部测试</title>
  <style>
    :root { color-scheme: light; --red: #8b1a1a; --ink: #202020; --paper: #fff; --soft: #f3efea; --muted: #6f6862; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--soft); color: var(--ink); font-family: "Noto Serif SC", "Songti SC", serif; }
    main { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) minmax(20rem, 34rem); }
    .masthead { position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; min-height: 100vh; padding: clamp(2rem, 6vw, 6rem); background: var(--red); color: var(--paper); }
    .brand { margin: 0; font: 700 clamp(1rem, 1.6vw, 1.35rem)/1.2 Arial, sans-serif; letter-spacing: .16em; }
    .edition { margin: 0; max-width: 11ch; font-size: clamp(3.8rem, 10vw, 9rem); font-weight: 900; line-height: .82; letter-spacing: -.08em; }
    .edition span { display: block; margin-top: .22em; font: 700 clamp(.8rem, 1.2vw, 1rem)/1.4 Arial, sans-serif; letter-spacing: .22em; }
    .rule { position: absolute; inset: 0 auto 0 42%; width: 1px; background: rgba(255,255,255,.35); transform: rotate(14deg); transform-origin: top; }
    .gate { display: flex; align-items: center; padding: clamp(2rem, 6vw, 5rem); background: var(--paper); border-left: 1px solid var(--ink); }
    .panel { width: 100%; }
    .eyebrow { margin: 0 0 1.4rem; color: var(--red); font: 700 .75rem/1 Arial, sans-serif; letter-spacing: .2em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(2.2rem, 5vw, 4.4rem); line-height: .98; letter-spacing: -.05em; }
    .intro { margin: 1.5rem 0 2.5rem; max-width: 31rem; color: var(--muted); font-size: 1rem; line-height: 1.8; }
    label { display: block; margin-bottom: .65rem; font: 700 .8rem/1.2 Arial, sans-serif; letter-spacing: .08em; }
    input { width: 100%; height: 3.4rem; padding: 0 .9rem; border: 1px solid var(--ink); border-radius: 0; background: var(--paper); color: var(--ink); font: 1rem/1 Arial, sans-serif; outline: none; }
    input:focus { border-color: var(--red); box-shadow: 4px 4px 0 rgba(139,26,26,.18); }
    button { width: 100%; min-height: 3.4rem; margin-top: .85rem; border: 1px solid var(--red); border-radius: 0; background: var(--red); color: var(--paper); font: 700 .9rem/1 Arial, sans-serif; letter-spacing: .12em; cursor: pointer; transition: transform .15s ease, box-shadow .15s ease; }
    button:hover { transform: translateY(-2px); box-shadow: 4px 4px 0 rgba(139,26,26,.18); }
    button:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
    .error { margin: 1rem 0 0; padding-left: .8rem; border-left: 3px solid var(--red); color: var(--red); font-size: .9rem; }
    .note { margin: 1.5rem 0 0; color: var(--muted); font: .75rem/1.6 Arial, sans-serif; }
    @media (max-width: 760px) {
      main { grid-template-columns: 1fr; }
      .masthead { min-height: 15rem; padding: 2rem; }
      .edition { font-size: 4rem; }
      .rule { left: 65%; }
      .gate { min-height: calc(100vh - 15rem); padding: 2.5rem 2rem; border-left: 0; border-top: 1px solid var(--ink); align-items: flex-start; }
    }
    @media (prefers-reduced-motion: reduce) { button { transition: none; } }
  </style>
</head>
<body>
  <main>
    <section class="masthead" aria-label="JOJO Beta">
      <p class="brand">JOJO 看报</p>
      <div class="rule" aria-hidden="true"></div>
      <p class="edition">BETA<span>内部测试版</span></p>
    </section>
    <section class="gate">
      <div class="panel">
        <p class="eyebrow">Preview access</p>
        <h1>输入通行码</h1>
        <p class="intro">这个版本正在小范围测试。请输入收到的通行码继续访问。</p>
        <form method="post" action="${ACCESS_PATH}">
          <label for="passphrase">通行码</label>
          <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
          <button type="submit">进入测试版</button>
        </form>
        ${error}
        <p class="note">通行权限仅保存在当前浏览器，到期后需要重新验证。</p>
      </div>
    </section>
  </main>
</body>
</html>`;
  return new Response(html, {
    status: invalid ? 401 : 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function unauthorized(request: Request): Response {
  const acceptsHtml = request.method === "GET"
    && (request.headers.get("accept") || "").includes("text/html");
  if (acceptsHtml) return redirect(ACCESS_PATH);
  return Response.json({ error: "Beta access required" }, {
    status: 401,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

async function protectedResponse(context: WebMiddlewareContext): Promise<Response> {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function middleware(context: WebMiddlewareContext): Promise<Response> {
  const environment = context.env ?? {};
  const url = new URL(context.request.url);
  const configuredBetaHost = betaHosts(environment).has(url.hostname.toLowerCase());
  const accessRequired = environment.JOJO_BETA_ACCESS_MODE?.trim().toLowerCase() === "required";

  if (!accessRequired) {
    // A custom Beta domain must never become public because an environment
    // variable was forgotten. Production and local hosts remain unaffected.
    if (configuredBetaHost) return configurationError();
    return context.next();
  }

  const passwordHash = environment.JOJO_BETA_ACCESS_PASSWORD_SHA256?.trim().toLowerCase() || "";
  if (!SHA256_PATTERN.test(passwordHash)) return configurationError();

  if (url.pathname === LOGOUT_PATH && context.request.method === "POST") {
    return redirect(ACCESS_PATH, clearAccessCookie());
  }

  if (url.pathname === ACCESS_PATH) {
    if (context.request.method === "GET" || context.request.method === "HEAD") {
      if (await hasValidSession(context.request, passwordHash)) return redirect("/");
      return accessPage();
    }
    if (context.request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD, POST", "Cache-Control": "private, no-store" },
      });
    }
    const declaredLength = Number(context.request.headers.get("content-length") || "0");
    if (declaredLength > MAX_FORM_BYTES) {
      return new Response("Request too large", { status: 413 });
    }
    let passphrase = "";
    try {
      const form = await context.request.formData();
      const value = form.get("passphrase");
      passphrase = typeof value === "string" ? value : "";
    } catch {
      return accessPage(true);
    }
    const submittedHash = await sha256Hex(passphrase);
    if (!equalHex(submittedHash, passwordHash)) return accessPage(true);
    const maxAge = sessionSeconds(environment);
    const expiresAt = Math.floor(Date.now() / 1000) + maxAge;
    return redirect("/", accessCookie(await sessionToken(expiresAt, passwordHash), maxAge));
  }

  if (!await hasValidSession(context.request, passwordHash)) {
    return unauthorized(context.request);
  }
  return protectedResponse(context);
}

export const config = {
  matcher: ["/:path*"],
};
