/**
 * Vercel Function — Clerk Frontend API proxy for the Production instance.
 *
 * The Production Clerk domain is a Vercel provider domain (sensepro-six.vercel.app).
 * Clerk normally serves its Frontend API from clerk.<domain>, which needs a CNAME
 * record — impossible on a shared *.vercel.app host. clerk.sensepro-six.vercel.app
 * therefore refuses the TLS handshake and ClerkJS never loads
 * (net::ERR_CONNECTION_CLOSED on clerk.browser.js). Clerk's answer for provider
 * domains is to proxy the Frontend API through the app's own origin: everything
 * under https://sensepro-six.vercel.app/__clerk/* is forwarded to
 * https://frontend-api.clerk.dev/*, carrying the headers Clerk needs to resolve
 * the instance (Clerk-Proxy-Url, Clerk-Secret-Key) and to keep rate limiting and
 * bot protection accurate (X-Forwarded-For).
 *
 * Behaviour follows Clerk's own reference implementation (clerkFrontendApiProxy
 * in @clerk/backend/proxy): hop-by-hop headers are dropped in both directions,
 * the upstream is asked for an identity encoding so the body streams through
 * untouched, Set-Cookie is preserved as separate headers rather than collapsed
 * into one, and a Location pointing back at the Frontend API is rewritten onto
 * the proxy so redirects stay on this origin.
 *
 * Routing (vercel.json): /__clerk and /__clerk/* rewrite here with the original
 * path carried in the __clerk_proxy_path query parameter, because a Vercel
 * function can only live under /api and the rewrite is what puts it on /__clerk.
 *
 * Server-side environment — never VITE_, never reaches the browser:
 *   CLERK_SECRET_KEY       required. Production secret key. Sent only upstream.
 *   CLERK_PUBLISHABLE_KEY  optional. Selects the Frontend API environment
 *                          (production / staging / local). Not a secret.
 *   CLERK_PROXY_URL        optional. Pins the Clerk-Proxy-Url header. Defaults
 *                          to this request's own public origin + /__clerk.
 *   CLERK_FAPI_URL         optional. Overrides the Frontend API base outright.
 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Frontend API bases and the default proxy path, mirroring @clerk/shared/constants.
const PROD_FAPI_URL = "https://frontend-api.clerk.dev";
const STAGING_FAPI_URL = "https://frontend-api.clerkstage.dev";
const LOCAL_FAPI_URL = "https://frontend-api.lclclerk.com";
const LEGACY_DEV_INSTANCE_SUFFIXES = [".lcl.dev", ".lclstage.dev", ".lclclerk.com"];
const LOCAL_ENV_SUFFIXES = [".lcl.dev", "lclstage.dev", ".lclclerk.com", ".accounts.lclclerk.com"];
const STAGING_ENV_SUFFIXES = [".accountsstage.dev"];

const PROXY_PATH = "/__clerk";
const FUNCTION_PATH = "/api/clerk-proxy";
const PATH_PARAM = "__clerk_proxy_path";

// RFC 7230 hop-by-hop headers: meaningful to one connection only, never relayed.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// fetch() transparently decompresses, so the upstream content-encoding and the
// content-length that goes with it both describe a body we are no longer sending.
const RESPONSE_HEADERS_TO_STRIP = new Set(["content-encoding", "content-length"]);

function stripTrailingSlashes(value) {
  let out = value;
  while (out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** Header names listed in `Connection:` are hop-by-hop for this message only. */
