/**
 * D1-backed rate limiter for edge Functions.
 * ========================================================================
 * Fixed 60-second window per (bucket, client IP), stored in the D1
 * `rate_limits` table (migrations/0005).
 *
 * ---- WHY D1, NOT KV ----
 * A limiter writes on nearly every rate-limited request. Workers KV's free
 * tier allows only 1,000 writes/day across the whole account; D1's allows
 * 100,000 row writes/day, and an UPSERT … RETURNING increments atomically,
 * so counts are exact rather than best-effort read-then-write.
 *
 * ---- TWO MODES ----
 * - rateLimited(): counts EVERY request (public endpoints: order submit,
 *   checkout, shipping quotes, login attempts). One D1 row write per call.
 * - rateLimitCheck() + rateLimitHit(): check without writing, and count
 *   only FAILURES. requireAdmin() uses this, so normal admin-panel clicks
 *   with a valid session write nothing at all; only wrong guesses count.
 *
 * ---- RESILIENCE ----
 * A D1 error (table not migrated yet, outage) never takes the storefront or
 * admin panel down — but it doesn't switch limiting OFF either (failed admin
 * logins must still be counted during a D1 outage). The
 * counts fall back to this isolate's memory for the window, so the same
 * limits still apply per IP (per isolate) until D1 is back. No D1 binding at
 * all (local dev / tests) still means no limiting. Once an isolate has seen
 * an IP over the limit, it short-circuits in memory for the rest of that
 * window, so a blocked burst doesn't keep costing D1 writes.
 *
 * A Cloudflare WAF rate-limiting rule (the free plan includes one) is the
 * better tool against a large distributed flood, since it stops requests
 * before any Function runs.
 */

const WINDOW_SECONDS = 60;
const CLEANUP_PROBABILITY = 0.02; // ~1 in 50 writes also sweeps expired rows

function clientIp(request){
  return (request && request.headers && request.headers.get("CF-Connecting-IP")) || "unknown";
}

function hasDb(env){
  return !!(env && env.DB && typeof env.DB.prepare === "function");
}

// Per-isolate "already blocked this window" cache, keyed like the D1 rows.
// Old windows' keys simply stop being looked up; the map stays tiny.
const _blocked = new Map();
// Per-isolate fallback counts, used only while D1 is erroring. Pruned of past windows as it grows.
const _memCount = new Map();
function memIncrement(w){
  if(_memCount.size > 5000){ for(const [k, v] of _memCount) if(v.expiresAt < w.nowSeconds) _memCount.delete(k); }
  const cur = _memCount.get(w.key) || { count: 0, expiresAt: w.expiresAt };
  cur.count++; _memCount.set(w.key, cur);
  return cur.count;
}
function memCount(w){ const cur = _memCount.get(w.key); return cur ? cur.count : 0; }

function windowInfo(bucket, request){
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowIndex = Math.floor(nowSeconds / WINDOW_SECONDS);
  const windowEnd = (windowIndex + 1) * WINDOW_SECONDS;
  return {
    key: "rl:" + bucket + ":" + clientIp(request) + ":" + windowIndex,
    retryAfter: Math.max(windowEnd - nowSeconds, 1),
    expiresAt: windowEnd + WINDOW_SECONDS, // keep one extra window, then sweep
    nowSeconds,
  };
}

function blockedResult(w){
  return { blocked: true, retryAfter: w.retryAfter };
}
const OPEN = { blocked: false, retryAfter: 0 };

// Atomic +1; returns the new count.
async function increment(db, w){
  const row = await db.prepare(
    "INSERT INTO rate_limits (key, count, expiresAt) VALUES (?, 1, ?) " +
    "ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count"
  ).bind(w.key, w.expiresAt).first();
  if(Math.random() < CLEANUP_PROBABILITY){
    await db.prepare("DELETE FROM rate_limits WHERE expiresAt < ?").bind(w.nowSeconds).run();
  }
  return Number(row && row.count) || 0;
}

// Counts this request and reports whether it's over `limit` for the window.
// Returns {blocked, retryAfter}. `bucket` groups call sites under one budget.
export async function rateLimited(env, bucket, request, limit){
  if(!hasDb(env)) return OPEN; // local dev / tests without a D1 binding
  const w = windowInfo(bucket, request);
  if(_blocked.has(w.key)) return blockedResult(w);
  try{
    const count = await increment(env.DB, w);
    if(count > limit){ _blocked.set(w.key, true); return blockedResult(w); }
    return OPEN;
  }catch(err){
    console.error("Rate limiter error (bucket=" + bucket + "), counting in memory:", err);
    if(memIncrement(w) > limit){ _blocked.set(w.key, true); return blockedResult(w); }
    return OPEN;
  }
}

// Read-only: is this IP already at/over `limit` in this window? No write.
export async function rateLimitCheck(env, bucket, request, limit){
  if(!hasDb(env)) return OPEN;
  const w = windowInfo(bucket, request);
  if(_blocked.has(w.key)) return blockedResult(w);
  try{
    const row = await env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?").bind(w.key).first();
    if(row && Number(row.count) >= limit){ _blocked.set(w.key, true); return blockedResult(w); }
    return OPEN;
  }catch(err){
    console.error("Rate limiter check error (bucket=" + bucket + "), checking memory:", err);
    if(memCount(w) >= limit){ _blocked.set(w.key, true); return blockedResult(w); }
    return OPEN;
  }
}

// Record one failure against the bucket (pairs with rateLimitCheck).
export async function rateLimitHit(env, bucket, request){
  if(!hasDb(env)) return;
  const w = windowInfo(bucket, request);
  try{ await increment(env.DB, w); }
  catch(err){ console.error("Rate limiter hit error (bucket=" + bucket + "), counting in memory:", err); memIncrement(w); }
}

export function rateLimitResponse(retryAfter){
  return new Response(JSON.stringify({status:"error", message:"Too many requests — try again shortly."}), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) }
  });
}
