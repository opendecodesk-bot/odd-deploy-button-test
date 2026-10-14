/**
 * Shared JSON response helpers for the API handlers.
 */
export function jsonResponse(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

// ---- Features (Global settings → Features; db.js FEATURES) --------------------------------------
// The answer every handler gives for something that belongs to a switched-off feature.
export function featureOffResponse(key, label){
  return jsonResponse({ status: "error", feature: key,
    message: `${label || key} is turned off. Turn it on under Tools → Global settings → Features.` }, 403);
}
// For handlers that don't already hold the cached catalog: is this feature switched off? One small
// read. Anything unexpected (no database, nothing saved, a read error) counts as ON — the default.
// (A plain function returning a promise: some test harnesses only strip "export function".)
export function featureIsOff(env, key){
  return (async () => {
    try{
      const row = await env.DB.prepare("SELECT value FROM global_settings WHERE key='features'").first();
      return !!row && JSON.parse(row.value)[key] === false;
    }catch(e){ return false; }
  })();
}