function connectionTokens(connectionHeader) {
  const value = firstValue(connectionHeader);
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** `pk_live_<base64>` / `pk_test_<base64>` decodes to "<frontend api host>$". */
function frontendApiFromPublishableKey(publishableKey) {
  const parts = (publishableKey || "").split("_");
  if (parts.length < 3 || parts[0].toLowerCase() !== "pk") return "";
  try {
    const decoded = Buffer.from(parts.slice(2).join("_"), "base64").toString("utf8");
    return decoded.endsWith("$") ? decoded.slice(0, -1) : "";
  } catch {
    return "";
  }
}

function normalizeFapiUrl(fapiUrl) {
  const url = new URL(fapiUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Frontend API URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Frontend API URL must not include credentials, a query string, or a hash");
  }
  return stripTrailingSlashes(url.toString());
}

/**
 * Which Frontend API this instance lives behind. Derived the way Clerk derives
 * it, so the target is never a guess: an explicit CLERK_FAPI_URL wins, otherwise
 * the publishable key decides, otherwise production.
 */
function resolveFapiBaseUrl() {
  const configured = process.env.CLERK_FAPI_URL;
  if (configured) return normalizeFapiUrl(configured);

  const frontendApi = frontendApiFromPublishableKey(process.env.CLERK_PUBLISHABLE_KEY);
  if (frontendApi) {
    const isLegacyDev =
      frontendApi.startsWith("clerk.") &&
      LEGACY_DEV_INSTANCE_SUFFIXES.some((suffix) => frontendApi.endsWith(suffix));
    if (!isLegacyDev) {
      if (LOCAL_ENV_SUFFIXES.some((suffix) => frontendApi.endsWith(suffix))) return LOCAL_FAPI_URL;
      if (STAGING_ENV_SUFFIXES.some((suffix) => frontendApi.endsWith(suffix)))
        return STAGING_FAPI_URL;
    }
  }
  return PROD_FAPI_URL;
}

/**
 * The path Clerk actually asked for. The rewrite hands it over in a query
 * parameter; the pathname fallback covers a direct hit on /api/clerk-proxy.
 */
function readTargetPath(requestUrl) {
  const fromQuery = requestUrl.searchParams.get(PATH_PARAM);
  if (fromQuery) return fromQuery.startsWith("/") ? fromQuery : `/${fromQuery}`;
  if (requestUrl.pathname.startsWith(FUNCTION_PATH)) {
    return requestUrl.pathname.slice(FUNCTION_PATH.length) || "/";
  }
  return "/";
}

/**
 * Drop our own routing parameter without re-encoding the rest: Clerk sends
 * percent-encoded redirect URLs through here and they must arrive byte-identical.
 */
function stripProxyPathParam(search) {
  if (!search) return "";
  const kept = search
    .slice(1)
    .split("&")
    .filter((pair) => pair && pair !== PATH_PARAM && !pair.startsWith(`${PATH_PARAM}=`));
  return kept.length ? `?${kept.join("&")}` : "";
}

/**
 * The end user's IP, not the last hop. Clerk rate-limits and scores bot traffic
 * on this value, so handing it the edge's own address would pool every visitor
 * behind a single address.
 */
function getClientIp(headers) {
  const cfConnectingIp = firstValue(headers["cf-connecting-ip"]);
  if (cfConnectingIp) return cfConnectingIp;
  const realIp = firstValue(headers["x-real-ip"]);
  if (realIp) return realIp;
  const forwardedFor = firstValue(headers["x-forwarded-for"]);
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return undefined;
}

function sendError(res, status, code, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ errors: [{ code, message }] }));
}

