const errors = [];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    errors.push(`${name} is required`);
    return null;
  }
  return value;
}

function absoluteUrl(name, value, protocol) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== protocol) {
      errors.push(`${name} must use ${protocol}`);
    }
    if (parsed.username || parsed.password) {
      errors.push(`${name} must not contain credentials`);
    }
    if (parsed.hash) {
      errors.push(`${name} must not contain a fragment`);
    }
    return parsed;
  } catch {
    errors.push(`${name} must be an absolute URL`);
    return null;
  }
}

function jwtRole(value) {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

const apiBase = required("VITE_API_BASE");
const apiUrl = absoluteUrl("VITE_API_BASE", apiBase, "https:");
if (apiUrl && (apiUrl.search || apiUrl.hash)) {
  errors.push("VITE_API_BASE must not contain a query or fragment");
}
if (apiBase?.endsWith("/")) {
  errors.push("VITE_API_BASE must not end with a slash");
}

const wsValue = required("VITE_WS_URL");
const wsUrl = absoluteUrl("VITE_WS_URL", wsValue, "wss:");
if (wsUrl && wsUrl.pathname !== "/ws/capture") {
  errors.push("VITE_WS_URL must point to /ws/capture");
}

const supabaseValue = required("VITE_SUPABASE_URL");
const supabaseUrl = absoluteUrl("VITE_SUPABASE_URL", supabaseValue, "https:");
if (supabaseUrl && (supabaseUrl.search || supabaseUrl.hash)) {
  errors.push("VITE_SUPABASE_URL must not contain a query or fragment");
}
if (supabaseValue?.endsWith("/")) {
  errors.push("VITE_SUPABASE_URL must not end with a slash");
}

const browserKey = required("VITE_SUPABASE_ANON_KEY");
if (browserKey) {
  const role = jwtRole(browserKey);
  if (browserKey.startsWith("sb_secret_") || role === "service_role") {
    errors.push("VITE_SUPABASE_ANON_KEY must be a browser-safe publishable or anon key");
  }
}

const clerkPublishableKey = required("VITE_CLERK_PUBLISHABLE_KEY");
if (clerkPublishableKey && !/^pk_(test|live)_/.test(clerkPublishableKey)) {
  errors.push("VITE_CLERK_PUBLISHABLE_KEY must be a Clerk publishable key");
}

const clerkProxyValue = required("VITE_CLERK_PROXY_URL");
const clerkProxyUrl = absoluteUrl("VITE_CLERK_PROXY_URL", clerkProxyValue, "https:");
if (clerkProxyUrl && clerkProxyUrl.pathname !== "/__clerk") {
  errors.push("VITE_CLERK_PROXY_URL must point to /__clerk");
}
if (clerkProxyUrl && (clerkProxyUrl.search || clerkProxyUrl.hash)) {
  errors.push("VITE_CLERK_PROXY_URL must not contain a query or fragment");
}

const clerkSecretKey = required("CLERK_SECRET_KEY");
if (clerkSecretKey && !/^sk_(test|live)_/.test(clerkSecretKey)) {
  errors.push("CLERK_SECRET_KEY must be a server-side Clerk secret key");
}

if (errors.length > 0) {
  console.error("Deployment environment validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Deployment environment validation passed.");