export default async function handler(req, res) {
  // Read straight from process.env and forward it upstream. It is never logged,
  // never echoed into a response body, and never reaches the client bundle.
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    sendError(
      res,
      500,
      "proxy_configuration_error",
      "Missing CLERK_SECRET_KEY. Set it as a server-side environment variable on this deployment.",
    );
    return;
  }

  const proto = firstValue(req.headers["x-forwarded-proto"])?.split(",")[0]?.trim() || "https";
  const host =
    firstValue(req.headers["x-forwarded-host"])?.split(",")[0]?.trim() ||
    firstValue(req.headers.host) ||
    "localhost";
  const publicOrigin = `${proto}://${host}`;

  let requestUrl;
  try {
    requestUrl = new URL(req.url || "/", publicOrigin);
  } catch {
    sendError(res, 400, "proxy_request_failed", "Could not parse the incoming request URL");
    return;
  }

  // Must equal the proxy URL registered on the Clerk Dashboard domain exactly,
  // or Clerk cannot resolve which instance the request belongs to.
  const proxyUrl = stripTrailingSlashes(
    process.env.CLERK_PROXY_URL || `${publicOrigin}${PROXY_PATH}`,
  );

  let fapiBaseUrl;
  try {
    fapiBaseUrl = resolveFapiBaseUrl();
  } catch (error) {
    sendError(
      res,
      500,
      "proxy_configuration_error",
      error instanceof Error ? error.message : "Invalid Frontend API URL",
    );
    return;
  }
  const fapiHost = new URL(fapiBaseUrl).host;

  const targetUrl = new URL(`${fapiBaseUrl}${readTargetPath(requestUrl)}`);
  targetUrl.search = stripProxyPathParam(requestUrl.search);
  if (targetUrl.host !== fapiHost) {
    sendError(res, 400, "proxy_request_failed", "Resolved target does not match the expected host");
    return;
  }

  const headers = new Headers();
  const requestHopByHop = connectionTokens(req.headers.connection);
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || requestHopByHop.has(lower)) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, single);
      } catch {
        // A header name or value Headers rejects is not one Clerk needs.
      }
    }
  }

  headers.set("Clerk-Proxy-Url", proxyUrl);
  headers.set("Clerk-Secret-Key", secretKey);
  headers.set("Host", fapiHost);
  // Identity encoding: fetch would otherwise decompress the body and leave the
  // upstream's content-encoding describing bytes we no longer have.
  headers.set("Accept-Encoding", "identity");
  if (!headers.has("X-Forwarded-Host")) headers.set("X-Forwarded-Host", requestUrl.host);
  if (!headers.has("X-Forwarded-Proto")) headers.set("X-Forwarded-Proto", proto);
  const clientIp = getClientIp(req.headers);
  if (clientIp) headers.set("X-Forwarded-For", clientIp);

  const method = (req.method || "GET").toUpperCase();
  const fetchOptions = { method, headers, redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    // The raw stream, untouched. Clerk posts application/x-www-form-urlencoded
    // for sign-in and sign-up, which any parse-and-reserialise step corrupts.
    fetchOptions.body = Readable.toWeb(req);
    fetchOptions.duplex = "half";
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), fetchOptions);
  } catch (error) {
    console.error(
      "[clerk-proxy] upstream request failed:",
      error instanceof Error ? error.message : error,
    );
    sendError(res, 502, "proxy_request_failed", "Failed to reach the Clerk Frontend API");
    return;
  }

  res.statusCode = upstream.status;
  if (upstream.statusText) res.statusMessage = upstream.statusText;

  const responseHopByHop = connectionTokens(upstream.headers.get("connection"));
  const setCookiesFromIteration = [];
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      RESPONSE_HEADERS_TO_STRIP.has(lower) ||
      responseHopByHop.has(lower)
    ) {
      return;
    }
    if (lower === "set-cookie") {
      setCookiesFromIteration.push(value);
      return;
    }
    if (lower === "location") return;
    res.setHeader(name, value);
  });

  // Every cookie as its own header. Clerk's session state lives in __client,
  // __session and __client_uat; comma-joining them loses all but the first.
  const setCookies =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : setCookiesFromIteration;
  if (setCookies.length) res.setHeader("set-cookie", setCookies);

  // A redirect back to the Frontend API host would leave the proxy and hit the
  // domain that does not resolve, so point it at this origin instead.
  const location = upstream.headers.get("location");
  if (location) {
    let rewritten = location;
    try {
      const locationUrl = new URL(location, fapiBaseUrl);
      if (locationUrl.host === fapiHost) {
        rewritten = `${proxyUrl}${locationUrl.pathname}${locationUrl.search}${locationUrl.hash}`;
      }
    } catch {
      // Not a URL we can reason about; relay it unchanged.
    }
    res.setHeader("Location", rewritten);
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    console.error(
      "[clerk-proxy] response stream failed:",
      error instanceof Error ? error.message : error,
    );
    res.destroy();
  }
}
