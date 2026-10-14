/**
 * D1 query helpers. All functions take `env.DB` as their first argument.
 *
 * insertOrder() is the most critical: it uses D1 batch() to write the orders
 * row + all order_items rows in a single atomic transaction.
 *
 * priceItem() performs server-side pricing from the products table — the
 * client-supplied unit price is never trusted.
 *
 * MONEY: every amount is stored as INTEGER CENTS in *Cents columns
 * (migrations/0006). This file is the only place that converts: callers pass
 * and receive DOLLARS. Totals are summed in cents, never in floating-point
 * dollars.
 *
 * DATES: "not set" is NULL in the database. The parse*_ helpers hand callers
 * "" for unset dates, which is what the admin and storefront expect.
 *
 * PAID: the payments ledger (order_payments) is the source of truth.
 * orders.paid/paidAt are a cache that refreshPaidStatus() recomputes after
 * anything that changes what's owed or what's been received.
 */

// ---- Money helpers -------------------------------------------------------
const toCents = (dollars) => {
  const n = Number(dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const toCentsOrNull = (dollars) =>
  (dollars === null || dollars === undefined || dollars === "") ? null : toCents(dollars);
const fromCents = (cents) => (Number(cents) || 0) / 100;
const fromCentsOrNull = (cents) => (cents === null || cents === undefined) ? null : Number(cents) / 100;
const mapValues_ = (obj, fn) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, fn(v)]));

// An error whose message is safe to show a customer (e.g. "Size XL not
// available"). Anything else thrown while pricing is internal and reaches the
// storefront only as a generic message (orders.js).
function pricingError_(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

// ---- Sales tax (migrations/0007, 0052) -------------------------------------
// Two ways to price, chosen in Global settings and snapshotted on each order (orders.taxMode):
// INCLUSIVE (the default): the listed price includes the tax, which is backed out of each line's
// total once: $16.00 at 6% -> $15.09 net + $0.91 tax; a 3 x $16 line -> $45.28 + $2.72.
// Must match the SQL backfill in migrations/0007 exactly (test34 checks).
// EXCLUSIVE: the tax is added on top of each line's total (addTaxExclusive).
export function splitTaxInclusive(grossCents, rateBps) {
  const gross = Math.round(Number(grossCents) || 0);
  const bps = Math.max(0, Math.round(Number(rateBps) || 0));
  if (!bps || gross <= 0) return { netCents: gross, taxCents: 0 };
  const netCents = Math.round(gross * 10000 / (10000 + bps));
  return { netCents, taxCents: gross - netCents };
}

// The same per-line rounding the other way: tax ADDED to a net line total. $15.09 at 6% -> + $0.91
// = $16.00, so a price entered net here and the matching tax-included price in inclusive mode
// record the same net and the same tax.
export function addTaxExclusive(netCents, rateBps) {
  const net = Math.round(Number(netCents) || 0);
  const bps = Math.max(0, Math.round(Number(rateBps) || 0));
  if (!bps || net <= 0) return { grossCents: net, taxCents: 0 };
  const taxCents = Math.round(net * bps / 10000);
  return { grossCents: net + taxCents, taxCents };
}
export const TAX_MODES = ["inclusive", "exclusive"];
const taxMode_ = (m) => (m === "exclusive" ? "exclusive" : "inclusive");
// The tax on an amount of listed prices (a line total, or the taxable part of a discount).
const taxOn_ = (cents, rateBps, mode) =>
  (taxMode_(mode) === "exclusive" ? addTaxExclusive(cents, rateBps) : splitTaxInclusive(cents, rateBps)).taxCents;

// Until the admin sets them (Global settings → Sales tax) there is no rate and no home state: nothing
// is taxed. jurisdiction is the 2-letter code of the state the business collects tax for (outside
// the US — Region → country OTHER — the region's name as free text). taxMode
// applies to NEW orders; an existing order keeps its own (orders.taxMode). A setting saved before
// modes existed has none, and means inclusive.
const DEFAULT_SALES_TAX = { rateBps: 0, taxShipping: false, jurisdiction: "", taxMode: "inclusive" };

export async function getSalesTaxSettings(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='salesTax'").first();
  const s = { ...DEFAULT_SALES_TAX, ...(row ? tryParse_(row.value, {}) : {}) };
  s.taxMode = taxMode_(s.taxMode);
  return s;
}

export async function setSalesTaxSettings(db, { rateBps, jurisdiction, taxMode }) {
  const current = await getSalesTaxSettings(db);
  const next = { ...current, rateBps, jurisdiction, taxMode: taxMode_(taxMode === undefined ? current.taxMode : taxMode) };
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', ?)")
    .bind(JSON.stringify(next)).run();
  return next;
}

// ---- What the customer owes --------------------------------------------------
// THE formula, in integer cents: active items, plus shipping while anything is still on the order,
// minus the discount — plus the sales tax when the order's prices don't include it (taxMode
// "exclusive"; shipping is never taxed). Everything that needs "the order's total", "the balance" or "is it paid"
// goes through here (refreshPaidStatus, the card checkout amount, the order loaders, the revenue
// report), so they can't drift apart. `itemsTaxCents` / `discountTaxCents` are the tax recorded on
// the active lines and the discount's share of it.
//   owedCents      what the customer pays in all (before payments received)
//   taxCents       sales tax in that amount (never negative)
//   netSalesCents  goods revenue: no tax, no shipping
//   grossGoodsCents what the customer pays for the goods, tax included, after the discount
//   shippingCents  shipping actually charged (0 once every line is cancelled)
//   taxAddedCents  the part of taxCents that is on top of the listed prices (0 when inclusive)
export function orderAmounts({ itemsCents, itemsTaxCents, shippingCents, discountCents, discountTaxCents, taxMode }) {
  const items = Number(itemsCents) || 0, discount = Number(discountCents) || 0;
  const shipping = items > 0 ? Number(shippingCents) || 0 : 0;
  const taxCents = Math.max(0, (Number(itemsTaxCents) || 0) - (Number(discountTaxCents) || 0));
  const taxAddedCents = taxMode_(taxMode) === "exclusive" ? taxCents : 0;
  const owedCents = Math.max(0, items + shipping - discount + taxAddedCents);
  return {
    owedCents,
    taxCents,
    netSalesCents: Math.max(0, items - discount - (taxCents - taxAddedCents)),
    grossGoodsCents: Math.max(0, items - discount + taxAddedCents),
    shippingCents: shipping,
    taxAddedCents,
  };
}
// The columns orderAmounts needs, for the order aliased `o` (one row per order).
const ORDER_AMOUNT_COLS_ = `o.shippingCostCents, o.discountCents, o.discountTaxCents, o.taxMode,
      COALESCE((SELECT SUM(lineTotalCents) FROM order_items WHERE orderId = o.orderId AND cancelDate IS NULL), 0) AS itemsCents,
      COALESCE((SELECT SUM(taxCents) FROM order_items WHERE orderId = o.orderId AND cancelDate IS NULL), 0) AS itemsTaxCents`;
const orderAmountsOfRow_ = (row) => orderAmounts({ itemsCents: row.itemsCents, itemsTaxCents: row.itemsTaxCents,
  shippingCents: row.shippingCostCents, discountCents: row.discountCents, discountTaxCents: row.discountTaxCents, taxMode: row.taxMode });
// Runs a query that reads orders.taxMode, written as a function of how to spell that column
// ("o.taxMode"). On a database from before migrations/0052 the column doesn't exist and every order
// is inclusive, so the query is retried with that constant instead (tests pin older schemas).
async function withTaxMode_(run) {
  try { return await run("o.taxMode"); }
  catch (e) {
    if (!/no such column: (o\.)?taxMode/i.test(String(e && e.message))) throw e;
    return run("'inclusive'");
  }
}

// ---- What's taxed (migrations/0013) ----------------------------------------
// A line is taxed at the order's snapshotted rate only when (1) its product is
// taxable, (2) the order isn't tax-exempt and (3) the order doesn't ship to a
// state other than the jurisdiction (shipments out of the home state aren't
// its sales; pickup / hand delivery / no address = in state).
const US_STATE_CODES_ = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO", CONNECTICUT: "CT",
  DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL",
  INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
  MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT",
  NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY",
  "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA",
  "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT",
  VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
};
// "oh", "Ohio", " ohio. " → "OH"; unknown text passes through uppercased.
export function stateCode(s) {
  const t = String(s || "").trim().toUpperCase().replace(/\.$/, "").replace(/\s+/g, " ");
  return US_STATE_CODES_[t] || t;
}
// Out of the home state = not taxed. A blank ship-to state (pickup, hand delivery) is in the home
// state; with no home state configured nothing counts as out of state (the rate decides alone).
// Outside the US (Region → country OTHER) both sides are free text — "Ontario", "ontario " — and
// stateCode makes that comparison case- and spacing-insensitive, so the same rule holds.
export function isOutOfState(shipState, jurisdiction) {
  const st = stateCode(shipState), home = stateCode(jurisdiction);
  return !!st && !!home && st !== home;
}
// Which state a ZIP code is in, from its first three digits. Built from USPS's "ZIP Locale Detail"
// list (PostalPro, file dated 2026-10-01) by scripts/zip-prefix-table.py — regenerate it with that
// script, don't edit it by hand. Dozens of prefixes straddle a state line (029 is RI plus one MA ZIP,
// 838 is ID plus three WA ZIPs…) and military prefixes are addressed AE / AA / AP, so the answer is a
// LIST and any state on it is accepted; a prefix not in use gives [] and is never held against an address.
const ZIP3_STATES_ = "005:NY 006-007:PR 008:VI 009:PR 010-027:MA 028-029:RI 029:MA 030-038:NH 036:VT 039-049:ME 039:NH 050-054:VT 055:MA "
  + "056-059:VT 060-069:CT 063:NY 070-099:NJ 090:AE 091:AE 092:AE 093:AE 094:AE 095:AE 096:AE 097:AE 098:AE 099:AE "
  + "100-149:NY 150-196:PA 197-199:DE 199:MD 200:DC 200:MD 200:VA 201:VA 201:DC 202-205:DC 205:MD 205:VA 206-212:MD "
  + "214-219:MD 218:DE 220-246:VA 241:WV 246:WV 247-268:WV 270-289:NC 290-299:SC 300-319:GA 307:TN 320-342:FL 340:AA 344:FL "
  + "346-347:FL 349:FL 350-352:AL 354-369:AL 357:TN 370-385:TN 373:GA 376:VA 382:KY 386-397:MS 398-399:GA 400-418:KY 410:OH "
  + "411:WV 415:WV 420-427:KY 430-459:OH 452:KY 453:IN 460-479:IN 470:OH 471:KY 480-499:MI 500-516:IA 515:NE 520-528:IA "
  + "530-532:WI 534-535:WI 537-549:WI 550-551:MN 553-567:MN 565:ND 567:ND 570-577:SD 576:ND 580-588:ND 585:SD 590-599:MT "
  + "593:SD 600-620:IL 612:IA 622-629:IL 630-631:MO 633-641:MO 644-658:MO 660-662:KS 664-679:KS 666:MO 680-681:NE "
  + "683-693:NE 700-701:LA 703-708:LA 710-714:LA 716-729:AR 718:TX 730-731:OK 733:TX 734-741:OK 739:TX 743-749:OK "
  + "750-770:TX 755:AR 772-799:TX 798:NM 800-816:CO 820-831:WY 832-838:ID 834:WY 838:WA 840-847:UT 847:AZ 850-853:AZ "
  + "855-857:AZ 859-860:AZ 860:UT 863-865:AZ 870-871:NM 873-884:NM 885:TX 890-891:NV 893-895:NV 897-898:NV 900-908:CA "
  + "910-928:CA 930-966:CA 962:AP 963:AP 964:AP 965:AP 966:AP 966:NJ 967-968:HI 967:AS 969:GU 969:FM 969:MH 969:MP 969:PW "
  + "970-979:OR 979:ID 980-986:WA 988-994:WA 994:ID 995-999:AK";
const ZIP3_MAP_ = (() => {
  const m = {};
  for (const part of ZIP3_STATES_.split(" ")) {
    const [range, st] = part.split(":"), [a, b] = range.split("-").map(Number);
    for (let i = a; i <= (b === undefined ? a : b); i++) {
      const k = String(i).padStart(3, "0");
      if (!(m[k] || (m[k] = [])).includes(st)) m[k].push(st);
    }
  }
  return m;
})();
export function zipStates(zip) {
  const m = /^(\d{3})\d{2}/.exec(String(zip || "").trim());
  return (m && ZIP3_MAP_[m[1]]) || [];
}
export function zipIsInState(zip, state) {
  return zipStates(zip).includes(stateCode(state));
}
const VALID_STATE_CODES_ = new Set([...Object.values(US_STATE_CODES_), "PR", "GU", "VI", "AS", "MP", "AA", "AE", "AP"]);

// One reading of a storefront cart line's quantity. The rate quote (functions/api/shipping.js) and
// the order (functions/api/orders.js) both go through it, so the pieces that were weighed, the
// pieces the quote is signed for and the pieces that are ordered are always the same number — a
// rate weighed for 1 item can't be accepted on an order for 50.
// A whole number from 1 to MAX_LINE_QTY, sent as a JSON number; a line with no qty at all counts
// as 1. Anything else — a string, a fraction, zero, a negative, more than the cap — is not a
// quantity: it comes back null and the caller refuses the request rather than guessing.
export const MAX_LINE_QTY = 50;
export const QTY_MESSAGE = `Each item's quantity must be a whole number from 1 to ${MAX_LINE_QTY}.`;
export function lineQty(v) {
  if (v === undefined || v === null) return 1;
  return (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LINE_QTY) ? v : null;
}

// What an order's shippingMethod reads while its shipping is still to be quoted: a cart no box fits
// is placed without a carrier rate and the shop sets the shipping afterwards (which replaces this).
// Until then the order can't go through card checkout (getOrderCheckoutState → shippingPending).
export const SHIPPING_QUOTE_PENDING = "Quote pending";

// Validates and normalises a ship-to address before it's stored. Whitelists the known fields with
// length caps (anything else in the object is dropped), turns the state into its 2-letter code,
// and — because the state decides whether the order is taxed — refuses a state that contradicts the
// ZIP: a home-state ZIP with another "state" would drop the order's sales tax, and the signed
// shipping quote only binds the ZIP, so the ZIP is the trusted half. The rule is the same for every
// state, so it holds whatever the configured home state is (and with none configured). A blank
// state is filled in from the ZIP when the ZIP names exactly one; otherwise it's refused (a blank
// state is taxed as the home state). Returns {address} (null for no address) or {error} (a
// customer-facing message).
//
// `country` is the install's Region setting (getLocaleSettings). "US" (the default) is everything
// above. "OTHER": the postal code and the state / region are free text — trimmed and length-capped,
// the region kept as typed — and there is no postal-code check at all; nothing can be filled in
// from the postal code, so a blank region stays blank (and is taxed as the home region).
export function cleanShippingAddress(a, country) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return { address: null };
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const addr = {
    name: str(a.name, 200), line1: str(a.line1, 200), line2: str(a.line2, 200), city: str(a.city, 100),
    state: str(a.state, 50), zip: str(a.zip, 20), phone: str(a.phone, 50),
  };
  if (a.country) addr.country = str(a.country, 2).toUpperCase();
  if (!Object.values(addr).some(Boolean)) return { address: null };
  if (localeCountry_(country) === "OTHER") {
    addr.state = addr.state.replace(/\s+/g, " ");
    addr.zip = addr.zip.replace(/\s+/g, " ");
    return { address: addr };
  }
  if (addr.zip && !/^\d{5}(-\d{4})?$/.test(addr.zip)) return { error: "ZIP code must be 5 digits (or ZIP+4)." };
  if (addr.state) {
    const code = stateCode(addr.state);
    if (!VALID_STATE_CODES_.has(code)) return { error: "State must be a 2-letter US state code (e.g. NY)." };
    addr.state = code;
  }
  if (addr.zip) {
    const states = zipStates(addr.zip);
    if (!addr.state) {
      if (states.length !== 1) return { error: "Please enter the state for this address." };
      addr.state = states[0];
    } else if (states.length && !states.includes(addr.state)) {
      return { error: `ZIP code ${addr.zip} is in ${states.join(" or ")}, but the state says ${addr.state}. Please check the address.` };
    }
  }
  return { address: addr };
}

function stateOf_(shippingAddress) {
  if (!shippingAddress) return "";
  try { const a = typeof shippingAddress === "string" ? JSON.parse(shippingAddress) : shippingAddress; return String((a && a.state) || ""); }
  catch (_) { return ""; }
}

// Recomputes every line's tax (and the discount's tax share) on an existing
// order from its own snapshot — rate and exemption as of when it was placed,
// never today's — plus its current ship-to state and each line's taxable
// flag. Called after anything that can change what's taxed: item add/edit,
// discount, shipping address.
async function recomputeOrderTax_(db, orderId) {
  const [o, settings] = await Promise.all([
    withTaxMode_((tm) => db.prepare(`SELECT o.taxRateBps, o.taxExempt, o.shippingAddress, o.discountCents, ${tm} AS taxMode FROM orders o WHERE o.orderId=?`).bind(orderId).first()),
    getSalesTaxSettings(db),
  ]);
  if (!o) return;
  const mode = taxMode_(o.taxMode);   // the order's own, never today's setting
  const orderRate = !o.taxExempt && !isOutOfState(stateOf_(o.shippingAddress), settings.jurisdiction) ? Number(o.taxRateBps) || 0 : 0;
  const { results: items } = await db.prepare("SELECT id, lineTotalCents, taxable, cancelDate FROM order_items WHERE orderId=?").bind(orderId).all();
  const stmts = items.map(it => {
    const rate = it.taxable ? orderRate : 0;
    return db.prepare("UPDATE order_items SET taxRateBps=?, taxCents=? WHERE id=?")
      .bind(rate, taxOn_(Number(it.lineTotalCents), rate, mode), it.id);
  });
  // A discount reduces tax only in proportion to the taxable goods it's taken off.
  const active = items.filter(it => !it.cancelDate);
  const gross = active.reduce((a, it) => a + Number(it.lineTotalCents), 0);
  const taxableGross = active.filter(it => it.taxable).reduce((a, it) => a + Number(it.lineTotalCents), 0);
  const disc = Math.min(Number(o.discountCents) || 0, gross);
  const taxableDisc = gross > 0 ? Math.round(disc * taxableGross / gross) : 0;
  stmts.push(db.prepare("UPDATE orders SET discountTaxCents=? WHERE orderId=?")
    .bind(taxOn_(taxableDisc, orderRate, mode), orderId));
  await db.batch(stmts);
  // With tax on top, the tax is part of the order's total, so the stored totals move with it
  // (an address change into or out of the home state changes what the customer owes).
  if (mode === "exclusive") await storeOrderTotals_(db, orderId);
}

// orders.subtotalCents / totalCents: the active lines, and that plus shipping — plus the lines' tax
// when it's added on top. The total BEFORE any discount; what's owed is orderAmounts.
async function storeOrderTotals_(db, orderId) {
  const row = await withTaxMode_((tm) => db.prepare(`SELECT ${ORDER_AMOUNT_COLS_.replace("o.taxMode", tm + " AS taxMode")} FROM orders o WHERE o.orderId=?`).bind(orderId).first());
  const subtotalCents = row ? Number(row.itemsCents) || 0 : 0;
  const totalCents = subtotalCents + (row ? Number(row.shippingCostCents) || 0 : 0)
    + (row && taxMode_(row.taxMode) === "exclusive" ? Number(row.itemsTaxCents) || 0 : 0);
  await db.prepare("UPDATE orders SET subtotalCents=?, totalCents=? WHERE orderId=?").bind(subtotalCents, totalCents, orderId).run();
  return { subtotalCents, totalCents };
}

// ---- Org helpers -------------------------------------------------------

export async function getAllOrgs(db) {
  const { results } = await db.prepare("SELECT * FROM orgs ORDER BY orgId").all();
  return results.map(parseOrg_);
}

export async function getOrgById(db, orgId) {
  const row = await db.prepare("SELECT * FROM orgs WHERE orgId = ?").bind(orgId).first();
  return row ? parseOrg_(row) : null;
}

export async function createOrg(db, o) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO orgs
    (orgId,subdomain,name,eyebrow,accent,desc,ready,shippingEnabled,enabledPayments,
     orderDeadline,closedMessage,allowOrdersAfterDeadline,
     designImageShirt,designImageCap,designImageDetail,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      o.orgId, o.subdomain, o.name, o.eyebrow || "", o.accent || "#2563eb",
      o.desc || "", o.ready ? 1 : 0, o.shippingEnabled ? 1 : 0,
      JSON.stringify(o.enabledPayments || { card: true, venmo: true, zelle: true, check: true }),
      o.orderDeadline || null,
      o.closedMessage || null, o.allowOrdersAfterDeadline !== false ? 1 : 0,
      o.designImageShirt || "", o.designImageCap || "", o.designImageDetail || "",
      now, now
    ).run();
}

// Written separately from updateOrg on purpose: updateOrg overwrites every
// column, so a caller that doesn't know about tax fields
// must not be able to silently clear an org's exemption.
export async function setOrgTaxExemption(db, orgId, { taxExempt, certificate, expires }) {
  await db.prepare("UPDATE orgs SET taxExempt=?, taxExemptCertificate=?, taxExemptExpires=?, updatedAt=? WHERE orgId=?")
    .bind(taxExempt ? 1 : 0, certificate || "", expires || null, new Date().toISOString(), orgId).run();
}

export async function updateOrg(db, orgId, o) {
  const now = new Date().toISOString();
  await db.prepare(`UPDATE orgs SET
    subdomain=?, name=?, eyebrow=?, accent=?, desc=?, ready=?, shippingEnabled=?,
    enabledPayments=?, orderDeadline=?, closedMessage=?, allowOrdersAfterDeadline=?,
    designImageShirt=?, designImageCap=?, designImageDetail=?, updatedAt=?
    WHERE orgId=?`)
    .bind(
      o.subdomain,
      o.name, o.eyebrow || "", o.accent || "#2563eb", o.desc || "",
      o.ready ? 1 : 0, o.shippingEnabled ? 1 : 0,
      JSON.stringify(o.enabledPayments || { card: true, venmo: true, zelle: true, check: true }),
      o.orderDeadline || null,
      o.closedMessage || null, o.allowOrdersAfterDeadline !== false ? 1 : 0,
      o.designImageShirt || "", o.designImageCap || "", o.designImageDetail || "",
      now, orgId
    ).run();
}

// ---- Delivery / pickup options per shop (migrations/0045) ---------------------------------------
// The list a customer picks from at checkout: at most one `pickup` (Local pickup, free), at most one
// `shipping` (carrier rates by ZIP — the fee varies, so it's null here) and any number of `custom`
// entries with the shop's own wording and a flat fee ("Delivery at practice", $0). Order matters:
// it's the order shown, and the first non-shipping entry is preselected.
export const DELIVERY_MAX_OPTIONS = 12;
const DELIVERY_PICKUP_ = { id: "pickup", type: "pickup", label: "Local pickup", fee: 0 };
const DELIVERY_SHIPPING_ = { id: "shipping", type: "shipping", label: "Shipping", fee: null };
// What a shop with no saved list offers: free local pickup, plus carrier shipping when enabled.
export function defaultDeliveryOptions(shippingEnabled) {
  return [{ ...DELIVERY_PICKUP_ }, ...(shippingEnabled ? [{ ...DELIVERY_SHIPPING_ }] : [])];
}
// Validates and tidies a list from the admin form (or from storage). → { options } or { error }.
export function cleanDeliveryOptions(list) {
  if (!Array.isArray(list) || !list.length) return { error: "Add at least one delivery or pickup option." };
  if (list.length > DELIVERY_MAX_OPTIONS) return { error: `That's more than ${DELIVERY_MAX_OPTIONS} delivery options.` };
  const out = [], ids = new Set(), names = new Set();
  for (const raw of list) {
    const type = raw && raw.type;
    if (type === "pickup" || type === "shipping") {
      if (out.some(o => o.type === type)) return { error: type === "pickup" ? "Local pickup can only be in the list once." : "Shipping can only be in the list once." };
      out.push(type === "pickup" ? { ...DELIVERY_PICKUP_ } : { ...DELIVERY_SHIPPING_ });
      continue;
    }
    if (type !== "custom") return { error: "Unknown delivery option type." };
    const label = String(raw.label == null ? "" : raw.label).replace(/\s+/g, " ").trim().slice(0, 60);
    if (!label) return { error: "Give each custom delivery option a name." };
    if (names.has(label.toLowerCase())) return { error: `Two delivery options are both named "${label}".` };
    names.add(label.toLowerCase());
    const fee = raw.fee == null || raw.fee === "" ? 0 : Number(raw.fee);
    if (!Number.isFinite(fee) || fee < 0 || fee > 1000) return { error: `The fee for "${label}" must be a number from 0 to 1000.` };
    let id = /^c[a-z0-9]{6,16}$/.test(String(raw.id || "")) && !ids.has(raw.id) ? raw.id : "";
    while (!id || ids.has(id)) id = "c" + [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, "0")).join("");
    ids.add(id);
    out.push({ id, type: "custom", label, fee: Math.round(fee * 100) / 100 });
  }
  return { options: out };
}
// Written apart from updateOrg (which overwrites every column it knows), so a caller that has never
// heard of the list can't clear it. Keeps orgs.shippingEnabled in step with the list.
export async function setOrgDeliveryOptions(db, orgId, options) {
  await db.prepare("UPDATE orgs SET deliveryOptionsJson=?, shippingEnabled=?, updatedAt=? WHERE orgId=?")
    .bind(JSON.stringify(options), options.some(o => o.type === "shipping") ? 1 : 0, new Date().toISOString(), orgId).run();
}

function parseOrg_(row) {
  // A stored list wins; without one the shop offers the default (see defaultDeliveryOptions).
  const stored = row.deliveryOptionsJson ? cleanDeliveryOptions(tryParse_(row.deliveryOptionsJson, null)) : null;
  const deliveryOptions = stored && stored.options ? stored.options : defaultDeliveryOptions(!!row.shippingEnabled);
  return {
    orgId: row.orgId,
    subdomain: row.subdomain,
    name: row.name,
    eyebrow: row.eyebrow || "",
    accent: row.accent || "#2563eb",
    desc: row.desc || "",
    ready: !!row.ready,
    shippingEnabled: deliveryOptions.some(o => o.type === "shipping"),
    deliveryOptions,
    deliveryOptionsStored: !!(stored && stored.options),
    enabledPayments: tryParse_(row.enabledPayments, { card: true, venmo: true, zelle: true, check: true }),
    orderDeadline: row.orderDeadline || null,
    closedMessage: row.closedMessage || null,
    allowOrdersAfterDeadline: row.allowOrdersAfterDeadline !== 0,
    taxExempt: !!row.taxExempt,
    taxExemptCertificate: row.taxExemptCertificate || "",
    taxExemptExpires: row.taxExemptExpires || "",
    designImages: {
      shirt: row.designImageShirt || "",
      cap: row.designImageCap || "",
      detail: row.designImageDetail || "",
    },
  };
}

// ---- Product helpers ----------------------------------------------------

export async function getProductsByOrg(db, orgId, visibleOnly = false) {
  const sql = visibleOnly
    ? "SELECT * FROM products WHERE orgId=? AND visible=1 ORDER BY sortOrder, productId"
    : "SELECT * FROM products WHERE orgId=? ORDER BY sortOrder, productId";
  const { results } = await db.prepare(sql).bind(orgId).all();
  const products = results.map(parseProduct_);
  // Each product's designs in run order (migrations/0032) — one query for the whole org.
  const byProduct = {};
  try {
    const { results: pd } = await db.prepare(
      "SELECT * FROM product_designs WHERE orgId=? ORDER BY sortOrder, id").bind(orgId).all();
    for (const r of pd) (byProduct[r.productId] = byProduct[r.productId] || []).push(parseProductDesign_(r));
  } catch (e) { /* pre-0032 database */ }
  products.forEach(p => {
    p.designs = byProduct[p.productId] || [];
    if (p.customDesign) p.customDesignRequired = customDesignRequired(p);   // migrations/0054
  });
  return products;
}

export async function createProduct(db, orgId, p) {
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR REPLACE INTO products
    (productId,orgId,type,name,sub,weightOz,personalizationPriceCents,personalizationOptions,
     pricingMode,flatPriceCents,sizePricingCents,imagesJson,featuresJson,visible,sortOrder,createdAt,updatedAt,taxable)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      p.productId, orgId, p.type, p.name, p.sub || "",
      p.weightOz ?? null, toCentsOrNull(p.personalizationPrice),
      JSON.stringify(p.personalizationOptions || []),
      p.pricingMode, toCentsOrNull(p.flatPrice),
      JSON.stringify(mapValues_(p.sizePricing, toCents)),
      JSON.stringify(p.images || []),
      JSON.stringify(p.features || []),
      p.visible ? 1 : 0, p.sortOrder ?? 0,
      now, now, p.taxable === false ? 0 : 1
    ).run();
  if (p.noDesignNeeded !== undefined) await setProductNoDesignNeeded_(db, orgId, p.productId, !!p.noDesignNeeded);
  if (p.customDesign !== undefined) await setProductCustomDesign_(db, orgId, p.productId, p.customDesign, p.customDesignPrice);
  await setProductConfig_(db, orgId, p);
  if (p.personalizationMode !== undefined || p.personalizationOptionDesigns !== undefined || p.personalizationHoopId !== undefined)
    await setProductPersonalization(db, orgId, p.productId, { mode: p.personalizationMode, hoopId: p.personalizationHoopId, optionDesigns: p.personalizationOptionDesigns });
}

// migrations/0034 — a product that never needs an embroidery design (DTF, …).
async function setProductNoDesignNeeded_(db, orgId, productId, on) {
  await db.prepare("UPDATE products SET noDesignNeeded=? WHERE orgId=? AND productId=?").bind(on ? 1 : 0, orgId, productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

// migrations/0054 — the customer may upload their own design: kind '' (off) | 'embroidery' |
// 'transfer', and the add-on per piece in dollars (null = free). Only written when the caller sends
// `customDesign`; safe on a pre-0054 database.
export const CUSTOM_DESIGN_KINDS = ["", "embroidery", "transfer"];
// Is the customer's upload REQUIRED to order this product? Yes when it's an ordinary product with
// no design of its own (no main design, none in product_designs, and not marked "No embroidery
// design needed"): the upload is then the only thing the line is made from. Otherwise it's an
// optional upload that replaces the product's own design on that line. A configurable product
// offers it as one more choice at each location, so it's never required there.
export function customDesignRequired(p) {
  if (!p || !p.customDesign || Number(p.configurable)) return false;
  const designCount = Array.isArray(p.designs) ? p.designs.length : Number(p.designCount) || 0;
  return p.designId == null && !designCount && !Number(p.noDesignNeeded);
}

async function setProductCustomDesign_(db, orgId, productId, kind, price) {
  const k = CUSTOM_DESIGN_KINDS.includes(kind) ? kind : "";
  await db.prepare("UPDATE products SET customDesign=?, customDesignPriceCents=? WHERE orgId=? AND productId=?")
    .bind(k, k ? toCentsOrNull(price) : null, orgId, productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

// migrations/0036 — configurable-product fields (only the ones provided are written; safe on a
// pre-0036 DB). `reorderQr` is 'default' | 'none' | 't<transferId>' (migrations/0047; a bare number is
// the old way — a graphic id — and still works).
async function setProductConfig_(db, orgId, p) {
  const sets = [], binds = [];
  if (p.configurable !== undefined)   { sets.push("configurable=?");       binds.push(p.configurable ? 1 : 0); }
  if (p.garmentColors !== undefined)  { sets.push("garmentColorsJson=?");  binds.push(JSON.stringify(Array.isArray(p.garmentColors) ? p.garmentColors : [])); }
  if (p.locations !== undefined)      { sets.push("locationsJson=?");      binds.push(JSON.stringify(Array.isArray(p.locations) ? p.locations : [])); }
  if (p.reorderQr !== undefined)      { sets.push("reorderQr=?");          binds.push(String(p.reorderQr || "default").slice(0, 40)); }
  if (!sets.length) return;
  await db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE orgId=? AND productId=?`).bind(...binds, orgId, p.productId).run()
    .catch((e) => { if (!/no such column/i.test(String(e && e.message))) throw e; });
}

export async function updateProduct(db, orgId, p) {
  if (p.noDesignNeeded !== undefined) await setProductNoDesignNeeded_(db, orgId, p.productId, !!p.noDesignNeeded);
  if (p.customDesign !== undefined) await setProductCustomDesign_(db, orgId, p.productId, p.customDesign, p.customDesignPrice);
  await setProductConfig_(db, orgId, p);
  if (p.personalizationMode !== undefined || p.personalizationOptionDesigns !== undefined || p.personalizationHoopId !== undefined)
    await setProductPersonalization(db, orgId, p.productId, { mode: p.personalizationMode, hoopId: p.personalizationHoopId, optionDesigns: p.personalizationOptionDesigns });
  const now = new Date().toISOString();
  await db.prepare(`UPDATE products SET
    type=?,name=?,sub=?,weightOz=?,personalizationPriceCents=?,personalizationOptions=?,
    pricingMode=?,flatPriceCents=?,sizePricingCents=?,imagesJson=?,featuresJson=?,
    visible=?,sortOrder=?,updatedAt=?,taxable=COALESCE(?, taxable)
    WHERE orgId=? AND productId=?`)
    .bind(
      p.type, p.name, p.sub || "",
      p.weightOz ?? null, toCentsOrNull(p.personalizationPrice),
      JSON.stringify(p.personalizationOptions || []),
      p.pricingMode, toCentsOrNull(p.flatPrice),
      JSON.stringify(mapValues_(p.sizePricing, toCents)),
      JSON.stringify(p.images || []),
      JSON.stringify(p.features || []),
      p.visible ? 1 : 0, p.sortOrder ?? 0,
      now, p.taxable === undefined ? null : (p.taxable ? 1 : 0), orgId, p.productId
    ).run();
}

export async function setProductVisible(db, orgId, productId, visible) {
  await db.prepare("UPDATE products SET visible=?, updatedAt=? WHERE orgId=? AND productId=?")
    .bind(visible ? 1 : 0, new Date().toISOString(), orgId, productId).run();
}

function parseProduct_(row) {
  return {
    productId: row.productId,
    orgId: row.orgId,
    type: row.type,
    name: row.name,
    sub: row.sub || "",
    weightOz: row.weightOz ?? null,
    personalizationPrice: fromCentsOrNull(row.personalizationPriceCents),
    personalizationOptions: tryParse_(row.personalizationOptions, []),
    pricingMode: row.pricingMode,
    flatPrice: fromCentsOrNull(row.flatPriceCents),
    sizePricing: mapValues_(tryParse_(row.sizePricingCents, {}), fromCents),
    images: tryParse_(row.imagesJson, []),
    features: tryParse_(row.featuresJson, []),
    visible: !!row.visible,
    sortOrder: row.sortOrder ?? 0,
    taxable: row.taxable === undefined ? true : !!row.taxable,
    designId: row.designId == null ? null : Number(row.designId),
    // migrations/0032 — see setProductPersonalization / setProductDesigns.
    personalizationMode: row.personalizationMode === "separate" ? "separate" : "combined",
    personalizationHoopId: row.personalizationHoopId == null ? null : Number(row.personalizationHoopId),
    personalizationOptionDesigns: tryParse_(row.personalizationOptionDesigns, {}) || {},
    noDesignNeeded: !!Number(row.noDesignNeeded),   // migrations/0034
    blockedGraphicColors: tryParse_(row.blockedGraphicColorsJson, []) || [],   // migrations/0050: [{graphicId, color}] not offered
    // migrations/0054 — the customer's own design: '' off | 'embroidery' | 'transfer', and its add-on.
    customDesign: CUSTOM_DESIGN_KINDS.includes(row.customDesign) ? row.customDesign : "",
    customDesignPrice: row.customDesign ? fromCentsOrNull(row.customDesignPriceCents) : null,
    // migrations/0036 — configurable products (per-location option menus + reorder QR).
    configurable: !!Number(row.configurable),
    garmentColors: tryParse_(row.garmentColorsJson, []) || [],
    locations: tryParse_(row.locationsJson, []) || [],
    reorderQr: row.reorderQr || "default",
  };
}

// ---- Catalog health check ---------------------------------------------------------------------
// What's missing in the catalog that will bite later — for the ⚠ markers on Manage catalog (next to
// each shop's Products / Designs buttons), on each product and each design. Each issue is
// {code, text, level}: "error" = Run Order / ordering can't work right; "warn" = worth fixing
// (e.g. sizes not linked to a blank, so stock and COGS aren't tracked). Products are checked when
// visible, or hidden but still on an open order. Returns
// {orgs: {orgId: {products: {productId: [issues]}, designs: {designId: [issues]}, productCount,
//  designCount}}, globalDesigns: {designId: [issues]}} — only things WITH issues are listed.
export async function getCatalogIssues(db, orgId = null) {
  const q = async (sql, ...b) => { try { return (await db.prepare(sql).bind(...b).all()).results; } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; } };
  const orgFilter = orgId ? " WHERE orgId = ?" : "";
  const ob = orgId ? [orgId] : [];
  // Features that are off aren't nagged about: no design / hoop / stitch-file issues without
  // Production, no "no weight" without Shipping.
  const features = await getFeatures(db);
  const orgs = await q("SELECT orgId, shippingEnabled FROM orgs" + orgFilter, ...ob);
  const products = await q("SELECT * FROM products" + orgFilter, ...ob);
  const designs = await q("SELECT d.*, (SELECT id FROM design_versions v WHERE v.designId = d.id AND v.machineFileKey <> '' ORDER BY uploadedAt DESC, id DESC LIMIT 1) AS stitchVersionId FROM designs d" +
    (orgId ? " WHERE d.orgId = ? OR d.isGlobal = 1" : ""), ...ob);
  const versions = await q(`SELECT v.designId, v.threadColorsJson FROM design_versions v
    WHERE v.id = (SELECT id FROM design_versions w WHERE w.designId = v.designId ORDER BY uploadedAt DESC, id DESC LIMIT 1)`);
  const hoops = await q("SELECT designId, count(*) n FROM design_hoops GROUP BY designId");
  const pds = await q("SELECT orgId, productId, designId FROM product_designs" + orgFilter, ...ob);
  const links = await q("SELECT orgId, productId, productSize FROM product_blank_links" + orgFilter, ...ob);
  const open = await q(`SELECT oi.orgId, oi.productId, count(*) n FROM order_items oi JOIN orders o ON o.orderId = oi.orderId
    WHERE oi.cancelDate IS NULL AND o.manufacturedAt IS NULL AND o.completedAt IS NULL AND o.voidedAt IS NULL AND o.isTest = 0
    GROUP BY oi.orgId, oi.productId`);
  const hoopCount = {}; for (const h of hoops) hoopCount[h.designId] = Number(h.n);
  const latest = {}; for (const v of versions) latest[v.designId] = tryParse_(v.threadColorsJson, []) || [];
  // Designs.
  const designIssues = {}, designById = {};
  for (const d of designs) {
    designById[d.id] = d;
    const list = [];
    if (!d.stitchVersionId) list.push({ code: "noStitchFile", level: "error", text: "No stitch (machine) file uploaded" });
    if (!hoopCount[d.id] && d.hoopId == null) list.push({ code: "noHoops", level: "error", text: "No hoops picked" });
    if (d.stitchVersionId && !(latest[d.id] || []).length) list.push({ code: "noThreads", level: "warn", text: "Current version has no thread colors" });
    if (list.length && features.production) designIssues[d.id] = list;
  }
  const out = { orgs: {}, globalDesigns: {} };
  const orgOf = (id) => (out.orgs[id] = out.orgs[id] || { products: {}, designs: {}, productCount: 0, designCount: 0 });
  for (const o of orgs) orgOf(o.orgId);
  for (const d of designs) {
    if (!designIssues[d.id]) continue;
    if (Number(d.isGlobal)) out.globalDesigns[d.id] = designIssues[d.id];
    if (!orgId || d.orgId === orgId) { orgOf(d.orgId).designs[d.id] = designIssues[d.id]; }
  }
  // Products.
  const shipping = {}; for (const o of orgs) shipping[o.orgId] = !!Number(o.shippingEnabled);
  const pdBy = {}; for (const r of pds) (pdBy[r.orgId + "|" + r.productId] = pdBy[r.orgId + "|" + r.productId] || []).push(Number(r.designId));
  const linked = {}; for (const r of links) linked[r.orgId + "|" + r.productId + "|" + r.productSize] = true;
  const openBy = {}; for (const r of open) openBy[r.orgId + "|" + r.productId] = Number(r.n);
  const designName = (id) => (designById[id] && designById[id].name) || ("#" + id);
  for (const p of products) {
    const key = p.orgId + "|" + p.productId;
    if (!Number(p.visible) && !openBy[key]) continue;
    const list = [];
    const used = pdBy[key] || (p.designId != null ? [Number(p.designId)] : []);
    // A product the customer supplies the design for (migrations/0054) is made from their upload.
    if (features.production && !used.length && !Number(p.noDesignNeeded) && !p.customDesign)
      list.push({ code: "noDesign", level: "error", text: "No design linked — Run Order can't plan its hoopings (tick “No embroidery design needed” if it's DTF)" });
    const options = tryParse_(p.personalizationOptions, []) || [];
    const map = tryParse_(p.personalizationOptionDesigns, {}) || {};
    const unmapped = options.filter(o => !Number(map[o]) || !designById[Number(map[o])]);
    if (features.production && unmapped.length) list.push({ code: "pickUnmapped", level: "error", text: "Pick-list option" + (unmapped.length === 1 ? "" : "s") + " with no design: " + unmapped.join(", ") });
    const designIdsUsed = new Set(used.concat(options.map(o => Number(map[o])).filter(Boolean)));
    for (const id of designIdsUsed) if (designIssues[id]) list.push({ code: "designIssue", level: "error", text: `Design “${designName(id)}”: ${designIssues[id].map(x => x.text.toLowerCase()).join("; ")}` });
    if (features.production && !options.length && p.personalizationPriceCents != null && p.personalizationMode === "separate" && p.personalizationHoopId == null)
      list.push({ code: "persHoop", level: "error", text: "Typed-in personalization is its own hooping but has no hoop" });
    const sizes = p.pricingMode === "flat" ? ["OSFA"] : Object.keys(tryParse_(p.sizePricingCents, {}) || {});
    if (p.pricingMode === "flat" ? p.flatPriceCents == null : !sizes.length) list.push({ code: "noPrice", level: "error", text: "No price set" });
    if (features.shipping && shipping[p.orgId] && p.weightOz == null) list.push({ code: "noWeight", level: "error", text: "No weight — the shop ships, so shipping can't be quoted" });
    const noBlank = sizes.filter(sz => !linked[key + "|" + sz]);
    // Blank links matter whether or not the product is embroidered — a DTF tee is still a blank whose
    // stock and cost of goods should be tracked — so "No embroidery design needed" doesn't skip this.
    if (noBlank.length && sizes.length)
      list.push({ code: "noBlankLink", level: "warn", text: (noBlank.length === sizes.length ? "Not linked to a blank" : "Sizes not linked to a blank: " + noBlank.join(", ")) + " — stock and cost of goods aren't tracked" });
    if (!Number(p.visible)) list.forEach(x => { x.text += " (hidden, but on an open order)"; });
    if (list.length) orgOf(p.orgId).products[p.productId] = list;
  }
  for (const o of Object.values(out.orgs)) { o.productCount = Object.keys(o.products).length; o.designCount = Object.keys(o.designs).length; }
  return out;
}

// ---- A product's designs (migrations/0032) --------------------------------------------------
// product_designs lists a product's designs in run order — each its own hooping (e.g. a cap's
// front logo, then a back design). One is MAIN: the design a typed-in name is combined with.
// products.designId mirrors the main design for older readers (and the digitizing rule).
const parseProductDesign_ = (r) => ({ id: Number(r.id), designId: Number(r.designId), placement: r.placement || "",
  isMain: !!r.isMain, sortOrder: Number(r.sortOrder) || 0 });

export async function listProductDesigns(db, orgId, productId) {
  const { results } = await db.prepare(
    "SELECT * FROM product_designs WHERE orgId=? AND productId=? ORDER BY sortOrder, id").bind(orgId, productId).all();
  return results.map(parseProductDesign_);
}

// Replaces the product's design list. list = [{designId, placement, isMain}] in run order; every
// design must belong to the org. Exactly one is main (the first, if none is marked).
export async function setProductDesigns(db, orgId, productId, list) {
  const rows = (Array.isArray(list) ? list : []).filter(x => x && Number(x.designId))
    .map((x, i) => ({ designId: Number(x.designId), placement: String(x.placement || "").trim().slice(0, 60), isMain: !!x.isMain, sortOrder: i }));
  for (const r of rows) {
    const d = await db.prepare("SELECT * FROM designs WHERE id=?").bind(r.designId).first();
    if (!d || (d.orgId !== orgId && !Number(d.isGlobal))) throw new Error("Design " + r.designId + " doesn't belong to this shop");
  }
  if (rows.length && rows.filter(r => r.isMain).length !== 1) { rows.forEach(r => { r.isMain = false; }); rows[0].isMain = true; }
  const main = rows.find(r => r.isMain);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("DELETE FROM product_designs WHERE orgId=? AND productId=?").bind(orgId, productId),
    ...rows.map(r => db.prepare(
      "INSERT INTO product_designs (orgId, productId, designId, placement, isMain, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(orgId, productId, r.designId, r.placement, r.isMain ? 1 : 0, r.sortOrder, now)),
    db.prepare("UPDATE products SET designId=?, updatedAt=? WHERE orgId=? AND productId=?").bind(main ? main.designId : null, now, orgId, productId),
  ]);
}

// The old one-design call (migrations/0024): the product's designs become just this one, as main.
export async function setProductDesign(db, orgId, productId, designId) {
  await setProductDesigns(db, orgId, productId, designId == null || designId === "" ? [] : [{ designId, placement: "Main", isMain: true }]);
}

// How a product's personalization is stitched (migrations/0032): mode 'combined' (a typed-in name
// goes in the same hooping as the main design, on the design's personalization hoops) or
// 'separate' (its own hooping on hoopId); optionDesigns maps each pick-list option to a design.
export async function setProductPersonalization(db, orgId, productId, { mode, hoopId, optionDesigns } = {}) {
  const map = {};
  for (const [k, v] of Object.entries(optionDesigns || {})) if (Number(v)) map[String(k)] = Number(v);
  await db.prepare(`UPDATE products SET personalizationMode=?, personalizationHoopId=?, personalizationOptionDesigns=?, updatedAt=?
    WHERE orgId=? AND productId=?`)
    .bind(mode === "separate" ? "separate" : "combined", hoopId ? Number(hoopId) : null, JSON.stringify(map),
      new Date().toISOString(), orgId, productId).run();
}

// Server-side pricing — never trust client-supplied prices.
// Returns {unitPrice, personalizationFee, name, type} or throws if the product
// isn't found. name/type come from the catalog so order records can't carry
// customer-chosen text in place of the real product.
// The customer's own design (migrations/0054): opts.custom maps a location key ("customdesign" on an
// ordinary product) → the upload {uploadId, fileKey, fileName, fileExt}, or null to keep the entry
// without a file. The caller looks the uploads up; this only prices them and writes them into the
// line's copy. `needsCustomUpload` comes back true when the line needs an upload it doesn't have —
// only the storefront refuses that (a local sale or an Edit items change goes through, and the
// admin attaches the file with Files).
export async function priceItem(db, orgId, productId, size, qty, personalized, config, opts = {}) {
  // Every column, so this keeps working on a database a migration behind the code.
  const row = await db.prepare("SELECT * FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();

  if (!row || !row.visible) throw pricingError_(`Product not available: ${productId}`);

  // The size is the customer's word, and it is stored on the line: text, and no longer than a size is.
  if (size != null && (typeof size !== "string" || size.length > 40)) throw pricingError_("That size isn't available.");

  let unitPriceCents;
  if (row.pricingMode === "flat") {
    unitPriceCents = Number(row.flatPriceCents) || 0;
  } else {
    // A size is one this product LISTS — its own entry in the price table, never something every
    // object answers to ("toString", "constructor"), which would read as a price of nothing — and
    // the price listed for it is a real amount, not a blank that would count as $0.
    const sp = tryParse_(row.sizePricingCents, {});
    const listed = sp && typeof sp === "object" && !Array.isArray(sp) && typeof size === "string" && Object.prototype.hasOwnProperty.call(sp, size);
    const cents = listed && (typeof sp[size] === "number" || (typeof sp[size] === "string" && sp[size].trim() !== "")) ? Number(sp[size]) : NaN;
    if (!Number.isFinite(cents) || cents < 0) throw pricingError_(`Size ${String(size).slice(0, 40)} not available for ${productId}`);
    unitPriceCents = cents;
  }

  // Configurable products (migrations/0036): base price + Σ tier add-ons for the chosen per-location
  // options. Validates each option server-side and returns a snapshot to store on the line.
  const custom = opts && opts.custom && typeof opts.custom === "object" ? opts.custom : {};
  if (row.configurable && Number(row.configurable)) {
    const built = await priceConfigurable_(db, orgId, row, size, config, custom);
    const cfgPersCents = personalized && row.personalizationPriceCents != null ? Number(row.personalizationPriceCents) : 0;
    return { unitPrice: fromCents(unitPriceCents + built.addOnCents), personalizationFee: fromCents(cfgPersCents),
      name: row.name || productId, type: row.type || "", config: built.snapshot,
      ...(built.needsCustomUpload ? { needsCustomUpload: true } : {}) };
  }

  const personalizationFeeCents = personalized && row.personalizationPriceCents != null
    ? Number(row.personalizationPriceCents)
    : 0;

  // The customer's own design on an ordinary product: one image for the line, in place of the
  // product's own design (or as its only design). Its add-on is part of the unit price.
  const hasCustom = Object.prototype.hasOwnProperty.call(custom, CUSTOM_PLAIN_LOCATION);
  const customEntry = hasCustom ? customDesignEntry_(row, CUSTOM_PLAIN_LOCATION, "Design", custom[CUSTOM_PLAIN_LOCATION]) : null;
  if (customEntry) unitPriceCents += customEntry.addOnCents;
  let needsCustomUpload = false;
  if (!hasCustom && row.customDesign) {
    let designCount = 0;
    try { designCount = Number((await db.prepare("SELECT count(*) AS n FROM product_designs WHERE orgId=? AND productId=?").bind(orgId, productId).first()).n) || 0; }
    catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
    needsCustomUpload = customDesignRequired({ ...row, designCount });
  }

  const out = {
    unitPrice: fromCents(unitPriceCents), personalizationFee: fromCents(personalizationFeeCents),
    name: row.name || productId, type: row.type || "",
    ...(needsCustomUpload ? { needsCustomUpload: true } : {}),
  };
  // A plain product can carry a reorder QR code too (migrations/0048): the line's snapshot then holds
  // just that automatic transfer. `plain: true` says "not a configurable line — nothing here was
  // picked", so screens that edit a configurable line's choices leave it alone.
  const qr = await reorderQrEntry_(db, orgId, row.reorderQr);
  const locs = [customEntry, qr].filter(Boolean);
  if (locs.length) out.config = { garmentColor: "", size: size || "", locations: locs, plain: true };
  return out;
}

// The customer's own design as an entry in a line's copy of its options (configJson). `upload` is
// {uploadId, fileKey, fileName, fileExt} or null (no file — the admin attaches one with Files). An
// upload carried over from the line's own copy (Edit items) also brings the `kind` and `addOnCents`
// it was ordered with, so a line stays editable after the product stops offering it.
export const CUSTOM_PLAIN_LOCATION = "customdesign";
// `locCents` is a configurable location's own add-on (its customDesignPriceCents), used in place of the
// product's when it is set.
function customDesignEntry_(row, location, label, upload, locCents) {
  const u = upload && typeof upload === "object" ? upload : null;
  const offered = CUSTOM_DESIGN_KINDS.includes(row.customDesign) && row.customDesign;
  const kind = offered || (u && CUSTOM_DESIGN_KINDS.includes(u.kind) && u.kind) || "";
  if (!kind) throw pricingError_(`${row.name || "This product"} no longer takes your own design — please remove it from your cart and add it again.`);
  const own = locCents != null && locCents !== "" && Number.isFinite(Number(locCents)) ? Number(locCents) : null;
  const addOnCents = offered ? Math.max(0, own != null ? own : Number(row.customDesignPriceCents) || 0) : Math.max(0, Number(u.addOnCents) || 0);
  return { location: String(location), label: String(label || location), custom: true, kind, graphicId: null, designId: null, transferId: null,
    graphicName: "Your own design", ink: "", tier: null, addOnCents,
    uploadId: u && u.uploadId ? String(u.uploadId) : null, fileKey: u ? String(u.fileKey || "") : "",
    fileName: u ? String(u.fileName || "") : "", fileExt: u ? String(u.fileExt || "") : "",
    imageUrl: "", thumbUrl: "" };
}

// The custom entries in a line's saved copy, as the `opts.custom` priceItem takes — how an edit to
// the line keeps the customer's design. Built from the stored copy, never from the request.
export function customFromConfig(config) {
  const out = {};
  for (const l of (config && Array.isArray(config.locations) ? config.locations : [])) {
    if (!l || !l.custom) continue;
    out[String(l.location)] = { uploadId: l.uploadId || null, fileKey: l.fileKey || "", fileName: l.fileName || "", fileExt: l.fileExt || "",
      kind: l.kind, addOnCents: Number(l.addOnCents) || 0 };
  }
  return out;
}

// The automatic, unpriced reorder-QR application for a product, as a snapshot entry — or null when
// the product has none (its own choice, else the shop's default). `orgDefault` can be passed when the
// caller already has the shop's settings.
async function reorderQrEntry_(db, orgId, productReorderQr, orgDefault) {
  if (String(productReorderQr || "default") === "none") return null;
  if (!orgDefault) { const t = await getTierPrices(db, orgId); orgDefault = { transferId: t.reorderQrTransferId, graphicId: t.reorderQrGraphicId }; }
  const qr = resolveReorderQr_(productReorderQr, orgDefault);
  if (qr && qr.transferId) {
    const t = await db.prepare("SELECT id, name, visible FROM transfers WHERE id=?").bind(qr.transferId).first();
    return t && Number(t.visible) ? { location: "reorderqr", label: "Reorder QR", graphicId: null, kind: "transfer",
      designId: null, transferId: Number(t.id), graphicName: t.name || "Reorder QR", ink: "", tier: null, addOnCents: 0,
      imageUrl: "", thumbUrl: "", auto: true } : null;
  }
  if (qr && qr.graphicId) {   // chosen the old way, through a graphic
    const qg = await getGraphic(db, qr.graphicId);
    return qg && qg.visible ? { location: "reorderqr", label: "Reorder QR", graphicId: qg.id, kind: qg.kind,
      designId: qg.designId, transferId: qg.transferId, graphicName: qg.name, ink: "", tier: null, addOnCents: 0,
      imageUrl: qg.imageUrl, thumbUrl: qg.thumbUrl, auto: true } : null;
  }
  return null;
}

// An order line keeps a COPY of its options from when it was placed (configJson), so a later fix to
// the catalog — a graphic switched from a transfer to embroidery, a transfer linked to a graphic, a
// reorder QR turned on — doesn't reach orders that already exist. This re-reads the catalog for an
// open order's lines: each chosen graphic's kind / design / transfer / name / picture, and the reorder
// QR. What the customer chose (graphic, ink, color) and what they paid (price, add-ons) never change.
// Lines that are cancelled or fully made are left alone. `apply` false = preview only.
export async function refreshOrderLinesFromCatalog(db, orderId, apply = true) {
  const order = await db.prepare("SELECT orderId, orgId, voidedAt, completedAt FROM orders WHERE orderId=?").bind(orderId).first();
  if (!order) throw new Error("Order not found");
  if (order.voidedAt) throw new Error("This order is voided");
  if (order.completedAt) throw new Error("This order is completed — reopen it first");
  const { results: items } = await db.prepare(
    `SELECT i.id, i.name, i.size, i.qty, i.productId, i.configJson, i.cancelDate, COALESCE(i.manufacturedQty,0) AS made,
            p.configurable, p.reorderQr, p.productId AS hasProduct
     FROM order_items i LEFT JOIN products p ON p.orgId = i.orgId AND p.productId = i.productId
     WHERE i.orderId = ? ORDER BY i.id`).bind(orderId).all();
  const t = await getTierPrices(db, order.orgId);
  const orgDefault = { transferId: t.reorderQrTransferId, graphicId: t.reorderQrGraphicId };
  const how = (l) => l.kind === "embroidery" ? "embroidery" : "a transfer";
  const lines = [];
  for (const it of items) {
    if (it.cancelDate || !it.hasProduct || Number(it.made) >= (Number(it.qty) || 1)) continue;
    const old = tryParse_(it.configJson, null);
    const oldLocs = old && Array.isArray(old.locations) ? old.locations : [];
    const changes = [], locs = [];
    const picked = Number(it.configurable) && old && !old.plain;
    if (picked) for (const l of oldLocs) {
      if (l.auto) continue;
      const g = l.graphicId ? await getGraphic(db, Number(l.graphicId)) : null;
      if (!g) { locs.push(l); continue; }
      const n = Object.assign({}, l, { kind: g.kind, designId: g.designId, transferId: g.transferId, graphicName: g.name, imageUrl: g.imageUrl, thumbUrl: g.thumbUrl });
      if (l.kind !== n.kind) changes.push(`${n.graphicName}: ${how(l)} → ${how(n)}`);
      else if (n.kind === "transfer" && Number(l.transferId || 0) !== Number(n.transferId || 0)) changes.push(`${n.graphicName}: ${n.transferId ? "transfer linked" : "transfer unlinked"}`);
      else if (n.kind === "embroidery" && Number(l.designId || 0) !== Number(n.designId || 0)) changes.push(`${n.graphicName}: design changed`);
      else if ((l.graphicName || "") !== n.graphicName) changes.push(`"${l.graphicName || ""}" is now "${n.graphicName}"`);
      locs.push(n);
    }
    const oldQr = oldLocs.find(l => l.auto) || null;
    const qr = await reorderQrEntry_(db, order.orgId, it.reorderQr, orgDefault);
    if (qr) locs.push(qr);
    if (qr && !oldQr) changes.push(`Reorder QR added (${qr.graphicName})`);
    else if (!qr && oldQr) changes.push("Reorder QR removed");
    else if (qr && oldQr && Number(qr.transferId || 0) !== Number(oldQr.transferId || 0)) changes.push(`Reorder QR is now ${qr.graphicName}`);
    let next;
    if (picked) next = Object.assign({}, old, { locations: locs });
    else if (old && !old.plain) continue;                      // a snapshot we don't understand: leave it
    else {
      // An ordinary line keeps the customer's own design (migrations/0054); only the QR is re-read.
      const kept = oldLocs.filter(l => l && l.custom).concat(qr ? [qr] : []);
      next = kept.length ? { garmentColor: "", size: it.size || "", locations: kept, plain: true } : null;
    }
    const nextJson = next ? JSON.stringify(next) : "";
    if (nextJson === (it.configJson || "") || (!next && !old)) continue;
    if (!changes.length) changes.push("Pictures / names refreshed");
    if (apply) await db.prepare("UPDATE order_items SET configJson=? WHERE id=?").bind(nextJson, Number(it.id)).run();
    lines.push({ itemId: Number(it.id), name: it.name || "", size: it.size || "", changes });
  }
  return { lines };
}

// Validates a configurable line's chosen options and returns { addOnCents, snapshot }. The snapshot
// (stored in order_items.configJson) carries the garment color + one entry per chosen location and,
// when enabled, the unpriced reorder-QR application. Throws pricingError_ on anything invalid or an
// all-None line (a blank garment is never sellable).
async function priceConfigurable_(db, orgId, productRow, size, config, custom = {}) {
  const cfg = config || {};
  const garmentColors = tryParse_(productRow.garmentColorsJson, []) || [];
  const productLocations = tryParse_(productRow.locationsJson, []) || [];
  const garmentColor = String(cfg.garmentColor || cfg.color || "");
  // Stored on the line as typed when the product lists no colours, so it is held to a colour's length.
  if (garmentColor.length > 60) throw pricingError_("Pick a garment color.");
  if (garmentColors.length && !garmentColors.includes(garmentColor)) throw pricingError_("Pick a garment color.");

  // Normalize the client's picks to locKey → {graphicId, ink, custom}. `custom` = the customer's own
  // design at that location (migrations/0054).
  const picks = new Map();
  const rawLocs = cfg.locations;
  const isCustom = (l) => l.custom === true || l.graphicId === "custom";
  if (Array.isArray(rawLocs)) for (const l of rawLocs) { if (l && l.location) picks.set(String(l.location), { graphicId: l.graphicId, ink: l.ink, custom: isCustom(l) }); }
  else if (rawLocs && typeof rawLocs === "object") for (const k of Object.keys(rawLocs)) { const l = rawLocs[k] || {}; picks.set(String(k), { graphicId: l.graphicId, ink: l.ink, custom: isCustom(l) }); }

  const { tiersCents, reorderQrGraphicId, reorderQrTransferId } = await getTierPrices(db, orgId);
  // Graphic + color pairs this product doesn't offer (migrations/0050).
  const blocked = tryParse_(productRow.blockedGraphicColorsJson, []) || [];
  let addOnCents = 0, needsCustomUpload = false;
  const snapLocs = [];
  for (const loc of productLocations) {
    const pick = picks.get(String(loc.key)) || {};
    if (pick.custom) {
      const has = Object.prototype.hasOwnProperty.call(custom, String(loc.key));
      const entry = customDesignEntry_(productRow, loc.key, loc.label || loc.key, has ? custom[String(loc.key)] : null, loc.customDesignPriceCents);
      if (!has) needsCustomUpload = true;
      addOnCents += entry.addOnCents;
      snapLocs.push(entry);
      continue;
    }
    const gid = pick.graphicId == null || pick.graphicId === "" ? null : Number(pick.graphicId);
    if (!gid) continue; // "None" at this location
    if (!(loc.graphicIds || []).map(Number).includes(gid)) throw pricingError_(`That option isn't available at ${loc.label || loc.key}.`);
    const g = await getGraphic(db, gid);
    if (!g || g.orgId !== orgId || !g.visible) throw pricingError_("That option isn't available.");
    if (g.allowedLocations.length && !g.allowedLocations.includes(String(loc.key))) throw pricingError_(`${g.name} can't go on ${loc.label || loc.key}.`);
    if (g.allowedGarmentColors.length && garmentColor && !g.allowedGarmentColors.includes(garmentColor)) throw pricingError_(`${g.name} isn't available on ${garmentColor}.`);
    if (garmentColor && blocked.some(b => Number(b.graphicId) === gid && b.color === garmentColor)) throw pricingError_(`${g.name} isn't available on ${garmentColor}.`);
    let ink = String(pick.ink || "");
    if (g.inkColors.length) { if (!ink) ink = g.inkColors[0]; if (!g.inkColors.includes(ink)) throw pricingError_(`That ink isn't available for ${g.name}.`); }
    else ink = "";
    const add = g.tier ? (tiersCents[g.tier] || 0) : 0;
    addOnCents += add;
    snapLocs.push({ location: String(loc.key), label: loc.label || loc.key, graphicId: gid, kind: g.kind,
      designId: g.designId, transferId: g.transferId, graphicName: g.name, ink, tier: g.tier || null,
      addOnCents: add, imageUrl: g.imageUrl, thumbUrl: g.thumbUrl });
  }
  if (!snapLocs.length) throw pricingError_("Pick at least one graphic — a blank garment can't be ordered.");

  // Reorder QR: an automatic, unpriced transfer application (COGS only), appended to the snapshot.
  // It's a TRANSFER linked directly (migrations/0047) — no graphic in between (see reorderQrEntry_).
  const qrEntry = await reorderQrEntry_(db, orgId, productRow.reorderQr, { transferId: reorderQrTransferId, graphicId: reorderQrGraphicId });
  if (qrEntry) snapLocs.push(qrEntry);
  return { addOnCents, needsCustomUpload, snapshot: { garmentColor, size: size || "", locations: snapLocs } };
}

// ---- Global settings ---------------------------------------------------

export async function getGlobalSettings(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='enabledPayments'").first();
  return {
    enabledPayments: row ? tryParse_(row.value, { card: true, venmo: true, zelle: true, check: true }) : { card: true, venmo: true, zelle: true, check: true }
  };
}

export async function setGlobalSettings(db, settings) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', ?)")
    .bind(JSON.stringify(settings.enabledPayments || {})).run();
}

// ---- Platform state in global_settings / admin_sessions ---------------------------------------
// catalogVersion: bumped by Publish, keys the edge cache. totpSecret / totpLastCounter: 2FA.
// cacheNs: a random per-database id so two environments sharing a zone never share Cache API keys.

export async function getSettingRaw(db, key) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function setSettingRaw(db, key, value) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)").bind(key, String(value)).run();
}

export async function deleteSettingRaw(db, key) {
  await db.prepare("DELETE FROM global_settings WHERE key = ?").bind(key).run();
}

// Atomic increment (one statement), so two Publish clicks can't write the same version.
export async function bumpCatalogVersion(db) {
  await db.prepare(
    "INSERT INTO global_settings (key, value) VALUES ('catalogVersion', '1') " +
    "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"
  ).run();
  return parseInt(await getSettingRaw(db, "catalogVersion"), 10) || 0;
}

// Reads the catalog version and the cache namespace in one query, creating the namespace on first use.
export async function getCatalogCacheState(db) {
  const read = async () => {
    const { results } = await db.prepare(
      "SELECT key, value FROM global_settings WHERE key IN ('catalogVersion', 'cacheNs')"
    ).all();
    const m = {};
    for (const r of results || []) m[r.key] = r.value;
    return m;
  };
  let m = await read();
  if (!m.cacheNs) {
    const ns = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await db.prepare("INSERT OR IGNORE INTO global_settings (key, value) VALUES ('cacheNs', ?)").bind(ns).run();
    m = await read();
  }
  return { version: m.catalogVersion || "0", ns: m.cacheNs };
}

// Records a TOTP counter as used. Returns false if this counter (or a later one) was already
// accepted — a replay. One conditional UPSERT, so two simultaneous logins can't both pass.
export async function claimTotpCounter(db, counter) {
  const r = await db.prepare(
    "INSERT INTO global_settings (key, value) VALUES ('totpLastCounter', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value " +
    "WHERE CAST(global_settings.value AS INTEGER) < CAST(excluded.value AS INTEGER)"
  ).bind(String(counter)).run();
  return (r.meta && r.meta.changes) > 0;
}

export async function insertAdminSession(db, tokenHash, expiresAt, userId = null, pending = null) {
  // Opportunistic cleanup of expired rows: bounded, and only when someone signs in.
  await db.prepare("DELETE FROM admin_sessions WHERE expiresAt < ?").bind(new Date().toISOString()).run();
  await db.prepare("INSERT INTO admin_sessions (tokenHash, expiresAt, userId, pending) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, expiresAt, userId == null ? null : userId, pending || null).run();
}

// A session with the user it belongs to, or null. A row with no user (made before users existed)
// comes back with user: null and is not accepted by the gate.
export async function getAdminSession(db, tokenHash) {
  const r = await db.prepare(
    "SELECT s.expiresAt, s.userId, s.pending, u.id AS uid, u.email, u.name, u.role, u.status, u.totpSecret " +
    "FROM admin_sessions s LEFT JOIN users u ON u.id = s.userId WHERE s.tokenHash = ?").bind(tokenHash).first();
  if (!r) return null;
  return { expiresAt: r.expiresAt, userId: r.userId, pending: r.pending || null,
    user: r.uid == null ? null : { id: r.uid, email: r.email, name: r.name, role: r.role, status: r.status, has2fa: !!r.totpSecret } };
}

export async function setAdminSessionPending(db, tokenHash, pending) {
  await db.prepare("UPDATE admin_sessions SET pending = ? WHERE tokenHash = ?").bind(pending || null, tokenHash).run();
}

// Signs one user out everywhere (optionally keeping the session that asked for it).
export async function deleteUserSessions(db, userId, exceptTokenHash = "") {
  await db.prepare("DELETE FROM admin_sessions WHERE userId = ? AND tokenHash <> ?").bind(userId, exceptTokenHash || "").run();
}

export async function deleteAllAdminSessions(db) {
  await db.prepare("DELETE FROM admin_sessions").run();
}

// ---- Users (migrations/0053) -------------------------------------------------------------------
// One row per person who can sign in to the admin. Nothing here decides who may do what — that is
// functions/_lib/adminAuth.js. Emails are stored lower-cased; '' is the owner adopted from an
// install that predates users, until they give an address.
const USER_COLUMNS = "id, email, name, role, status, password, mustChangePassword, totpSecret, totpLastCounter, recoveryCodes, createdAt, updatedAt, lastLoginAt";
export const USER_ROLES = ["staff", "manager", "admin"];   // lowest to highest

export async function getUserById(db, id) {
  return (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first()) || null;
}

export async function getUserByEmail(db, email) {
  return (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ? ORDER BY id LIMIT 1`).bind(String(email || "").trim().toLowerCase()).first()) || null;
}

export async function listUsers(db) {
  const { results } = await db.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY status = 'disabled', role <> 'admin', role <> 'manager', name COLLATE NOCASE, id`).all();
  return results || [];
}

// What the sign-in code needs to decide whether the installer's passphrase still opens the admin:
// how many users there are, and every admin (active first, oldest first).
export async function getBootstrapState(db) {
  const n = await db.prepare("SELECT count(*) AS n FROM users").first();
  const { results } = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE role = 'admin' ORDER BY status = 'disabled', id`).all();
  return { userCount: (n && n.n) || 0, admins: results || [] };
}

// Creates a user. Returns the new row. A taken email throws (the unique index).
export async function insertUser(db, { email = "", name = "", role = "staff", status = "active", password = null, mustChangePassword = false, totpSecret = null, totpLastCounter = null }) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    "INSERT INTO users (email, name, role, status, password, mustChangePassword, totpSecret, totpLastCounter, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(String(email).trim().toLowerCase(), String(name).trim(), role, status, password, mustChangePassword ? 1 : 0, totpSecret, totpLastCounter, now, now).run();
  return getUserById(db, r.meta.last_row_id);
}

// The first admin of an install: made only while there are no users at all, in one statement, so
// two requests arriving together can't make two. Returns true if this call made it.
export async function insertFirstAdmin(db, { password = null, totpSecret = null, totpLastCounter = null } = {}) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    "INSERT INTO users (email, name, role, status, password, totpSecret, totpLastCounter, createdAt, updatedAt) " +
    "SELECT '', '', 'admin', 'active', ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)"
  ).bind(password, totpSecret, totpLastCounter, now, now).run();
  return (r.meta && r.meta.changes) > 0;
}

// Changes the listed columns of one user (only these may be changed this way).
const USER_PATCHABLE = ["email", "name", "password", "mustChangePassword", "totpSecret", "totpLastCounter", "recoveryCodes", "lastLoginAt"];
export async function updateUser(db, id, patch) {
  const cols = Object.keys(patch || {}).filter(k => USER_PATCHABLE.includes(k));
  if (!cols.length) return;
  const val = (k) => k === "email" ? String(patch[k] || "").trim().toLowerCase() : k === "name" ? String(patch[k] || "").trim() : k === "mustChangePassword" ? (patch[k] ? 1 : 0) : (patch[k] == null ? null : patch[k]);
  await db.prepare(`UPDATE users SET ${cols.map(c => c + " = ?").join(", ")}, updatedAt = ? WHERE id = ?`)
    .bind(...cols.map(val), new Date().toISOString(), id).run();
}

// Role and status change through here ONLY: the statement refuses to leave the install without an
// active admin (it changes nothing, and returns false), and because the check and the change are
// one statement, two admins demoting each other at the same moment can't both succeed.
export async function setUserRoleAndStatus(db, id, { role, status }) {
  const r = await db.prepare(
    "UPDATE users SET role = COALESCE(?1, role), status = COALESCE(?2, status), updatedAt = ?3 WHERE id = ?4 AND (" +
    "  NOT (role = 'admin' AND status = 'active')" +                                     // not an active admin now: nothing to protect
    "  OR (COALESCE(?1, role) = 'admin' AND COALESCE(?2, status) = 'active')" +          // still one afterwards
    "  OR EXISTS (SELECT 1 FROM users o WHERE o.role = 'admin' AND o.status = 'active' AND o.id <> ?4))"   // someone else is
  ).bind(role || null, status || null, new Date().toISOString(), id).run();
  return (r.meta && r.meta.changes) > 0;
}

// Records a user's TOTP counter as used; false if this counter (or a later one) already was.
export async function claimUserTotpCounter(db, userId, counter) {
  const r = await db.prepare("UPDATE users SET totpLastCounter = ?1 WHERE id = ?2 AND (totpLastCounter IS NULL OR totpLastCounter < ?1)").bind(counter, userId).run();
  return (r.meta && r.meta.changes) > 0;
}

// Replaces a user's recovery codes only if they are still what the caller read, so one code can't
// be spent twice by two sign-ins racing each other.
export async function replaceRecoveryCodes(db, userId, before, after) {
  const r = await db.prepare("UPDATE users SET recoveryCodes = ?1 WHERE id = ?2 AND recoveryCodes IS ?3").bind(after, userId, before).run();
  return (r.meta && r.meta.changes) > 0;
}

export async function getAdminSessionExpiry(db, tokenHash) {
  const row = await db.prepare("SELECT expiresAt FROM admin_sessions WHERE tokenHash = ?").bind(tokenHash).first();
  return row ? row.expiresAt : null;
}

export async function deleteAdminSession(db, tokenHash) {
  await db.prepare("DELETE FROM admin_sessions WHERE tokenHash = ?").bind(tokenHash).run();
}

// Machine Files screen options — kept as their own key (admin-only, not part of the storefront
// catalog that getGlobalSettings feeds). Currently just whether the per-file Delete button shows.
// Deleting over the machine protocol is firmware-disabled today (opcode cf24 exists but always
// refuses — see the send-agent's protocol notes), so the button is HIDDEN by default; this lets the
// admin turn it on if a firmware update ever enables delete.
export async function getMachineSettings(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='machineSettings'").first();
  return row ? tryParse_(row.value, { showDeleteButton: false }) : { showDeleteButton: false };
}

export async function setMachineSettings(db, settings) {
  const clean = { showDeleteButton: !!(settings && settings.showDeleteButton) };
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('machineSettings', ?)")
    .bind(JSON.stringify(clean)).run();
}

// The "ship from" address on shipping labels/quotes — admin-editable business
// info (Global Settings screen), NOT a secret, so it lives here in D1 rather
// than as an environment variable: it can be corrected without a deploy or a
// dashboard trip. Only SHIPPO_API_KEY (the credential that authorizes charges
// to the account) belongs in the secret store; the address itself is printed
// on every label anyway.
const SHIP_FROM_DEFAULTS = { name: "", street1: "", city: "", state: "", zip: "", phone: "", email: "" };

// Fallback for an install that set the address as environment variables
// (SHIP_FROM_STREET1 etc.) instead of in Global Settings: quotes keep working
// until the form is filled in, and the form pre-fills from them.
// Precedence per field: a value saved in D1 > the env var > default.
// Callers that don't pass `env` (tests, setters) see D1 + defaults only.
const LEGACY_SHIP_FROM_ENV = { name: "SHIP_FROM_NAME", street1: "SHIP_FROM_STREET1", city: "SHIP_FROM_CITY",
  state: "SHIP_FROM_STATE", zip: "SHIP_FROM_ZIP", phone: "SHIP_FROM_PHONE", email: "SHIP_FROM_EMAIL" };

// ---- Features: optional parts of the site, each behind a switch --------------------------------
// One global_settings value ("features"), edited under Tools → Global settings → Features. Every
// feature is ON unless it was saved as false, so a new install (or a database with nothing saved)
// has everything. Turning one off hides its pages in the admin and makes the server refuse its
// actions (403); no table or row is touched, so turning it back on restores everything.
// "storefront" is different in kind: it has no admin pages of its own. Off, the public side is
// closed (catalog.js serves no shop, orders.js / checkout.js / shipping.js refuse a customer's
// order, card checkout and rate quote) and the whole admin keeps working.
// Blank / transfer stock and cost of goods are NOT a feature: making an order uses them.
export const FEATURES = [
  { key: "storefront", label: "Storefront",
    description: "Customers can browse shops and place orders online. Off: every shop address and the main address show a short “online ordering isn't available” page, and the site is back office only — orders are entered in the admin, and payment links and design proofs you send still work." },
  { key: "production", label: "Production",
    description: "Embroidery production: threads, hoops, designs and their stitch files, machines, Machine Files, Run Order and the Run Times report. Off: orders are still moved through their stages by hand on the Orders page, and no digitizing step or design is asked for." },
  { key: "bookkeeping", label: "Bookkeeping",
    description: "Expenses and receipts, Accounts & money, Reconcile, and Periods & Export (closing months, the accountant export). Off: payments on orders, the Revenue and Sales Tax reports and Stripe fees stay; months closed earlier stay locked." },
  { key: "shipping", label: "Shipping",
    description: "Carrier shipping through Shippo: rate quotes at checkout, buying labels, package sizes, the ship-from address, tracking checks in the morning roll-up and the “your order has shipped” email. Off: shops offer local pickup and their own delivery options only." },
  { key: "designVerification", label: "Design approval",
    description: "Emailing a customer a design proof to approve, and the “Design approved” stage on orders. Off: no order waits for a customer's approval, and links already sent say approval isn't available." },
];
const FEATURE_KEYS_ = FEATURES.map(f => f.key);
// { production: true, … } from whatever was saved: only an explicit false turns a feature off.
export function normalizeFeatures(saved) {
  const out = {};
  for (const k of FEATURE_KEYS_) out[k] = !(saved && saved[k] === false);
  return out;
}
export async function getFeatures(db) {
  if (!db) return normalizeFeatures(null);
  let saved = null;
  try { const row = await db.prepare("SELECT value FROM global_settings WHERE key='features'").first(); saved = row ? tryParse_(row.value, null) : null; }
  catch (e) { /* no table yet — everything on */ }
  return normalizeFeatures(saved);
}
// Saves the switches that are passed (true / false); one left out keeps its value. Unknown keys
// are ignored. Returns the full set.
export async function setFeatures(db, p) {
  const next = await getFeatures(db);
  for (const k of FEATURE_KEYS_) if (p && typeof p[k] === "boolean") next[k] = p[k];
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('features', ?)").bind(JSON.stringify(next)).run();
  return next;
}
// SQL: true unless the feature was saved as false. For rules that live in a query (which orders
// need design approval / digitizing), so they can't disagree with the setting.
const featureOnSql_ = (key) => `(COALESCE((SELECT json_extract(gs.value, '$.${key}') FROM global_settings gs WHERE gs.key = 'features' AND json_valid(gs.value)), 1) <> 0)`;

// ---- Region: time zone and country ------------------------------------------------------------
// One global_settings value ("locale"), edited under Tools → Global settings → Region.
//   timeZone — an IANA name ("Europe/London"). Used wherever a date is shown to a person by the
//              server (emails, the roll-up) and wherever the server needs "today" or the local hour
//              (the roll-up's schedule). Blank = not set here: the TIMEZONE variable is used, then UTC.
//   country  — "US" (the default: 5-digit ZIPs, 2-letter states, the ZIP-vs-state check, carrier
//              rates by ZIP) or "OTHER" (postal code and state / region are free text, no ZIP check,
//              no carrier rate quotes). Not full internationalisation — just not US-only.
// Report month boundaries are NOT affected: months in the reports are UTC months.
export const LOCALE_COUNTRIES = ["US", "OTHER"];
export const DEFAULT_TIME_ZONE = "UTC";
export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz.trim() }); return true; } catch (e) { return false; }
}
const localeCountry_ = (c) => (String(c || "").trim().toUpperCase() === "OTHER" ? "OTHER" : "US");

export async function getLocaleSettings(db) {
  const out = { timeZone: "", country: "US" };
  if (!db) return out;
  let saved = {};
  try { const row = await db.prepare("SELECT value FROM global_settings WHERE key='locale'").first(); saved = row ? (tryParse_(row.value, {}) || {}) : {}; }
  catch (e) { /* no table yet — defaults */ }
  if (isValidTimeZone(saved.timeZone)) out.timeZone = String(saved.timeZone).trim();
  out.country = localeCountry_(saved.country);
  return out;
}

// Saves what's passed (a field left undefined keeps its value). Throws (userFacing) on a time zone
// the runtime doesn't know or a country that isn't offered. A blank time zone clears it.
export async function setLocaleSettings(db, p) {
  const current = await getLocaleSettings(db);
  const next = { ...current };
  const bad = (m) => { const e = new Error(m); e.userFacing = true; return e; };
  if (p && p.timeZone !== undefined) {
    const tz = String(p.timeZone == null ? "" : p.timeZone).trim();
    if (tz && !isValidTimeZone(tz)) throw bad(`"${tz.slice(0, 64)}" isn't a time zone this site knows. Use a name like Europe/London, America/Chicago or Asia/Tokyo.`);
    next.timeZone = tz;
  }
  if (p && p.country !== undefined) {
    const c = String(p.country == null ? "" : p.country).trim().toUpperCase();
    if (!LOCALE_COUNTRIES.includes(c)) throw bad("Country must be US or OTHER.");
    next.country = c;
  }
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('locale', ?)").bind(JSON.stringify(next)).run();
  return next;
}

// THE time zone: the one saved in Region, else the TIMEZONE variable, else UTC. Never throws — a
// database that can't be read just falls through to the next source.
export async function resolveTimeZone(env) {
  let saved = "";
  try { saved = (await getLocaleSettings(env && env.DB)).timeZone; } catch (e) { /* fall through */ }
  if (saved) return saved;
  const fromEnv = env && env.TIMEZONE ? String(env.TIMEZONE).trim() : "";
  return isValidTimeZone(fromEnv) ? fromEnv : DEFAULT_TIME_ZONE;
}

// "YYYY-MM-DD" on the calendar of a time zone (an unknown zone counts as UTC).
export function dateInTimeZone(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => parts.find(x => x.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
// Today's date where the business is — what "not in the future" and "overdue" are measured against.
export async function localToday(env, now) {
  return dateInTimeZone(now || new Date(), await resolveTimeZone(env));
}

// ---- Business profile -----------------------------------------------------------------------
// Who runs this install: the name on the storefront, emails and labels, where notifications go, and
// how customers pay by Venmo / Zelle / check. One global_settings value ("business"), edited under
// Tools → Global settings → Business profile. Everything is optional; BUSINESS_NAME_FALLBACK stands
// in for a missing name so nothing ever renders blank.
export const BUSINESS_NAME_FALLBACK = "Our shop";
const BUSINESS_FIELDS = { name: 120, legalName: 160, tagline: 200, supportEmail: 200, ownerEmail: 200, receiptsEmail: 200,
  mailingAddress: 300, venmo: 60, zelle: 200, footer: 300 };
const BUSINESS_EMAIL_FIELDS = ["supportEmail", "ownerEmail", "receiptsEmail"];
// What a visitor's browser may see. ownerEmail / receiptsEmail are internal inboxes and stay private.
const BUSINESS_PUBLIC_FIELDS = ["name", "legalName", "tagline", "supportEmail", "mailingAddress", "venmo", "zelle", "footer"];

export async function getBusinessProfile(db) {
  const out = {};
  for (const k of Object.keys(BUSINESS_FIELDS)) out[k] = "";
  if (!db) return out;
  let saved = {};
  try { const row = await db.prepare("SELECT value FROM global_settings WHERE key='business'").first(); saved = row ? (tryParse_(row.value, {}) || {}) : {}; }
  catch (e) { /* no table yet — defaults */ }
  for (const k of Object.keys(BUSINESS_FIELDS)) if (saved[k]) out[k] = String(saved[k]);
  return out;
}

export function publicBusinessProfile(p) {
  const out = {};
  for (const k of BUSINESS_PUBLIC_FIELDS) out[k] = (p && p[k]) || "";
  return out;
}

// Returns the saved profile. Throws (userFacing) on an invalid email or Venmo name.
export async function setBusinessProfile(db, p) {
  const clean = {};
  for (const k of Object.keys(BUSINESS_FIELDS)) clean[k] = String((p && p[k]) == null ? "" : p[k]).trim().slice(0, BUSINESS_FIELDS[k]);
  clean.venmo = clean.venmo.replace(/^@/, "");
  const bad = (m) => { const e = new Error(m); e.userFacing = true; return e; };
  for (const k of BUSINESS_EMAIL_FIELDS) if (clean[k] && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(clean[k])) throw bad("That doesn't look like a valid email: " + clean[k]);
  if (clean.venmo && !/^[A-Za-z0-9_-]+$/.test(clean.venmo)) throw bad("A Venmo username has only letters, numbers, - and _");
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('business', ?)").bind(JSON.stringify(clean)).run();
  return clean;
}

export async function getShipFromAddress(db, env) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='shipFrom'").first();
  const saved = row ? tryParse_(row.value, {}) : {};
  const out = {};
  for (const k of Object.keys(SHIP_FROM_DEFAULTS)) {
    const legacy = env && env[LEGACY_SHIP_FROM_ENV[k]] ? String(env[LEGACY_SHIP_FROM_ENV[k]]).trim() : "";
    out[k] = saved[k] || legacy || SHIP_FROM_DEFAULTS[k];
  }
  return out;
}

// `country` (Region setting): outside the US the state / region is free text, kept as typed.
export async function setShipFromAddress(db, addr, country) {
  const a = addr || {};
  const other = localeCountry_(country) === "OTHER";
  const clean = {
    name: String(a.name || "").trim().slice(0, 100),
    street1: String(a.street1 || "").trim().slice(0, 200),
    city: String(a.city || "").trim().slice(0, 100),
    state: other ? String(a.state || "").trim().slice(0, 50) : String(a.state || "").trim().toUpperCase().slice(0, 2),
    zip: String(a.zip || "").trim().slice(0, 12),
    phone: String(a.phone || "").trim().slice(0, 30),
    email: String(a.email || "").trim().slice(0, 200),
  };
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('shipFrom', ?)")
    .bind(JSON.stringify(clean)).run();
  return clean;
}

export async function getBoxPresets(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='boxPresets'").first();
  return row ? tryParse_(row.value, null) : null;
}

export async function addShippingPaidAmount(db, orderId, amount) {
  await db.prepare("UPDATE orders SET shippingPaidCents = shippingPaidCents + ? WHERE orderId = ?")
    .bind(toCents(amount), orderId).run();
}

export async function setShippingPaidAmount(db, orderId, amount) {
  await db.prepare("UPDATE orders SET shippingPaidCents = ? WHERE orderId = ?")
    .bind(Math.max(0, toCents(amount)), orderId).run();
}

export async function setBoxPresets(db, presets) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('boxPresets', ?)")
    .bind(JSON.stringify(presets)).run();
}

// ---- Inventory helpers -------------------------------------------------

function parseInventoryItem_(row) {
  return {
    id:            Number(row.id),
    productType:   row.productType   || "",
    vendor:        row.vendor        || "",
    brand:         row.brand         || "",
    sku:           row.sku           || "",
    color:         row.color         || "",
    size:          row.size          || "",
    purchasePrice: Number(row.purchasePrice) || 0,
    quantity:      Number(row.quantity)      || 0,
    notes:         row.notes         || "",
    createdAt:     row.createdAt     || "",
    updatedAt:     row.updatedAt     || "",
  };
}

export async function getAllInventory(db) {
  const { results } = await db.prepare(
    "SELECT * FROM inventory ORDER BY productType, brand, color, size"
  ).all();
  return results.map(parseInventoryItem_);
}

export async function createInventoryItem(db, fields) {
  const now = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO inventory (productType, vendor, brand, sku, color, size, purchasePrice, quantity, notes, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(fields.productType   || "").slice(0, 80),
    String(fields.vendor        || "").slice(0, 100),
    String(fields.brand         || "").slice(0, 100),
    String(fields.sku           || "").slice(0, 100),
    String(fields.color         || "").slice(0, 80),
    String(fields.size          || "").slice(0, 40),
    Math.max(0, Number(fields.purchasePrice) || 0),
    Math.max(0, Math.floor(Number(fields.quantity) || 0)),
    String(fields.notes         || "").slice(0, 500),
    now, now
  ).run();
  return { id: Number(result.meta.last_row_id), createdAt: now, updatedAt: now };
}

export async function updateInventoryItem(db, id, fields) {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE inventory SET productType=?, vendor=?, brand=?, sku=?, color=?, size=?, purchasePrice=?, quantity=?, notes=?, updatedAt=?
     WHERE id=?`
  ).bind(
    String(fields.productType   || "").slice(0, 80),
    String(fields.vendor        || "").slice(0, 100),
    String(fields.brand         || "").slice(0, 100),
    String(fields.sku           || "").slice(0, 100),
    String(fields.color         || "").slice(0, 80),
    String(fields.size          || "").slice(0, 40),
    Math.max(0, Number(fields.purchasePrice) || 0),
    Math.max(0, Math.floor(Number(fields.quantity) || 0)),
    String(fields.notes         || "").slice(0, 500),
    now, Number(id)
  ).run();
}

export async function deleteInventoryItem(db, id) {
  await db.prepare("DELETE FROM inventory WHERE id=?")
    .bind(Number(id)).run();
}

// ---- Payments & discounts ----------------------------------------------

// ---- Ledger vocabulary (migrations/0008) ----------------------------------
export const PAYMENT_METHODS = ["card", "venmo", "zelle", "check", "cash", "other"];
// "Card" / "Venmo" / … as chosen at checkout → ledger method.
export function methodFromPaymentMethod(paymentMethod) {
  const m = String(paymentMethod || "").trim().toLowerCase();
  return PAYMENT_METHODS.includes(m) ? m : "other";
}

// externalRef (e.g. a Stripe PaymentIntent / refund id) is UNIQUE when
// non-empty, so recording the same external movement twice is a no-op.
// opts: { method, reference, feeCents, kind: 'payment'|'refund'|'dispute',
// receivedAt }. Refunds and lost disputes are NEGATIVE amounts.
// Returns the new row id, or 0 when it was already recorded.
export async function addOrderPayment(db, orderId, amount, note, externalRef = "", opts = {}) {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const method = PAYMENT_METHODS.includes(opts.method) ? opts.method : "other";
  const kind = ["payment", "refund", "dispute"].includes(opts.kind) ? opts.kind : "payment";
  // Which account the money moved through: given, or the one the method implies.
  const accountId = opts.accountId ? Number(opts.accountId) : await accountIdForMethod(db, method);
  const result = await db.prepare(
    `INSERT OR IGNORE INTO order_payments (orderId, amountCents, note, receivedAt, externalRef, method, reference, feeCents, kind, accountId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(orderId, toCents(amount), note || "", receivedAt, externalRef || "", method,
    String(opts.reference || "").slice(0, 100), Math.max(0, Math.round(Number(opts.feeCents) || 0)), kind, accountId).run();
  const id = result.meta.changes > 0 ? Number(result.meta.last_row_id) : 0;
  if (id && opts.shippingCents > 0) await db.prepare("UPDATE order_payments SET shippingCents=? WHERE id=?").bind(Math.round(opts.shippingCents), id).run();
  if (id) await refreshPaidStatus(db, orderId);
  return id;
}

// Records a shipping payment AND bumps orders.shippingPaidCents atomically
// (one D1 batch = one transaction). The UPDATE applies only if the INSERT
// actually added a row — SQLite's changes() reports the rows changed by the
// previous statement on this connection — so replaying the same externalRef
// changes nothing. (Matching the new row by its receivedAt timestamp would not
// do: two deliveries in the same millisecond could share it.)
export async function addShippingPayment(db, orderId, amount, note, externalRef, feeCents = 0, receivedAt = new Date().toISOString()) {
  const amt = toCents(amount);
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO order_payments (orderId, amountCents, note, receivedAt, externalRef, method, feeCents, accountId) VALUES (?, ?, ?, ?, ?, 'card', ?, ?)"
    ).bind(orderId, amt, note || "", receivedAt, externalRef || "", Math.max(0, Math.round(Number(feeCents) || 0)), await accountIdForMethod(db, "card")),
    db.prepare(
      "UPDATE orders SET shippingPaidCents = shippingPaidCents + ? WHERE orderId = ? AND changes() > 0"
    ).bind(amt, orderId),
  ]);
  await refreshPaidStatus(db, orderId);
}

// A Stripe refund on a shipping payment also lowers orders.shippingPaidCents
// (only when that refund row was newly recorded — callers pass its id).
export async function reduceShippingPaidForRefund(db, orderId, paymentIntentId, refundCents) {
  const ship = await db.prepare("SELECT 1 AS x FROM order_payments WHERE orderId = ? AND externalRef = ? AND note LIKE 'Shipping%'")
    .bind(orderId, paymentIntentId || "").first();
  if (!ship) return false;
  await db.prepare("UPDATE orders SET shippingPaidCents = MAX(0, shippingPaidCents - ?) WHERE orderId = ?")
    .bind(Math.max(0, Math.round(Number(refundCents) || 0)), orderId).run();
  return true;
}

// ---- Stripe webhook idempotency ----------------------------------------

export async function hasProcessedStripeEvent(db, eventId) {
  const row = await db.prepare("SELECT 1 AS x FROM stripe_events WHERE eventId=?").bind(eventId).first();
  return !!row;
}

export async function recordStripeEvent(db, eventId, type, orderId) {
  await db.prepare(
    "INSERT OR IGNORE INTO stripe_events (eventId, type, orderId, processedAt) VALUES (?, ?, ?, ?)"
  ).bind(eventId, type || "", orderId || null, new Date().toISOString()).run();
}

export async function getOrderPaymentById(db, id) {
  const row = await db.prepare("SELECT id, orderId, amountCents, note, receivedAt, externalRef, method, reference, feeCents, kind, voidedAt, voidReason, accountId FROM order_payments WHERE id=?")
    .bind(Number(id)).first();
  return row ? { ...parsePayment_(row), externalRef: row.externalRef || "" } : null;
}

export async function deleteOrderPayment(db, id) {
  const row = await db.prepare("SELECT orderId FROM order_payments WHERE id=?").bind(Number(id)).first();
  await db.prepare("DELETE FROM order_payments WHERE id=?").bind(Number(id)).run();
  if (row) await refreshPaidStatus(db, row.orderId);
}

export async function setOrderDiscount(db, orderId, amount, note) {
  // A discount also reduces the tax collected (backed out of it, or not added, per the order's mode).
  const discountCents = Math.max(0, toCents(amount));
  await db.prepare("UPDATE orders SET discountCents=?, discountNote=? WHERE orderId=?").bind(discountCents, note || "", orderId).run();
  await recomputeOrderTax_(db, orderId);
  await refreshPaidStatus(db, orderId);
}

// Recomputes the cached orders.paid / paidAt from the payments ledger.
// Only kind='payment' rows count toward "paid": a later refund or lost
// dispute is money going back out, recorded separately (parseOrder_'s
// refundedAmount / netReceived) — it doesn't turn a settled order into one
// with a balance due.
// Paid = money received covers the effective total (active items, plus
// shipping when any item is active, minus discount). An order that owes $0
// keeps whatever the admin set, since there's nothing for the ledger to show.
// paidAt is the time the ledger first covered the total (the latest payment
// at that moment); it's cleared if the order stops being covered.
export async function refreshPaidStatus(db, orderId) {
  const row = await withTaxMode_((tm) => db.prepare(`
    SELECT o.paid, o.paidAt, ${ORDER_AMOUNT_COLS_.replace("o.taxMode", tm + " AS taxMode")},
      COALESCE((SELECT SUM(amountCents) FROM order_payments WHERE orderId = o.orderId AND kind = 'payment' AND voidedAt IS NULL), 0) AS receivedCents,
      (SELECT MAX(receivedAt) FROM order_payments WHERE orderId = o.orderId AND kind = 'payment' AND voidedAt IS NULL) AS lastPaymentAt
    FROM orders o WHERE o.orderId = ?`).bind(orderId).first());
  if (!row) return null;
  const owed = orderAmountsOfRow_(row).owedCents;
  const received = Number(row.receivedCents) || 0;
  if (owed === 0) return { paid: !!row.paid, owedCents: 0, receivedCents: received };
  const paid = received >= owed ? 1 : 0;
  if (paid !== Number(row.paid)) {
    await db.prepare("UPDATE orders SET paid = ?, paidAt = ? WHERE orderId = ?")
      .bind(paid, paid ? (row.lastPaymentAt || new Date().toISOString()) : null, orderId).run();
  }
  return { paid: !!paid, owedCents: owed, receivedCents: received };
}

// "Mark as paid": records a ledger payment for whatever is still owed (so the
// books show money received, not just a flag), then refreshes the paid cache.
// For an order that owes $0 it just sets the flag. Returns the amount recorded.
export async function settleOrderBalance(db, orderId, note) {
  const state = await refreshPaidStatus(db, orderId);
  if (!state) return 0;
  const balance = state.owedCents - state.receivedCents;
  if (balance > 0) {
    const o = await db.prepare("SELECT paymentMethod FROM orders WHERE orderId=?").bind(orderId).first();
    await addOrderPayment(db, orderId, fromCents(balance), note || "Marked paid", "",
      { method: methodFromPaymentMethod(o && o.paymentMethod) });
    return fromCents(balance);
  }
  if (state.owedCents === 0) {
    await db.prepare("UPDATE orders SET paid = 1, paidAt = COALESCE(paidAt, ?) WHERE orderId = ?")
      .bind(new Date().toISOString(), orderId).run();
  }
  return 0;
}

// ---- Blanks (global blank catalog with per-size stock) -----------------

// A blank's stock is keyed by (blankId, color, size) since migrations/0037. A blank carries a
// `colors[]` dimension — each color { color, images[], sortOrder, sizes[] } — built from the
// blank_colors catalog (authoritative order + images) merged with the color-keyed blank_sizes.
// `sizes` (flat, each carrying its color) and the legacy scalar `color` are kept for transitional
// readers (the Run queue / blankName_ still read blanks.color as a display fallback).
// A blank color image, as either the legacy bare URL string or the new {url, locationId} object
// (migrations/0041 — tagging an image with a garment location). Always returns {url, locationId},
// so every reader gets one shape without a data migration. Drops entries with no url.
function normBlankImage_(x) {
  if (x && typeof x === "object") {
    const url = String(x.url || "").slice(0, 500);
    if (!url) return null;
    const locationId = x.locationId == null || x.locationId === "" ? null : (Number(x.locationId) || null);
    return { url, locationId };
  }
  const url = String(x || "").slice(0, 500);
  return url ? { url, locationId: null } : null;
}

function parseBlank_(row, sizeRows, colorRows, needleTypeNames) {
  const needleTypeId = row.needleTypeId == null ? null : Number(row.needleTypeId);
  const sizes = (sizeRows || []).map(s => ({
    id: Number(s.id), color: s.color || "", size: s.size || "",
    purchasePrice: fromCents(s.purchasePriceCents), quantity: Number(s.quantity) || 0,
  }));
  const byColor = new Map();
  for (const c of (colorRows || [])) byColor.set(c.color || "", { color: c.color || "", images: (tryParse_(c.imagesJson, []) || []).map(normBlankImage_).filter(Boolean), sortOrder: Number(c.sortOrder) || 0, sizes: [] });
  for (const s of sizes) { if (!byColor.has(s.color)) byColor.set(s.color, { color: s.color, images: [], sortOrder: 0, sizes: [] }); byColor.get(s.color).sizes.push(s); }
  const colors = [...byColor.values()].sort((a, b) => (a.sortOrder - b.sortOrder) || a.color.localeCompare(b.color));
  return {
    id:          Number(row.id),
    name:        row.name        || "",
    productType: row.productType || "",
    vendor:      row.vendor      || "",
    brand:       row.brand       || "",
    sku:         row.sku         || "",
    color:       row.color       || "",
    notes:       row.notes       || "",
    // The needle TYPE this garment wants (migrations/0044) — Run Order pairs it with the size
    // that follows the thread weight. null / "" = not set.
    needleTypeId,
    needleType:  (needleTypeId != null && needleTypeNames && needleTypeNames[needleTypeId]) || "",
    createdAt:   row.createdAt   || "",
    updatedAt:   row.updatedAt   || "",
    colors,
    sizes,
  };
}

// Normalizes the two accepted shapes into [{color, images[], sizes:[{size,purchasePrice,quantity}]}]:
// the new multi-color form (fields.colors), or the legacy single-color form (fields.color + a sizes
// array), so older callers/tests that pass createBlank(db, {color}, sizes) keep working.
function normalizeBlankColors_(fields, sizesArg) {
  if (Array.isArray(fields.colors)) {
    return fields.colors.map(c => ({
      color: String(c.color || "").slice(0, 80),
      images: Array.isArray(c.images) ? c.images.slice(0, 20).map(normBlankImage_).filter(Boolean) : [],
      sizes: Array.isArray(c.sizes) ? c.sizes : [],
    }));
  }
  return [{ color: String(fields.color || "").slice(0, 80),
            images: Array.isArray(fields.images) ? fields.images.slice(0, 20).map(normBlankImage_).filter(Boolean) : [],
            sizes: Array.isArray(sizesArg) ? sizesArg : (Array.isArray(fields.sizes) ? fields.sizes : []) }];
}

export async function getAllBlanks(db) {
  const { results: blankRows } = await db.prepare(
    "SELECT * FROM blanks ORDER BY productType, brand, name, color"
  ).all();
  if (!blankRows.length) return [];
  const [{ results: sizeRows }, { results: colorRows }, needleTypes] = await Promise.all([
    db.prepare("SELECT * FROM blank_sizes ORDER BY blankId, color, size").all(),
    db.prepare("SELECT * FROM blank_colors ORDER BY blankId, sortOrder, color").all().catch(() => ({ results: [] })),
    listNeedleTypes(db),
  ]);
  const needleTypeNames = {};
  for (const t of needleTypes) needleTypeNames[t.id] = t.name;
  const sizesByBlank = {}, colorsByBlank = {};
  for (const s of sizeRows) (sizesByBlank[s.blankId] = sizesByBlank[s.blankId] || []).push(s);
  for (const c of colorRows) (colorsByBlank[c.blankId] = colorsByBlank[c.blankId] || []).push(c);
  return blankRows.map(r => parseBlank_(r, sizesByBlank[r.id] || [], colorsByBlank[r.id] || [], needleTypeNames));
}

// Upserts a blank's color catalog + color-keyed sizes, recording any starting/edited stock as
// movements so the history always sums to stock. `mode` 'create' records new stock as 'adjust'
// "Initial stock"; 'update' diffs new−old per (color,size) and records the delta.
async function writeBlankColors_(db, id, colors, mode) {
  const now = new Date().toISOString();
  // Old stock for diffing (update) / nothing (create).
  const { results: oldRows } = mode === "update"
    ? await db.prepare("SELECT color, size, quantity, purchasePriceCents FROM blank_sizes WHERE blankId=?").bind(Number(id)).all()
    : { results: [] };
  const oldByKey = new Map(oldRows.map(r => [(r.color || "") + "|" + r.size, r]));
  // Replace the color catalog + sizes wholesale, then re-seed from `colors`.
  await db.batch([
    db.prepare("DELETE FROM blank_colors WHERE blankId=?").bind(Number(id)),
    db.prepare("DELETE FROM blank_sizes WHERE blankId=?").bind(Number(id)),
  ]);
  const writes = [], movements = [];
  let sortOrder = 0;
  for (const c of colors) {
    const color = String(c.color || "").slice(0, 80);
    writes.push(db.prepare("INSERT INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(Number(id), color, JSON.stringify(c.images || []), sortOrder++, now, now));
    for (const s of (c.sizes || [])) {
      const size = String(s.size || "").slice(0, 20);
      if (!size) continue;
      const qty = Math.max(0, Math.floor(Number(s.quantity) || 0));
      const costCents = Math.max(0, toCents(s.purchasePrice));
      writes.push(db.prepare("INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity) VALUES (?, ?, ?, ?, ?)")
        .bind(Number(id), color, size, costCents, qty));
      const old = oldByKey.get(color + "|" + size);
      const delta = qty - (old ? Number(old.quantity) || 0 : 0);
      if (delta) movements.push({ blankId: Number(id), color, size, qtyDelta: delta, unitCostCents: costCents || (old ? old.purchasePriceCents : 0),
        kind: "adjust", note: mode === "update" ? "Edited in blank form" : "Initial stock" });
      oldByKey.delete(color + "|" + size);
    }
  }
  // Sizes present before but gone now → record the removal as an adjustment to zero.
  for (const [key, old] of oldByKey) {
    const q = Number(old.quantity) || 0;
    if (q) { const [color, size] = key.split("|"); movements.push({ blankId: Number(id), color, size, qtyDelta: -q, unitCostCents: old.purchasePriceCents, kind: "adjust", note: "Edited in blank form" }); }
  }
  if (writes.length) await db.batch(writes);
  for (const m of movements) await insertMovement_(db, m);
}

export async function createBlank(db, fields, sizes) {
  const now = new Date().toISOString();
  const colors = normalizeBlankColors_(fields, sizes);
  const legacyColor = String((fields.color != null ? fields.color : (colors[0] && colors[0].color)) || "").slice(0, 80);
  const result = await db.prepare(
    `INSERT INTO blanks (name, productType, vendor, brand, sku, color, notes, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(fields.name        || "").slice(0, 200),
    String(fields.productType || "").slice(0, 40),
    String(fields.vendor      || "").slice(0, 100),
    String(fields.brand       || "").slice(0, 100),
    String(fields.sku         || "").slice(0, 100),
    legacyColor,
    String(fields.notes       || "").slice(0, 500),
    now, now
  ).run();
  const id = Number(result.meta.last_row_id);
  await setBlankNeedleType_(db, id, fields);
  await writeBlankColors_(db, id, colors, "create");
  return { id, createdAt: now };
}

export async function updateBlank(db, id, fields, sizes) {
  const now = new Date().toISOString();
  const hasColors = Array.isArray(fields.colors) || Array.isArray(sizes) || Array.isArray(fields.sizes);
  const colors = normalizeBlankColors_(fields, sizes);
  const legacyColor = String((fields.color != null ? fields.color : (colors[0] && colors[0].color)) || "").slice(0, 80);
  await db.prepare(
    `UPDATE blanks SET name=?, productType=?, vendor=?, brand=?, sku=?, color=?, notes=?, updatedAt=? WHERE id=?`
  ).bind(
    String(fields.name        || "").slice(0, 200),
    String(fields.productType || "").slice(0, 40),
    String(fields.vendor      || "").slice(0, 100),
    String(fields.brand       || "").slice(0, 100),
    String(fields.sku         || "").slice(0, 100),
    legacyColor,
    String(fields.notes       || "").slice(0, 500),
    now, Number(id)
  ).run();
  await setBlankNeedleType_(db, Number(id), fields);
  if (hasColors) await writeBlankColors_(db, Number(id), colors, "update");
}

// The blank's needle type (migrations/0044). Written only when the caller sends the field, so a
// caller that doesn't know about it (the PDF importer, merges, older scripts) can't clear it.
async function setBlankNeedleType_(db, id, fields) {
  if (!fields || fields.needleTypeId === undefined) return;
  const v = fields.needleTypeId == null || fields.needleTypeId === "" ? null : (Number(fields.needleTypeId) || null);
  await db.prepare("UPDATE blanks SET needleTypeId=? WHERE id=?").bind(v, Number(id)).run();
}

export async function deleteBlank(db, id) {
  await db.batch([
    db.prepare("DELETE FROM product_blank_links WHERE blankId=?").bind(Number(id)),
    db.prepare("DELETE FROM blank_sizes WHERE blankId=?").bind(Number(id)),
    db.prepare("DELETE FROM blank_colors WHERE blankId=?").bind(Number(id)),
    db.prepare("DELETE FROM blanks WHERE id=?").bind(Number(id)),
  ]);
}

// Folds several single-color (or multi-color) blanks into one (migrations/0037): separate
// "one blank per color" rows become the colors of a single style. Each source's movement history is
// re-pointed to the target (keeping color + size), its color catalog + links move over, and the
// target's stock/cost is recomputed from the combined history per (color, size) — so costs stay
// correct even when a color name appears on both. Sources are then deleted. Audited by the caller.
export async function mergeBlanks(db, { targetId, sourceIds }) {
  const target = Number(targetId);
  const sources = [...new Set((sourceIds || []).map(Number))].filter(id => id && id !== target);
  if (!target || !sources.length) return { merged: 0, targetId: target };
  const tname = await blankName_(db, target);
  for (const src of sources) {
    await db.prepare("UPDATE inventory_movements SET blankId=?, blankName=? WHERE blankId=?").bind(target, tname, src).run();
    const { results: tColors } = await db.prepare("SELECT color FROM blank_colors WHERE blankId=?").bind(target).all();
    const have = new Set(tColors.map(r => r.color || ""));
    let order = have.size;
    const { results: sColors } = await db.prepare("SELECT color, imagesJson FROM blank_colors WHERE blankId=?").bind(src).all();
    for (const c of sColors) {
      if (have.has(c.color || "")) continue;
      const now = new Date().toISOString();
      await db.prepare("INSERT INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(target, c.color || "", c.imagesJson || "[]", order++, now, now).run();
      have.add(c.color || "");
    }
    await db.prepare("UPDATE OR IGNORE product_blank_links SET blankId=? WHERE blankId=?").bind(target, src).run();
    await db.batch([
      db.prepare("DELETE FROM product_blank_links WHERE blankId=?").bind(src),
      db.prepare("DELETE FROM blank_sizes WHERE blankId=?").bind(src),
      db.prepare("DELETE FROM blank_colors WHERE blankId=?").bind(src),
      db.prepare("DELETE FROM blanks WHERE id=?").bind(src),
    ]);
  }
  const { results: keys } = await db.prepare("SELECT DISTINCT color, size FROM inventory_movements WHERE blankId=? AND voidedAt IS NULL").bind(target).all();
  for (const k of keys) await recomputeBlankSizeFromHistory_(db, target, k.color || "", k.size);
  return { merged: sources.length, targetId: target };
}

// ---- Thread catalog (migrations/0021) — global, shared across every shop --------
const parseThread_ = (r) => ({ id: Number(r.id), brand: r.brand || "", type: r.type || "", weight: r.weight || "",
  code: r.code || "", name: r.name || "", colorHex: r.colorHex || "", sourceFlag: r.sourceFlag || "", notes: r.notes || "",
  inventory: [] });

export async function listThreads(db) {
  const { results } = await db.prepare("SELECT * FROM threads ORDER BY brand, type, weight, code").all();
  const threads = results.map(parseThread_);
  // Attach each thread's inventory (spool size + quantity) in one grouped query. Wrapped so a
  // pre-migration DB (thread_inventory not yet created) just yields empty inventory rather than
  // breaking the whole catalog — same safe-no-op spirit as deleteThread's reference checks.
  let inv = [];
  try {
    inv = (await db.prepare(
      `SELECT ti.id, ti.threadId, ti.spoolSizeId, ti.quantity, ss.description AS spoolDescription, ss.meters AS spoolMeters
       FROM thread_inventory ti LEFT JOIN spool_sizes ss ON ss.id = ti.spoolSizeId ORDER BY ss.meters, ti.id`
    ).all()).results;
  } catch (e) { inv = []; }
  const byThread = new Map();
  for (const r of inv) {
    const tid = Number(r.threadId);
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid).push({ id: Number(r.id), spoolSizeId: r.spoolSizeId == null ? null : Number(r.spoolSizeId),
      quantity: Number(r.quantity) || 0, spoolDescription: r.spoolDescription || "",
      meters: r.spoolMeters == null ? null : Number(r.spoolMeters) });
  }
  for (const t of threads) t.inventory = byThread.get(t.id) || [];
  return threads;
}

// ---- Spool-size catalog + per-thread inventory (migrations/0028) -----------------
// spool_sizes is a small shared catalog (description + length in whole metres); thread_inventory
// is per-thread stock, each row a spool size and how many are on hand. Both global, like threads.
const parseSpoolSize_ = (r) => ({ id: Number(r.id), description: r.description || "", meters: Number(r.meters) || 0 });

export async function listSpoolSizes(db) {
  const { results } = await db.prepare("SELECT * FROM spool_sizes ORDER BY meters, description").all();
  return results.map(parseSpoolSize_);
}

export async function saveSpoolSize(db, fields) {
  const now = new Date().toISOString();
  const description = String(fields.description || "").slice(0, 100);
  const meters = Math.max(0, Math.floor(Number(fields.meters) || 0));
  if (fields.id) {
    await db.prepare("UPDATE spool_sizes SET description=?, meters=?, updatedAt=? WHERE id=?").bind(description, meters, now, Number(fields.id)).run();
    return Number(fields.id);
  }
  const r = await db.prepare("INSERT INTO spool_sizes (description, meters, createdAt, updatedAt) VALUES (?, ?, ?, ?)").bind(description, meters, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// Refused while any thread-inventory item still references this spool size — same
// reference-check pattern as deleteThread.
export async function deleteSpoolSize(db, id) {
  const n = Number(id);
  const used = await db.prepare("SELECT count(*) n FROM thread_inventory WHERE spoolSizeId=?").bind(n).first().catch(() => null);
  if (used && Number(used.n) > 0) throw new Error("This spool size is used by thread inventory — remove those items first");
  await db.prepare("DELETE FROM spool_sizes WHERE id=?").bind(n).run();
}

export async function saveThreadInventory(db, fields) {
  const now = new Date().toISOString();
  const spoolSizeId = fields.spoolSizeId != null && fields.spoolSizeId !== "" ? Number(fields.spoolSizeId) : null;
  const quantity = Math.max(0, Math.floor(Number(fields.quantity) || 0));
  if (fields.id) {
    await db.prepare("UPDATE thread_inventory SET spoolSizeId=?, quantity=?, updatedAt=? WHERE id=?").bind(spoolSizeId, quantity, now, Number(fields.id)).run();
    return Number(fields.id);
  }
  const threadId = Number(fields.threadId);
  const r = await db.prepare("INSERT INTO thread_inventory (threadId, spoolSizeId, quantity, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)").bind(threadId, spoolSizeId, quantity, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function deleteThreadInventory(db, id) {
  await db.prepare("DELETE FROM thread_inventory WHERE id=?").bind(Number(id)).run();
}

// ---- Needle settings (migrations/0044) — global ----------------------------------
// The needle Run Order recommends has two halves: its SIZE follows the thread (needle_sizes maps a
// thread weight to a needle size, e.g. 40 -> 75/11) and its TYPE follows the garment (needle_types,
// picked per blank as blanks.needleTypeId). Both lists are edited from Threads -> Needle settings.
// The two list readers return [] on a database that doesn't have the tables yet, so Run Order and
// Blanks keep working if the code is deployed a moment before the migration.
const missingNeedleTables_ = (e) => /no such (table|column)/i.test(String(e && e.message));

// One spelling per weight, so "40", "40wt" and "40 WT" are the same row and match threads.weight.
export function normThreadWeight(w) {
  return String(w == null ? "" : w).trim().toLowerCase().replace(/\s*(wt|weight)\.?$/, "").trim().slice(0, 20);
}

export async function listNeedleSizes(db) {
  let rows;
  try { rows = (await db.prepare("SELECT weight, needleSize FROM needle_sizes").all()).results; }
  catch (e) { if (missingNeedleTables_(e)) return []; throw e; }
  // Numeric weights in order (40 before 60 before 120), anything else after, alphabetically.
  const num = (w) => (/^\d+(\.\d+)?$/.test(w) ? Number(w) : Infinity);
  return rows.map(r => ({ weight: r.weight || "", needleSize: r.needleSize || "" }))
    .sort((a, b) => (num(a.weight) - num(b.weight)) || a.weight.localeCompare(b.weight));
}

// Upsert by weight: saving a weight that already has a size just changes the size.
export async function saveNeedleSize(db, fields) {
  const weight = normThreadWeight(fields && fields.weight);
  const needleSize = String((fields && fields.needleSize) || "").trim().slice(0, 20);
  if (!weight) throw new Error("Thread weight is required");
  if (!needleSize) throw new Error("Needle size is required");
  const now = new Date().toISOString();
  await db.prepare(
    "INSERT INTO needle_sizes (weight, needleSize, createdAt, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(weight) DO UPDATE SET needleSize=excluded.needleSize, updatedAt=excluded.updatedAt"
  ).bind(weight, needleSize, now, now).run();
  return weight;
}

export async function deleteNeedleSize(db, weight) {
  await db.prepare("DELETE FROM needle_sizes WHERE weight=?").bind(normThreadWeight(weight)).run();
}

// Each type carries how many blanks use it, so the settings window can say why one can't be deleted.
export async function listNeedleTypes(db) {
  try {
    const { results } = await db.prepare(
      `SELECT t.id, t.name, t.sortOrder, (SELECT count(*) FROM blanks b WHERE b.needleTypeId = t.id) AS blankCount
       FROM needle_types t ORDER BY t.sortOrder, t.name`).all();
    return results.map(r => ({ id: Number(r.id), name: r.name || "", sortOrder: Number(r.sortOrder) || 0, blankCount: Number(r.blankCount) || 0 }));
  } catch (e) { if (missingNeedleTables_(e)) return []; throw e; }
}

export async function saveNeedleType(db, fields) {
  const name = String((fields && fields.name) || "").trim().slice(0, 60);
  if (!name) throw new Error("Needle type name is required");
  const now = new Date().toISOString();
  try {
    if (fields.id) {
      await db.prepare("UPDATE needle_types SET name=?, updatedAt=? WHERE id=?").bind(name, now, Number(fields.id)).run();
      return Number(fields.id);
    }
    const next = await db.prepare("SELECT COALESCE(MAX(sortOrder), 0) + 1 AS n FROM needle_types").first();
    const r = await db.prepare("INSERT INTO needle_types (name, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
      .bind(name, Number(next && next.n) || 1, now, now).run();
    return Number(r.meta && r.meta.last_row_id) || 0;
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw new Error(`There is already a needle type called "${name}"`);
    throw e;
  }
}

// Refused while any blank still uses the type — same reference-check pattern as deleteSpoolSize.
export async function deleteNeedleType(db, id) {
  const n = Number(id);
  const used = await db.prepare("SELECT count(*) n FROM blanks WHERE needleTypeId=?").bind(n).first();
  const count = Number(used && used.n) || 0;
  if (count > 0) throw new Error(`This needle type is set on ${count} blank${count === 1 ? "" : "s"} — change ${count === 1 ? "it" : "them"} first`);
  await db.prepare("DELETE FROM needle_types WHERE id=?").bind(n).run();
}

export async function needleTypeExists(db, id) {
  const row = await db.prepare("SELECT 1 AS ok FROM needle_types WHERE id=?").bind(Number(id)).first();
  return !!row;
}

export async function createThread(db, fields) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO threads (brand, type, weight, code, name, colorHex, sourceFlag, notes, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(String(fields.brand || "").slice(0, 100), String(fields.type || "").slice(0, 100), String(fields.weight || "").slice(0, 20),
    String(fields.code || "").slice(0, 40), String(fields.name || "").slice(0, 200), String(fields.colorHex || "").slice(0, 6).toLowerCase(),
    String(fields.sourceFlag || "").slice(0, 20), String(fields.notes || "").slice(0, 500), now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateThread(db, id, fields) {
  await db.prepare(
    `UPDATE threads SET brand=?, type=?, weight=?, code=?, name=?, colorHex=?, sourceFlag=?, notes=?, updatedAt=? WHERE id=?`
  ).bind(String(fields.brand || "").slice(0, 100), String(fields.type || "").slice(0, 100), String(fields.weight || "").slice(0, 20),
    String(fields.code || "").slice(0, 40), String(fields.name || "").slice(0, 200), String(fields.colorHex || "").slice(0, 6).toLowerCase(),
    String(fields.sourceFlag || "").slice(0, 20), String(fields.notes || "").slice(0, 500), new Date().toISOString(), Number(id)).run();
}

// Refused while any design version's thread-color map, or any machine needle, still points at
// this thread — same reference-check pattern as deleteExpenseCategory. Both referencing tables
// exist since migrations/0024 (design_versions) and 0025 (machine_needles).
export async function deleteThread(db, id) {
  const n = Number(id);
  const usedByDesign = await db.prepare(
    "SELECT count(*) n FROM design_versions dv, json_each(dv.threadColorsJson) je WHERE json_extract(je.value, '$.threadId') = ?"
  ).bind(n).first().catch(() => null);
  if (usedByDesign && Number(usedByDesign.n) > 0) throw new Error("This thread is used in a design's color map — remove it there first");
  const usedByMachine = await db.prepare("SELECT count(*) n FROM machine_needles WHERE threadId=?").bind(n).first().catch(() => null);
  if (usedByMachine && Number(usedByMachine.n) > 0) throw new Error("This thread is currently loaded on a machine — clear that needle first");
  await db.prepare("DELETE FROM threads WHERE id=?").bind(n).run();
}

// Imports already-parsed chart rows (see parseHatchChart_ in admin.js), upserting on
// (brand, type, weight, code) so re-importing the same chart just refreshes names/colors rather
// than duplicating rows -- a code alone isn't unique across a brand's different lines (e.g.
// Madeira PolyNeon 40 code 1538 vs. Madeira Rayon 40 code 1538 are different threads).
export async function importThreadChart(db, rows) {
  const now = new Date().toISOString();
  let created = 0, updated = 0;
  for (const row of rows) {
    const brand = String(row.brand || "").slice(0, 100), code = String(row.code || "").slice(0, 40);
    const type = String(row.type || "").slice(0, 100), weight = String(row.weight || "").slice(0, 20);
    if (!brand || !code) continue;
    const existing = await db.prepare("SELECT id FROM threads WHERE brand=? AND type=? AND weight=? AND code=?").bind(brand, type, weight, code).first();
    const fields = { brand, type: row.type, weight: row.weight, code, name: row.name, colorHex: row.colorHex, sourceFlag: row.sourceFlag, notes: "" };
    if (existing) { await updateThread(db, existing.id, fields); updated++; }
    else { await createThread(db, fields); created++; }
  }
  return { created, updated };
}

// ---- Hoop catalog (migrations/0022) — global, shared across every shop ----------
const parseHoop_ = (r) => ({ id: Number(r.id), name: r.name || "", widthMm: r.widthMm == null ? null : Number(r.widthMm),
  heightMm: r.heightMm == null ? null : Number(r.heightMm), isCapFrame: !!r.isCapFrame, notes: r.notes || "", sortOrder: Number(r.sortOrder) || 0 });

export async function listHoops(db) {
  const { results } = await db.prepare("SELECT * FROM hoops ORDER BY sortOrder, name").all();
  return results.map(parseHoop_);
}

export async function createHoop(db, fields) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO hoops (name, widthMm, heightMm, isCapFrame, notes, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(String(fields.name || "").slice(0, 100), fields.widthMm != null && fields.widthMm !== "" ? Number(fields.widthMm) : null,
    fields.heightMm != null && fields.heightMm !== "" ? Number(fields.heightMm) : null, fields.isCapFrame ? 1 : 0,
    String(fields.notes || "").slice(0, 500), Number(fields.sortOrder) || 0, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateHoop(db, id, fields) {
  await db.prepare(
    `UPDATE hoops SET name=?, widthMm=?, heightMm=?, isCapFrame=?, notes=?, sortOrder=?, updatedAt=? WHERE id=?`
  ).bind(String(fields.name || "").slice(0, 100), fields.widthMm != null && fields.widthMm !== "" ? Number(fields.widthMm) : null,
    fields.heightMm != null && fields.heightMm !== "" ? Number(fields.heightMm) : null, fields.isCapFrame ? 1 : 0,
    String(fields.notes || "").slice(0, 500), Number(fields.sortOrder) || 0, new Date().toISOString(), Number(id)).run();
}

// Refused while any design or machine still references this hoop — same reference-check
// pattern as deleteThread. Both referencing tables exist since migrations/0024 (designs) and
// 0025 (machine_hoops).
export async function deleteHoop(db, id) {
  const n = Number(id);
  const usedByDesign = await db.prepare("SELECT count(*) n FROM designs WHERE hoopId=?").bind(n).first().catch(() => null);
  if (usedByDesign && Number(usedByDesign.n) > 0) throw new Error("This hoop is required by a design — change that design's hoop first");
  const usedByDesignHoops = await db.prepare(
    "SELECT (SELECT count(*) FROM design_hoops WHERE hoopId=?1) + (SELECT count(*) FROM products WHERE personalizationHoopId=?1) AS n"
  ).bind(n).first().catch(() => null);
  if (usedByDesignHoops && Number(usedByDesignHoops.n) > 0) throw new Error("This hoop is one of a design's hoops (or a product's personalization hoop) — change that first");
  const usedByMachine = await db.prepare("SELECT count(*) n FROM machine_hoops WHERE hoopId=?").bind(n).first().catch(() => null);
  if (usedByMachine && Number(usedByMachine.n) > 0) throw new Error("This hoop is set up on a machine — remove it there first");
  const isCurrentOnMachine = await db.prepare("SELECT count(*) n FROM machines WHERE currentHoopId=?").bind(n).first().catch(() => null);
  if (isCurrentOnMachine && Number(isCurrentOnMachine.n) > 0) throw new Error("A machine currently has this hoop mounted — change that first");
  await db.prepare("DELETE FROM hoops WHERE id=?").bind(n).run();
}

// ---- Locations (migrations/0041) — global garment-location lookup -----------------
// A shared list (Front/Back/Left Chest/Right Chest, admin-editable) that configurable products'
// design-option locations and blank color-image tags reference by id. Global, like hoops/threads.
const parseLocation_ = (r) => ({ id: Number(r.id), name: r.name || "", notes: r.notes || "", sortOrder: Number(r.sortOrder) || 0 });

export async function listLocations(db) {
  const { results } = await db.prepare("SELECT * FROM locations ORDER BY sortOrder, name").all();
  return results.map(parseLocation_);
}

// One upsert (create when no id, else update) — matches the saveSpoolSize style.
export async function saveLocation(db, fields) {
  const now = new Date().toISOString();
  const name = String(fields.name || "").slice(0, 100);
  const notes = String(fields.notes || "").slice(0, 500);
  const sortOrder = Number(fields.sortOrder) || 0;
  if (fields.id) {
    await db.prepare("UPDATE locations SET name=?, notes=?, sortOrder=?, updatedAt=? WHERE id=?")
      .bind(name, notes, sortOrder, now, Number(fields.id)).run();
    return Number(fields.id);
  }
  const r = await db.prepare("INSERT INTO locations (name, notes, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
    .bind(name, notes, sortOrder, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// Refused while any configurable product's locationsJson, or any blank color image, references it —
// the json_each/json_extract reference-check pattern from deleteThread. Each probe .catch()es a
// pre-migration DB (table absent) to null, i.e. a safe no-op.
export async function deleteLocation(db, id) {
  const n = Number(id);
  const usedByProduct = await db.prepare(
    "SELECT count(*) n FROM products p, json_each(p.locationsJson) je WHERE json_extract(je.value, '$.locationId') = ?"
  ).bind(n).first().catch(() => null);
  if (usedByProduct && Number(usedByProduct.n) > 0) throw new Error("This location is used by a product's design options — change that product first");
  const usedByBlankImage = await db.prepare(
    "SELECT count(*) n FROM blank_colors bc, json_each(bc.imagesJson) je WHERE json_extract(je.value, '$.locationId') = ?"
  ).bind(n).first().catch(() => null);
  if (usedByBlankImage && Number(usedByBlankImage.n) > 0) throw new Error("This location tags a blank color image — remove that tag first");
  await db.prepare("DELETE FROM locations WHERE id=?").bind(n).run();
}

// ---- Designs (migrations/0024) — per-org, one design per product ----------------
// designs = the product-facing record (name/notes/stabilizer/required hoop);
// design_versions = an append-only file history, the "current" version being just the newest row.
// hoopIds = the hoops the design runs in on its own; personalizationHoopIds = the hoops for the
// design WITH a typed-in name in the same hooping (migrations/0032, design_hoops). hoopId (the
// first design hoop) is kept for older readers.
const parseDesign_ = (r, hoops) => ({ id: Number(r.id), orgId: r.orgId, isGlobal: !!Number(r.isGlobal), name: r.name || "", notes: r.notes || "",
  stabilizer: r.stabilizer || "", hoopId: r.hoopId == null ? null : Number(r.hoopId),
  hoopIds: (hoops && hoops.design) || (r.hoopId == null ? [] : [Number(r.hoopId)]),
  personalizationHoopIds: (hoops && hoops.personalization) || [] });

// {designId: {design: [hoopId…], personalization: [hoopId…]}} for the designs matched by `where`.
async function designHoopsBy_(db, where, binds) {
  const out = {};
  try {
    const { results } = await db.prepare(
      `SELECT designId, hoopId, purpose FROM design_hoops WHERE designId IN (SELECT id FROM designs WHERE ${where}) ORDER BY sortOrder, hoopId`
    ).bind(...binds).all();
    for (const r of results) {
      const o = out[r.designId] = out[r.designId] || { design: [], personalization: [] };
      o[r.purpose === "personalization" ? "personalization" : "design"].push(Number(r.hoopId));
    }
  } catch (e) { /* pre-0032 database: fall back to designs.hoopId */ }
  return out;
}

// A shop's designs plus every GLOBAL design (migrations/0033 — usable by all shops, e.g. shared
// closure designs), the shop's own first.
export async function listDesigns(db, orgId) {
  let results, where = "orgId=? OR isGlobal=1";
  try { ({ results } = await db.prepare(`SELECT * FROM designs WHERE ${where} ORDER BY isGlobal, name`).bind(orgId).all()); }
  catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    where = "orgId=?"; ({ results } = await db.prepare("SELECT * FROM designs WHERE orgId=? ORDER BY name").bind(orgId).all());
  }
  const hoops = await designHoopsBy_(db, where, [orgId]);
  return results.map(r => parseDesign_(r, hoops[r.id]));
}

// Shops other than the design's home whose products use it (as one of their designs, their main
// design, or a pick-list option) — a global design can't be made shop-only while any do.
async function designUsedByOtherShops_(db, id, homeOrgId) {
  const r = await db.prepare(
    `SELECT (SELECT count(*) FROM product_designs WHERE designId=?1 AND orgId<>?2) +
            (SELECT count(*) FROM products WHERE designId=?1 AND orgId<>?2) +
            (SELECT count(*) FROM products p, json_each(CASE WHEN json_valid(p.personalizationOptionDesigns) THEN p.personalizationOptionDesigns ELSE '{}' END) j
              WHERE j.value = ?1 AND p.orgId<>?2) AS n`).bind(Number(id), homeOrgId).first();
  return Number(r && r.n) || 0;
}

export async function getDesign(db, id) {
  const row = await db.prepare("SELECT * FROM designs WHERE id=?").bind(Number(id)).first();
  if (!row) return null;
  const hoops = await designHoopsBy_(db, "id=?", [Number(id)]);
  return parseDesign_(row, hoops[row.id]);
}

export async function saveDesign(db, orgId, fields) {
  const now = new Date().toISOString();
  const name = String(fields.name || "").slice(0, 200), notes = String(fields.notes || "").slice(0, 2000);
  const stabilizer = String(fields.stabilizer || "").slice(0, 200);
  // hoopIds / personalizationHoopIds (migrations/0032); a lone legacy hoopId means [hoopId].
  const ids = (a) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(Boolean))];
  const hoopIds = Array.isArray(fields.hoopIds) ? ids(fields.hoopIds)
    : (fields.hoopId != null && fields.hoopId !== "" ? [Number(fields.hoopId)] : []);
  const persHoopIds = Array.isArray(fields.personalizationHoopIds) ? ids(fields.personalizationHoopIds) : null;
  const hoopId = hoopIds[0] || null;
  let id;
  if (fields.id) {
    // A shop can edit its own designs and any GLOBAL design (one edit updates it for every shop).
    const cur = await db.prepare("SELECT * FROM designs WHERE id=?").bind(Number(fields.id)).first();
    if (!cur || (cur.orgId !== orgId && !Number(cur.isGlobal))) throw new Error("Design not found");
    let isGlobal = Number(cur.isGlobal) ? 1 : 0;
    if (fields.isGlobal !== undefined && cur.isGlobal !== undefined) {
      isGlobal = fields.isGlobal ? 1 : 0;
      if (!isGlobal && Number(cur.isGlobal) && await designUsedByOtherShops_(db, cur.id, cur.orgId))
        throw new Error("Other shops' products use this global design — remove it there before making it shop-only");
    }
    await db.prepare(`UPDATE designs SET name=?, notes=?, stabilizer=?, hoopId=?, updatedAt=?${cur.isGlobal !== undefined ? ", isGlobal=?" : ""} WHERE id=?`)
      .bind(...[name, notes, stabilizer, hoopId, now].concat(cur.isGlobal !== undefined ? [isGlobal] : []), Number(fields.id)).run();
    id = Number(fields.id);
  } else {
    const r = await db.prepare("INSERT INTO designs (orgId, name, notes, stabilizer, hoopId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(orgId, name, notes, stabilizer, hoopId, now, now).run();
    id = Number(r.meta && r.meta.last_row_id) || 0;
    if (fields.isGlobal) await db.prepare("UPDATE designs SET isGlobal=1 WHERE id=?").bind(id).run().catch(() => {});
  }
  try {
    const keepPers = persHoopIds === null
      ? (await designHoopsBy_(db, "id=?", [id]))[id]?.personalization || [] : persHoopIds;
    await db.batch([
      db.prepare("DELETE FROM design_hoops WHERE designId=?").bind(id),
      ...hoopIds.map((h, i) => db.prepare("INSERT INTO design_hoops (designId, hoopId, purpose, sortOrder) VALUES (?, ?, 'design', ?)").bind(id, h, i)),
      ...keepPers.map((h, i) => db.prepare("INSERT INTO design_hoops (designId, hoopId, purpose, sortOrder) VALUES (?, ?, 'personalization', ?)").bind(id, h, i)),
    ]);
  } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  return id;
}

// Refused while any product still links to this design — never a hard delete of production
// history, same spirit as blank/thread/hoop deletion refusing while referenced.
export async function deleteDesign(db, id) {
  const n = Number(id);
  const used = await db.prepare("SELECT count(*) n FROM products WHERE designId=?").bind(n).first();
  if (used && Number(used.n) > 0) throw new Error("A product is still linked to this design — unlink it first");
  const usedAgain = await db.prepare(
    `SELECT (SELECT count(*) FROM product_designs WHERE designId=?1) +
            (SELECT count(*) FROM products p, json_each(CASE WHEN json_valid(p.personalizationOptionDesigns) THEN p.personalizationOptionDesigns ELSE '{}' END) j WHERE j.value = ?1) AS n`
  ).bind(n).first().catch(() => null);
  if (usedAgain && Number(usedAgain.n) > 0) throw new Error("A product still uses this design (as one of its designs or for a pick-list option) — remove it there first");
  await db.prepare("DELETE FROM designs WHERE id=?").bind(n).run();
}

// Two required files per version (migrations/0026): designFile (native, editable — .emb/.jdx/
// etc) and machineFile (the actual stitch file a machine runs — .dst/.exp/etc; what "Send design
// to machine" hands to the local send-agent).
const parseDesignVersion_ = (r) => ({ id: Number(r.id), designId: Number(r.designId),
  designFileKey: r.designFileKey || "", designFileName: r.designFileName || "", designFileExt: r.designFileExt || "",
  machineFileKey: r.machineFileKey || "", machineFileName: r.machineFileName || "", machineFileExt: r.machineFileExt || "",
  threadColors: tryParse_(r.threadColorsJson, []), notes: r.notes || "", uploadedAt: r.uploadedAt });

export async function listDesignVersions(db, designId) {
  const { results } = await db.prepare("SELECT * FROM design_versions WHERE designId=? ORDER BY uploadedAt DESC, id DESC").bind(Number(designId)).all();
  return results.map(parseDesignVersion_);
}

export async function addDesignVersion(db, designId, fields) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO design_versions (designId, designFileKey, designFileName, designFileExt, machineFileKey, machineFileName, machineFileExt, threadColorsJson, notes, uploadedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(Number(designId), String(fields.designFileKey || ""), String(fields.designFileName || "").slice(0, 200),
    String(fields.designFileExt || "").slice(0, 10), String(fields.machineFileKey || ""), String(fields.machineFileName || "").slice(0, 200),
    String(fields.machineFileExt || "").slice(0, 10), JSON.stringify(fields.threadColors || []),
    String(fields.notes || "").slice(0, 2000), fields.uploadedAt || now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// Update ONLY the thread-color map of an existing version (colors can be corrected on any
// version; the files and everything else stay untouched).
export async function updateDesignVersionThreads(db, versionId, threadColors) {
  await db.prepare("UPDATE design_versions SET threadColorsJson=? WHERE id=?")
    .bind(JSON.stringify(threadColors || []), Number(versionId)).run();
}

function parseOrderItemFile_(r) {
  return { id: Number(r.id), itemId: Number(r.itemId), fileKey: r.fileKey || "", fileName: r.fileName || "",
    fileExt: r.fileExt || "", uploadedBy: r.uploadedBy || "admin", createdAt: r.createdAt };
}

export async function getOrderItemFiles(db, itemId) {
  const { results } = await db.prepare("SELECT * FROM order_item_files WHERE itemId=? ORDER BY createdAt").bind(Number(itemId)).all();
  return results.map(parseOrderItemFile_);
}

export async function addOrderItemFile(db, itemId, fields) {
  const r = await db.prepare(
    `INSERT INTO order_item_files (itemId, fileKey, fileName, fileExt, uploadedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(Number(itemId), String(fields.fileKey || ""), String(fields.fileName || "").slice(0, 200),
    String(fields.fileExt || "").slice(0, 10), fields.uploadedBy === "customer" ? "customer" : "admin", new Date().toISOString()).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function deleteOrderItemFile(db, id) {
  await db.prepare("DELETE FROM order_item_files WHERE id=?").bind(Number(id)).run();
}

// ---- Order-specific designs (migrations/0032) ----------------------------------------------
// A line with typed-in personalization needs its own digitized design (the name alone, or the main
// design + the name) — stitch file + optional native file + thread map, newest upload wins.
const parseOrderItemDesign_ = (r) => ({ id: Number(r.id), itemId: Number(r.itemId),
  designFileKey: r.designFileKey || "", designFileName: r.designFileName || "", designFileExt: r.designFileExt || "",
  machineFileKey: r.machineFileKey || "", machineFileName: r.machineFileName || "", machineFileExt: r.machineFileExt || "",
  threadColors: tryParse_(r.threadColorsJson, []), notes: r.notes || "", uploadedAt: r.uploadedAt, location: r.location || "" });

export async function listOrderItemDesigns(db, itemId) {
  const { results } = await db.prepare("SELECT * FROM order_item_designs WHERE itemId=? ORDER BY uploadedAt DESC, id DESC").bind(Number(itemId)).all();
  return results.map(parseOrderItemDesign_);
}

// `fields.location` (migrations/0055): which location of the line it's for — '' (the default) is the
// line's one design.
export async function addOrderItemDesign(db, itemId, fields) {
  const now = new Date().toISOString();
  const location = String(fields.location || "").slice(0, 60);
  const r = await db.prepare(
    `INSERT INTO order_item_designs (itemId, designFileKey, designFileName, designFileExt, machineFileKey, machineFileName, machineFileExt, threadColorsJson, notes, uploadedAt, createdAt${location ? ", location" : ""})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${location ? ", ?" : ""})`
  ).bind(Number(itemId), String(fields.designFileKey || ""), String(fields.designFileName || "").slice(0, 200),
    String(fields.designFileExt || "").slice(0, 10), String(fields.machineFileKey || ""), String(fields.machineFileName || "").slice(0, 200),
    String(fields.machineFileExt || "").slice(0, 10), JSON.stringify(fields.threadColors || []),
    String(fields.notes || "").slice(0, 2000), now, now, ...(location ? [location] : [])).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// Does order_item_designs have its `location` column (migrations/0055)? Cached per database.
async function orderItemDesignsHasLocation_(db) {
  if (db.__oidHasLocation === undefined) {
    try { const { results } = await db.prepare("PRAGMA table_info(order_item_designs)").all(); db.__oidHasLocation = results.some(c => c.name === "location"); }
    catch (e) { db.__oidHasLocation = false; }
  }
  return db.__oidHasLocation;
}

// The order designs a line still needs and doesn't have (stagePrereqError, the order lists): one for
// each location carrying the customer's own stitched design, and one ('') for typed-in text — unless
// the line is an ordinary product made from the customer's design, whose one design has the name in
// it too. `have` = the locations it has designs for. A line from before migrations/0055 with a single
// custom spot counts its '' design for it.
function orderDesignsMissingOnLine_(line, have) {
  const cfg = tryParse_(line.configJson, null);
  const customs = (cfg && Array.isArray(cfg.locations) ? cfg.locations : []).filter(l => l && l.custom && l.kind === "embroidery");
  const options = tryParse_(line.personalizationOptions, []) || [];
  const freeText = Number(line.personalized) === 1 && !options.includes(line.persName);
  let n = 0;
  for (const l of customs) if (!have.has(String(l.location)) && !(customs.length === 1 && have.has(""))) n++;
  if (freeText && !(cfg && cfg.plain && customs.length) && !have.has("")) n++;
  return n;
}

// ---- Machines (migrations/0025) — global catalog + each machine's LIVE state --------
// machines = the catalog row (name, needle count, IP/EMB dir for the local send-agent, current
// hoop); machine_hoops = which hoops it supports; machine_needles = what thread is physically
// loaded on each needle RIGHT NOW — kept up to date by hand on the Machines screen.
function parseMachine_(row, hoopIds, needles) {
  return { id: Number(row.id), name: row.name || "", needleCount: Number(row.needleCount) || 1,
    ipAddress: row.ipAddress || "", embDir: row.embDir || "/EMB",
    macAddress: row.macAddress || "", verifiedAt: row.verifiedAt || "",
    currentHoopId: row.currentHoopId == null ? null : Number(row.currentHoopId),
    notes: row.notes || "", hoopIds: hoopIds || [], needles: needles || {} };
}

// The MAC is the machine's stable identity; normalize for comparison (lowercase, no separators)
// so "AA:BB:CC:00:11:22", "aa-bb-cc-00-11-22" and "aabbcc001122" all match.
export function normalizeMac_(mac) {
  return String(mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

async function machineHoopsAndNeedles_(db, machineId) {
  const [{ results: hoopRows }, { results: needleRows }] = await Promise.all([
    db.prepare("SELECT hoopId FROM machine_hoops WHERE machineId=?").bind(machineId).all(),
    db.prepare("SELECT needle, threadId FROM machine_needles WHERE machineId=? ORDER BY needle").bind(machineId).all(),
  ]);
  const needles = {};
  for (const r of needleRows) needles[Number(r.needle)] = r.threadId == null ? null : Number(r.threadId);
  return { hoopIds: hoopRows.map(r => Number(r.hoopId)), needles };
}

export async function listMachines(db) {
  const { results } = await db.prepare("SELECT * FROM machines ORDER BY name").all();
  return Promise.all(results.map(async (row) => {
    const { hoopIds, needles } = await machineHoopsAndNeedles_(db, row.id);
    return parseMachine_(row, hoopIds, needles);
  }));
}

export async function getMachine(db, id) {
  const row = await db.prepare("SELECT * FROM machines WHERE id=?").bind(Number(id)).first();
  if (!row) return null;
  const { hoopIds, needles } = await machineHoopsAndNeedles_(db, row.id);
  return parseMachine_(row, hoopIds, needles);
}

// hoopIds (if an array) fully replaces the machine's supported-hoop set — same
// replace-on-save pattern updateBlank uses for sizes.
export async function saveMachine(db, fields) {
  const now = new Date().toISOString();
  const name = String(fields.name || "").slice(0, 200), ipAddress = String(fields.ipAddress || "").slice(0, 100);
  const embDir = String(fields.embDir || "/EMB").slice(0, 200), notes = String(fields.notes || "").slice(0, 500);
  const macAddress = String(fields.macAddress || "").slice(0, 100);
  const needleCount = Math.max(1, Math.floor(Number(fields.needleCount) || 1));
  const currentHoopId = fields.currentHoopId != null && fields.currentHoopId !== "" ? Number(fields.currentHoopId) : null;
  let id;
  if (fields.id) {
    id = Number(fields.id);
    await db.prepare("UPDATE machines SET name=?, needleCount=?, ipAddress=?, embDir=?, macAddress=?, currentHoopId=?, notes=?, updatedAt=? WHERE id=?")
      .bind(name, needleCount, ipAddress, embDir, macAddress, currentHoopId, notes, now, id).run();
  } else {
    const r = await db.prepare("INSERT INTO machines (name, needleCount, ipAddress, embDir, macAddress, currentHoopId, notes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(name, needleCount, ipAddress, embDir, macAddress, currentHoopId, notes, now, now).run();
    id = Number(r.meta && r.meta.last_row_id) || 0;
  }
  if (Array.isArray(fields.hoopIds)) {
    await db.prepare("DELETE FROM machine_hoops WHERE machineId=?").bind(id).run();
    const hoopIds = [...new Set(fields.hoopIds.map(Number).filter(Boolean))];
    if (hoopIds.length) await db.batch(hoopIds.map(hoopId => db.prepare("INSERT INTO machine_hoops (machineId, hoopId) VALUES (?, ?)").bind(id, hoopId)));
  }
  return id;
}

export async function deleteMachine(db, id) {
  await db.prepare("DELETE FROM machines WHERE id=?").bind(Number(id)).run();
}

// Records a discovery sweep's results against the stored machines: for every discovered
// {mac, ip}, the machine whose macAddress matches (by normalized MAC) gets its ipAddress
// refreshed and verifiedAt stamped to now — so the scanner, not a human, keeps each machine's IP
// current, and freshness (>1h since verifiedAt) drives auto-rediscovery before a list/upload.
// Returns { updated: [ids...] } so the caller knows which records changed.
export async function recordMachineDiscovery(db, discovered) {
  const now = new Date().toISOString();
  const list = Array.isArray(discovered) ? discovered : [];
  const { results } = await db.prepare("SELECT id, macAddress FROM machines").all();
  const byMac = new Map();
  for (const row of results) { const key = normalizeMac_(row.macAddress); if (key) byMac.set(key, Number(row.id)); }
  const updated = [];
  for (const d of list) {
    const key = normalizeMac_(d && d.mac);
    const ip = String((d && d.ip) || "").slice(0, 100);
    if (!key || !ip || !byMac.has(key)) continue;
    const id = byMac.get(key);
    await db.prepare("UPDATE machines SET ipAddress=?, verifiedAt=?, updatedAt=? WHERE id=?").bind(ip, now, now, id).run();
    updated.push(id);
  }
  return { updated };
}

// Just updates currentHoopId — the "cost" of a hoop change is computed client-side,
// not stored.
export async function setMachineHoop(db, machineId, hoopId) {
  await db.prepare("UPDATE machines SET currentHoopId=?, updatedAt=? WHERE id=?")
    .bind(hoopId == null || hoopId === "" ? null : Number(hoopId), new Date().toISOString(), Number(machineId)).run();
}

// Bulk-sets every needle from `assignments` ([{needle, threadId}, ...] — e.g. a design's
// threadColorsJson), replacing whatever was there needle-by-needle. A needle not present in
// `assignments` is left alone (this sets what a design NEEDS, not necessarily every needle on
// the machine — a wider machine can have needles beyond what one design uses).
export async function setMachineNeedles(db, machineId, assignments) {
  const now = new Date().toISOString();
  const id = Number(machineId);
  const rows = (assignments || []).filter(a => a && a.needle);
  if (!rows.length) return;
  await db.batch(rows.map(a => db.prepare(
    "INSERT INTO machine_needles (machineId, needle, threadId, updatedAt) VALUES (?, ?, ?, ?) ON CONFLICT(machineId, needle) DO UPDATE SET threadId=excluded.threadId, updatedAt=excluded.updatedAt"
  ).bind(id, Number(a.needle), a.threadId == null || a.threadId === "" ? null : Number(a.threadId), now)));
}

// A single needle's thread, corrected by hand (e.g. after a manual re-thread outside a run).
export async function setMachineNeedle(db, machineId, needle, threadId) {
  await setMachineNeedles(db, machineId, [{ needle, threadId }]);
}

// ---- Production queue — cross-org, no orgId filter ----------------------
// Every active line item whose order is exactly one manufacture away: paid, real, blanks
// received, design approved, not yet manufactured — the same prerequisite the "manufactured"
// fulfillment-stage button already enforces (FULFILLMENT_STAGES in admin.js), just evaluated
// across every org at once instead of one order at a time.
function parseQueueRow_(r) {
  return {
    itemId: Number(r.itemId), orderId: r.orderId, orgId: r.orgId, orgName: r.orgName || r.orgId,
    customerName: r.customerName, qty: Number(r.qty) || 1,
    manufacturedQty: Math.max(0, Number(r.manufacturedQty) || 0),
    remaining: Math.max(0, (Number(r.qty) || 1) - Math.max(0, Number(r.manufacturedQty) || 0)),
    productId: r.productId,
    itemName: r.itemName, itemSize: r.itemSize || "", activeItemCount: Number(r.activeItemCount) || 1,
    placedAt: r.placedAt, dueDate: r.dueDate || "",
    blank: r.blankId == null ? null : { id: Number(r.blankId), name: r.blankName || "", brand: r.blankBrand || "",
      color: r.blankColor || "", productType: r.blankProductType || "", size: r.blankSize || "" },
    design: r.designId == null ? null : { id: Number(r.designId), name: r.designName || "", stabilizer: r.stabilizer || "",
      hoopId: r.hoopId == null ? null : Number(r.hoopId), hoopName: r.hoopName || "",
      threadColors: tryParse_(r.threadColorsJson, []),
      machineFileKey: r.machineFileKey || "", machineFileName: r.machineFileName || "" },
  };
}

// An order needs the customer to approve its design only when an active line carries FREE-FORM
// personalization text — a name the customer typed. Nothing personalized, or text that is one of
// the product's preset personalization options (the storefront stores the chosen option verbatim),
// skips approval: for those orders Mark manufactured needs digitizing done instead. A personalized
// line with no matching product (a custom local-sale line) counts as free-form. One SQL expression
// over an order row aliased `o`, shared by the order loaders (→ order.needsDesignApproval), the
// server's stage checks (stagePrereqError) and the Run Order queue.
const FREE_FORM_TEXT_SQL_ = `EXISTS (SELECT 1 FROM order_items ax
    LEFT JOIN products px ON px.orgId = ax.orgId AND px.productId = ax.productId
    WHERE ax.orderId = o.orderId AND ax.cancelDate IS NULL AND ax.personalized = 1
      AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(px.personalizationOptions) THEN px.personalizationOptions ELSE '[]' END) jx
                      WHERE jx.value = ax.persName))`;
// With the Design approval feature off (FEATURES), no order needs approval.
const NEEDS_DESIGN_APPROVAL_SQL_ = `(${featureOnSql_("designVerification")} AND ${FREE_FORM_TEXT_SQL_})`;

// Digitizing is needed when the order has free-form personalization text (the typed name has to be
// digitized), or some active line's product has no design linked (products.designId), or a line has
// no product at all (a custom local-sale line). Only when every product already has a design AND
// nothing is typed in is the "digitizing complete" step skipped. Feeds order.needsDigitizing,
// stagePrereqError and getProductionQueue.
// With the Production feature off there are no designs to link, so the step isn't asked for at all.
const NEEDS_DIGITIZING_SQL_ = `(${featureOnSql_("production")} AND (${FREE_FORM_TEXT_SQL_} OR EXISTS (SELECT 1 FROM order_items dx
    LEFT JOIN products pdx ON pdx.orgId = dx.orgId AND pdx.productId = dx.productId
    WHERE dx.orderId = o.orderId AND dx.cancelDate IS NULL AND pdx.designId IS NULL)))`;

// The customer's own design, stitched (migrations/0054): a line whose copy of its options has a custom
// EMBROIDERY entry. The shop digitizes the customer's image into the line's order design
// (order_item_designs), so the order needs digitizing and the customer approves the proof — the same
// path as a typed-in name. (A custom transfer is printed as uploaded: no approval in this version.)
// `a` is the order_items alias.
const customEmbroideryLineSql_ = (a) => `(${a}.configJson LIKE '%"custom":true%' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${a}.configJson) THEN ${a}.configJson ELSE '{}' END, '$.locations') cj
    WHERE json_extract(cj.value, '$.custom') = 1 AND json_extract(cj.value, '$.kind') = 'embroidery'))`;
const CUSTOM_EMBROIDERY_SQL_ = `EXISTS (SELECT 1 FROM order_items cx WHERE cx.orderId = o.orderId AND cx.cancelDate IS NULL AND ${customEmbroideryLineSql_("cx")})`;

// The approval and digitizing expressions for THIS database. A line's copy of its options
// (order_items.configJson) arrived in migrations/0036; an older database gets the expressions without
// the custom-design part. Checked once per database (orderItemsHasConfigCol_).
async function stageSql_(db) {
  if (!(await orderItemsHasConfigCol_(db))) return { approval: NEEDS_DESIGN_APPROVAL_SQL_, digitizing: NEEDS_DIGITIZING_SQL_ };
  return {
    approval: `(${featureOnSql_("designVerification")} AND (${FREE_FORM_TEXT_SQL_} OR ${CUSTOM_EMBROIDERY_SQL_}))`,
    digitizing: `(${NEEDS_DIGITIZING_SQL_} OR (${featureOnSql_("production")} AND ${CUSTOM_EMBROIDERY_SQL_}))`,
  };
}

export async function getProductionQueue(db) {
  const stage = await stageSql_(db);
  const { results } = await db.prepare(`
    SELECT oi.id AS itemId, oi.orderId, oi.orgId, o.customerName, o.placedAt, o.dueDate, oi.qty,
           COALESCE(oi.manufacturedQty,0) AS manufacturedQty, oi.productId,
           oi.name AS itemName, oi.size AS itemSize, oi.transfersAppliedAt,
           org.name AS orgName,
           pbl.blankId, pbl.blankColor, pbl.blankSize,
           b.name AS blankName, b.brand AS blankBrand, b.productType AS blankProductType,
           p.designId, d.name AS designName, d.stabilizer, d.hoopId, h.name AS hoopName,
           dv.threadColorsJson, dv.machineFileKey, dv.machineFileName,
           (SELECT count(*) FROM order_items oi2 WHERE oi2.orderId = oi.orderId AND oi2.cancelDate IS NULL) AS activeItemCount
    FROM order_items oi
    JOIN orders o ON o.orderId = oi.orderId
    JOIN orgs org ON org.orgId = oi.orgId
    LEFT JOIN product_blank_links pbl ON pbl.orgId = oi.orgId AND pbl.productId = oi.productId
           AND pbl.productColor = (CASE WHEN oi.configJson LIKE '{%' THEN COALESCE(json_extract(oi.configJson,'$.garmentColor'),'') ELSE '' END)
           AND pbl.productSize = oi.size
    LEFT JOIN blanks b ON b.id = pbl.blankId
    LEFT JOIN products p ON p.orgId = oi.orgId AND p.productId = oi.productId
    LEFT JOIN designs d ON d.id = p.designId
    LEFT JOIN hoops h ON h.id = d.hoopId
    LEFT JOIN design_versions dv ON dv.id = (
      SELECT id FROM design_versions WHERE designId = d.id ORDER BY uploadedAt DESC, id DESC LIMIT 1
    )
    WHERE oi.cancelDate IS NULL
      AND o.paid = 1 AND o.isTest = 0 AND o.voidedAt IS NULL
      AND COALESCE(oi.blankReceivedAt, o.blankReceivedAt) IS NOT NULL AND o.manufacturedAt IS NULL
      AND (o.designApprovedAt IS NOT NULL OR (NOT ${stage.approval}
           AND (o.digitizingCompleteAt IS NOT NULL OR NOT ${stage.digitizing})))
      AND COALESCE(oi.manufacturedQty,0) < oi.qty
    ORDER BY (o.dueDate IS NULL), o.dueDate, blankProductType, blankName, oi.size, o.placedAt
  `).all();
  const jobs = results.map(parseQueueRow_);
  if (!jobs.length) return jobs;
  const appliedAt = {}; for (const r of results) appliedAt[Number(r.itemId)] = r.transfersAppliedAt || "";
  // The needle TYPE each linked blank wants (migrations/0044); "" = not set on the blank. A
  // separate, tolerant read so the queue still loads on a database without the needle tables.
  try {
    const blankIds = [...new Set(jobs.map(j => j.blank && j.blank.id).filter(Boolean))];
    const { results: nt } = blankIds.length ? await db.prepare(
      `SELECT b.id, t.name FROM blanks b JOIN needle_types t ON t.id = b.needleTypeId
       WHERE b.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(blankIds)).all() : { results: [] };
    const typeByBlank = {};
    for (const r of nt) typeByBlank[r.id] = r.name || "";
    for (const j of jobs) if (j.blank) j.blank.needleType = typeByBlank[j.blank.id] || "";
  } catch (e) { if (!missingNeedleTables_(e)) throw e; }
  // Each line's hoopings (migrations/0032) and where each of its pieces is in them.
  let ctx = null, runs = [];
  try {
    ctx = await hoopingContext_(db, jobs.map(j => j.itemId));
    ({ results: runs } = await db.prepare(
      `SELECT id, itemId, pieceNo, stepNo, status, machineId, machineName, startedAt, hoopId FROM production_runs
       WHERE status IN ('running','done') AND itemId IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify(jobs.map(j => j.itemId))).all());
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
  const kept = [];
  for (const job of jobs) {
    const cfgItem = ctx && ctx.items[job.itemId];
    const steps = ctx ? planHoopings_(ctx, cfgItem) : [legacyStep_(job.design)];
    // A configurable line with no embroidery hoopings is transfer-only — it belongs on Run Transfer
    // Sheets, not the embroidery Run Order queue, so drop it here.
    if (cfgItem && cfgItem.configurable && cfgItem.config && !steps.length) continue;
    // The same for a plain product that needs no embroidery but has a transfer (its reorder QR).
    if (cfgItem && lineTransfers_(cfgItem).length && !lineIsEmbroidered_(cfgItem, steps)) continue;
    job.steps = steps;
    // Transfers this line ALSO needs pressed (a reorder QR, or a transfer option on a configurable
    // product) — done on Run Transfer Sheets, tracked apart from the embroidery (migrations/0048).
    job.transfers = lineTransfers_(cfgItem).map(l => ({ graphicName: l.graphicName || "", auto: !!l.auto }));
    job.transfersApplied = !!appliedAt[job.itemId];
    // Old shape, for readers that only know one design: the first hooping.
    const s1 = steps[0];
    if (s1 && s1.designId != null) job.design = { id: s1.designId, name: s1.designName, stabilizer: s1.stabilizer,
      hoopId: s1.hoopIds[0] || null, hoopName: s1.hoopNames[0] || "", threadColors: s1.threadColors,
      machineFileKey: s1.machineFileKey, machineFileName: s1.machineFileName };
    const st = pieceStates_(runs.filter(r => Number(r.itemId) === job.itemId), steps.length);
    job.pieces = st.pieces;
    job.idlePieces = Math.max(0, job.remaining - st.pieces.length);
    kept.push(job);
  }
  return kept;
}

// ---- Hoopings (migrations/0032) -------------------------------------------------------------
// One physical piece of a line item is made in one or more HOOPINGS, in order:
//   1. each of the product's designs (product_designs, run order) on the design's own hoops —
//      except the MAIN design when the line has typed-in personalization and the product combines
//      it: then that hooping runs the ORDER-SPECIFIC design (order_item_designs) on the design's
//      personalization hoops;
//   2. typed-in personalization the product stitches SEPARATELY: its own hooping, order-specific
//      design, on products.personalizationHoopId;
//   3. a pick-list option: its own hooping, the option's mapped design on that design's hoops.
// A hooping that can't run yet carries `blocked` (no order-specific design uploaded, an unmapped
// option). A line whose product has no designs is one hooping with no design (as before 0032).

// Loads everything planHoopings_ needs for these line items in a fixed number of queries.
async function hoopingContext_(db, itemIds) {
  const ids = JSON.stringify(itemIds.map(Number));
  const { results: items } = await db.prepare(
    `SELECT oi.id, oi.orgId, oi.productId, oi.personalized, oi.persName, oi.configJson,
            p.designId AS productDesignId, p.configurable, p.noDesignNeeded, p.personalizationOptions, p.personalizationMode, p.personalizationHoopId, p.personalizationOptionDesigns
     FROM order_items oi LEFT JOIN products p ON p.orgId = oi.orgId AND p.productId = oi.productId
     WHERE oi.id IN (SELECT value FROM json_each(?))`).bind(ids).all();
  const { results: pds } = await db.prepare(
    `SELECT pd.* FROM product_designs pd WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.id IN (SELECT value FROM json_each(?))
       AND oi.orgId = pd.orgId AND oi.productId = pd.productId) ORDER BY pd.sortOrder, pd.id`).bind(ids).all();
  const designIds = new Set(pds.map(r => Number(r.designId)));
  for (const it of items) {
    if (it.productDesignId != null) designIds.add(Number(it.productDesignId));
    for (const v of Object.values(tryParse_(it.personalizationOptionDesigns, {}) || {})) if (Number(v)) designIds.add(Number(v));
    // Configurable lines (migrations/0036): each embroidery option's design is its own hooping.
    if (Number(it.configurable)) { const cfg = tryParse_(it.configJson, null);
      if (cfg) for (const l of (cfg.locations || [])) if (l.kind === "embroidery" && Number(l.designId)) designIds.add(Number(l.designId)); }
  }
  const dIds = JSON.stringify([...designIds]);
  const { results: designs } = await db.prepare(
    `SELECT d.id, d.name, d.stabilizer, d.hoopId, dv.id AS versionId, dv.threadColorsJson, dv.machineFileKey, dv.machineFileName
     FROM designs d LEFT JOIN design_versions dv ON dv.id = (SELECT id FROM design_versions WHERE designId = d.id ORDER BY uploadedAt DESC, id DESC LIMIT 1)
     WHERE d.id IN (SELECT value FROM json_each(?))`).bind(dIds).all();
  const { results: dh } = await db.prepare(
    "SELECT designId, hoopId, purpose FROM design_hoops WHERE designId IN (SELECT value FROM json_each(?)) ORDER BY sortOrder, hoopId").bind(dIds).all();
  // The newest order design per line — and, since migrations/0055, per location of the line.
  const sameLoc = (await orderItemDesignsHasLocation_(db)) ? " AND y.location = x.location" : "";
  const { results: ids2 } = await db.prepare(
    `SELECT x.* FROM order_item_designs x WHERE x.itemId IN (SELECT value FROM json_each(?))
       AND x.id = (SELECT id FROM order_item_designs y WHERE y.itemId = x.itemId${sameLoc} ORDER BY uploadedAt DESC, id DESC LIMIT 1)`).bind(ids).all();
  const { results: hoops } = await db.prepare("SELECT id, name FROM hoops").all();
  const ctx = { items: {}, productDesigns: {}, designs: {}, itemDesigns: {}, itemDesignsAt: {}, hoopNames: {} };
  for (const h of hoops) ctx.hoopNames[h.id] = h.name || "";
  for (const d of designs) ctx.designs[d.id] = { id: Number(d.id), name: d.name || "", stabilizer: d.stabilizer || "",
    hoopIds: [], personalizationHoopIds: [], legacyHoopId: d.hoopId == null ? null : Number(d.hoopId),
    versionId: d.versionId == null ? null : Number(d.versionId), threadColors: tryParse_(d.threadColorsJson, []),
    machineFileKey: d.machineFileKey || "", machineFileName: d.machineFileName || "" };
  for (const r of dh) { const d = ctx.designs[r.designId]; if (d) (r.purpose === "personalization" ? d.personalizationHoopIds : d.hoopIds).push(Number(r.hoopId)); }
  for (const d of Object.values(ctx.designs)) if (!d.hoopIds.length && d.legacyHoopId) d.hoopIds.push(d.legacyHoopId);
  for (const r of pds) (ctx.productDesigns[r.orgId + "|" + r.productId] = ctx.productDesigns[r.orgId + "|" + r.productId] || []).push(parseProductDesign_(r));
  for (const r of ids2) {
    const d = parseOrderItemDesign_(r);
    (ctx.itemDesignsAt[r.itemId] = ctx.itemDesignsAt[r.itemId] || {})[d.location] = d;
    if (!d.location) ctx.itemDesigns[r.itemId] = d;   // the line's one design ('')
  }
  for (const it of items) ctx.items[it.id] = {
    itemId: Number(it.id), orgId: it.orgId, productId: it.productId || "", personalized: !!it.personalized, persName: it.persName || "",
    productDesignId: it.productDesignId == null ? null : Number(it.productDesignId),
    options: tryParse_(it.personalizationOptions, []) || [], mode: it.personalizationMode === "separate" ? "separate" : "combined",
    persHoopId: it.personalizationHoopId == null ? null : Number(it.personalizationHoopId),
    optionDesigns: tryParse_(it.personalizationOptionDesigns, {}) || {},
    configurable: !!Number(it.configurable), noDesignNeeded: !!Number(it.noDesignNeeded), config: tryParse_(it.configJson, null) };
  return ctx;
}

// Is there embroidery to run on this line? A configurable line: only when it has embroidery picks.
// A plain line: yes, unless its product is marked "No embroidery design needed" and nothing gave it
// a real hooping — such a line with a transfer (a reorder QR) is transfer-only.
function lineIsEmbroidered_(it, steps) {
  if (!it) return true;
  if (it.configurable && it.config && !it.config.plain) return steps.length > 0;
  // An ordinary line made from the customer's own design (migrations/0054): only what its plan holds.
  if (plainCustom_(it)) return steps.length > 0;
  return steps.some(st => st.designId != null || st.kind === "itemDesign" || st.blocked) || !it.noDesignNeeded;
}
const lineTransfers_ = (it) => it && it.config ? (it.config.locations || []).filter(l => l.kind === "transfer") : [];
// The customer's own design on an ordinary (not configurable-picked) line, or null.
const plainCustom_ = (it) => it && it.config && (it.config.plain || !it.configurable)
  ? (it.config.locations || []).find(l => l && l.custom) || null : null;

const legacyStep_ = (design) => ({ stepNo: 1, label: design ? design.name : "", kind: "design",
  designId: design ? design.id : null, designName: design ? design.name : "", versionId: null, itemDesignId: null,
  stabilizer: design ? design.stabilizer : "", hoopIds: design && design.hoopId ? [design.hoopId] : [],
  hoopNames: design && design.hoopName ? [design.hoopName] : [], threadColors: design ? design.threadColors : [],
  machineFileKey: design ? design.machineFileKey : "", machineFileName: design ? design.machineFileName : "", blocked: "" });

// The ordered hoopings for one line item (see the comment above hoopingContext_).
function planHoopings_(ctx, it) {
  if (!it) return [legacyStep_(null)];
  const steps = [];
  const names = (hoopIds) => hoopIds.map(h => ctx.hoopNames[h] || "");
  const fromDesign = (d, label, kind, hoopIds) => ({ label, kind, designId: d.id, designName: d.name, versionId: d.versionId, itemDesignId: null,
    stabilizer: d.stabilizer, hoopIds, hoopNames: names(hoopIds), threadColors: d.threadColors,
    machineFileKey: d.machineFileKey, machineFileName: d.machineFileName,
    blocked: d.machineFileKey ? "" : `"${d.name}" has no machine file uploaded yet` });
  // Configurable products (migrations/0036): hoopings come from the line's chosen EMBROIDERY options
  // (location order); transfer options go to Run Transfer Sheets, not here. Returns [] when the line
  // has no embroidery picks (a transfer-only line — kept out of the embroidery Run Order queue).
  const itemDesign = ctx.itemDesigns[it.itemId] || null;
  // The customer's own design, stitched (migrations/0054): the shop digitizes each location's image into
  // its own order design (order_item_designs at that location, migrations/0055), so each of those
  // hoopings waits for its upload. A line with one custom spot from before 0055 uses its '' design.
  const at = (ctx.itemDesignsAt || {})[it.itemId] || {};
  const customCount = it.config ? (it.config.locations || []).filter(l => l && l.custom && l.kind === "embroidery").length : 0;
  const customStep = (label, hoopIds, loc, where) => {
    const d = at[loc] || (customCount === 1 ? at[""] : null) || null;
    return { label, kind: "itemDesign", designId: null, designName: "Customer design", versionId: null, itemDesignLocation: loc,
      itemDesignId: d ? d.id : null, stabilizer: "", hoopIds, hoopNames: names(hoopIds),
      threadColors: d ? d.threadColors : [], machineFileKey: d ? d.machineFileKey : "", machineFileName: d ? d.machineFileName : "",
      blocked: d ? "" : `Upload the digitized stitch file for the customer's design${where ? " at " + where : ""} first (Edit items → Files → Order design)` };
  };
  if (it.configurable && it.config && !it.config.plain) {
    for (const l of (it.config.locations || [])) {
      if (l.custom && l.kind === "embroidery") { steps.push(customStep("Customer design: " + (l.label || l.location), [], String(l.location), l.label || l.location)); continue; }
      if (l.kind !== "embroidery" || !Number(l.designId)) continue;
      const d = ctx.designs[Number(l.designId)];
      if (d) steps.push(fromDesign(d, l.label || l.location, "design", d.hoopIds));
      else steps.push({ label: l.label || l.location, kind: "design", designId: Number(l.designId), designName: l.graphicName || "", versionId: null,
        itemDesignId: null, stabilizer: "", hoopIds: [], hoopNames: [], threadColors: [], machineFileKey: "", machineFileName: "",
        blocked: `Design for "${l.graphicName || l.label}" is unavailable` });
    }
    return steps.map((st, i) => Object.assign(st, { stepNo: i + 1 }));
  }
  const fromItemDesign = (label, hoopIds, base) => ({ label, kind: "itemDesign", itemDesignLocation: "", designId: base ? base.id : null,
    designName: base ? base.name + " + personalization" : "Personalization", versionId: null, itemDesignId: itemDesign ? itemDesign.id : null,
    stabilizer: base ? base.stabilizer : "", hoopIds, hoopNames: names(hoopIds),
    threadColors: itemDesign ? itemDesign.threadColors : [], machineFileKey: itemDesign ? itemDesign.machineFileKey : "",
    machineFileName: itemDesign ? itemDesign.machineFileName : "",
    blocked: itemDesign ? "" : `Upload the order-specific design for "${it.persName || "the personalization"}" first` });
  const isOption = it.personalized && it.options.includes(it.persName);
  const freeText = it.personalized && !isOption;
  let pds = ctx.productDesigns[it.orgId + "|" + it.productId] || [];
  if (!pds.length && it.productDesignId != null) pds = [{ designId: it.productDesignId, placement: "", isMain: true }];
  // The customer's own design on an ordinary line replaces the product's designs. Stitched: one
  // "Customer design" hooping on the main design's hoops (any hoop when there's none) — a typed-in
  // name is digitized into that same order design. Printed as a transfer: no hooping for it at all
  // (the line goes to Run Transfer Sheets); typed-in personalization is still its own hooping.
  const custom = plainCustom_(it);
  if (custom) {
    if (custom.kind === "embroidery") {
      const main = pds.find(pd => pd.isMain) || pds[0];
      const d = main ? ctx.designs[main.designId] : null;
      steps.push(customStep("Customer design", d ? d.hoopIds : [], String(custom.location), ""));
    } else if (freeText) steps.push(fromItemDesign("Personalization", it.persHoopId ? [it.persHoopId] : [], null));
    pds = [];
  }
  let combined = false;
  for (const pd of pds) {
    const d = ctx.designs[pd.designId];
    if (!d) continue;
    const label = pd.placement || d.name;
    if (pd.isMain && freeText && it.mode === "combined") {
      combined = true;
      steps.push(fromItemDesign(label + " + personalization", d.personalizationHoopIds.length ? d.personalizationHoopIds : d.hoopIds, d));
    } else steps.push(fromDesign(d, label, "design", d.hoopIds));
  }
  if (freeText && !combined && !custom) steps.push(fromItemDesign("Personalization", it.persHoopId ? [it.persHoopId] : [], null));
  if (isOption) {
    const d = ctx.designs[Number(it.optionDesigns[it.persName])];
    if (d) steps.push(fromDesign(d, "Personalization: " + it.persName, "option", d.hoopIds));
    else steps.push({ label: "Personalization: " + it.persName, kind: "option", designId: null, designName: it.persName, versionId: null,
      itemDesignId: null, stabilizer: "", hoopIds: [], hoopNames: [], threadColors: [], machineFileKey: "", machineFileName: "",
      blocked: `No design is mapped to the pick-list option "${it.persName}" — map it on the product` });
  }
  if (!steps.length && !custom) steps.push(legacyStep_(null));
  return steps.map((st, i) => Object.assign(st, { stepNo: i + 1 }));
}

// Where a line's pieces are: [{pieceNo, done:[stepNo…], running:{runId,stepNo,…}|null, nextStepNo}]
// for every piece started but not finished. A piece whose every hooping is done has already
// been counted into manufacturedQty, so it's left out. Old runs (pieceNo NULL) are one-hooping
// pieces: only a running one is still in progress.
function pieceStates_(runs, stepCount) {
  const by = new Map(), pieces = [];
  for (const r of runs) {
    if (r.pieceNo == null) {
      if (r.status === "running") pieces.push({ pieceNo: null, done: [], nextStepNo: 1, running: runInfo_(r) });
      continue;
    }
    const k = Number(r.pieceNo);
    const p = by.get(k) || { pieceNo: k, done: [], running: null };
    if (r.status === "done") p.done.push(Number(r.stepNo)); else p.running = runInfo_(r);
    by.set(k, p);
  }
  for (const p of [...by.values()].sort((a, b) => a.pieceNo - b.pieceNo)) {
    if (new Set(p.done).size >= stepCount && !p.running) continue;
    p.done.sort((a, b) => a - b);
    let next = 1; while (p.done.includes(next)) next++;
    p.nextStepNo = p.running ? Number(p.running.stepNo) : next;
    pieces.push(p);
  }
  return { pieces };
}
const runInfo_ = (r) => ({ runId: Number(r.id), stepNo: r.stepNo == null ? 1 : Number(r.stepNo),
  machineId: r.machineId == null ? null : Number(r.machineId), machineName: r.machineName || "", startedAt: r.startedAt,
  hoopId: r.hoopId == null ? null : Number(r.hoopId) });

// The hoopings for ONE line item (start/complete use this; same plan the queue shows).
async function itemHoopings_(db, itemId) {
  try { const ctx = await hoopingContext_(db, [itemId]); return planHoopings_(ctx, ctx.items[itemId]); }
  catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return null; throw e; }
}

// Run Order's "Waiting on blanks": real orders whose blanks were ordered but haven't arrived yet
// (not manufactured, completed, voided or fully cancelled), oldest blank order first.
// Orders with at least one active line whose blank is ordered but not yet received (migrations/0039
// made this per-item). Each returned order carries only its still-awaiting lines + its shipments.
export async function getOrdersAwaitingBlanks(db) {
  const orders = await loadOrders_(db,
    `o.manufacturedAt IS NULL AND o.completedAt IS NULL AND o.voidedAt IS NULL AND o.isTest = 0
     AND EXISTS (SELECT 1 FROM order_items ai WHERE ai.orderId = o.orderId AND ai.cancelDate IS NULL
                   AND ai.blankOrderedAt IS NOT NULL AND ai.blankReceivedAt IS NULL)`,
    [], "(SELECT MIN(ai.blankOrderedAt) FROM order_items ai WHERE ai.orderId = o.orderId AND ai.cancelDate IS NULL AND ai.blankReceivedAt IS NULL) ASC, placedAt ASC");
  if (!orders.length) return [];
  return orders.map(o => {
    const waiting = o.items.filter(it => !it.cancelDate && it.blankOrderedAt && !it.blankReceivedAt);
    const first = waiting.find(it => it.blankVendor) || waiting[0] || {};
    const ests = waiting.map(it => it.blankEstDelivery).filter(Boolean).sort();
    return {
      orderId: o.orderId, orgId: o.orgId, customerName: o.customerName, placedAt: o.placedAt, dueDate: o.dueDate || "",
      blankOrderedAt: waiting.map(it => it.blankOrderedAt).filter(Boolean).sort()[0] || o.blankOrderedAt,
      blankVendor: first.blankVendor || "", blankVendorOrderId: first.blankVendorOrderId || "",
      blankEstDelivery: ests.slice(-1)[0] || "",
      items: waiting.map(it => ({ itemId: it.id, name: it.name, type: it.type, size: it.size, qty: it.qty,
        shipped: !!it.blankShippedAt })),
      shipments: o.blankShipments || [],   // attached by loadOrders_ — don't re-query (param-cap safe)
    };
  });
}

// Create a blank shipment (one tracking number) covering the given line items (migrations/0039):
// inserts blank_shipments + blank_shipment_items, stamps each item's blankShippedAt, and recomputes
// every affected order's summary. itemIds may span orders. Returns the new shipment id.
export async function addBlankShipment(db, { carrier, trackingNumber, vendor, shippedAt, itemIds }) {
  const ids = [...new Set((itemIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw pricingError_("Pick at least one item for the shipment.");
  const now = new Date().toISOString();
  const shippedIso = shippedAt && /^\d{4}-\d{2}-\d{2}/.test(String(shippedAt)) ? String(shippedAt).slice(0, 10) : now.slice(0, 10);
  // Resolve the real, active lines FIRST (ignore bogus/cancelled ids). Refuse if none resolve, so a
  // shipment row is never created without at least one covered line (which would orphan it — no
  // order view shows it, but the daily Shippo poller still processes it).
  const placeholders = ids.map(() => "?").join(",");
  const { results: rows } = await db.prepare(
    `SELECT id, orderId FROM order_items WHERE id IN (${placeholders}) AND cancelDate IS NULL`).bind(...ids).all();
  if (!rows.length) throw pricingError_("None of the selected items are valid order lines.");
  const res = await db.prepare(
    `INSERT INTO blank_shipments (carrier, trackingNumber, vendor, shippedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(String(carrier || "").slice(0, 40), String(trackingNumber || "").slice(0, 100), String(vendor || "").slice(0, 100), shippedIso, now, now).run();
  const shipmentId = Number(res.meta.last_row_id);
  const stmts = [];
  for (const r of rows) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO blank_shipment_items (shipmentId, itemId) VALUES (?, ?)").bind(shipmentId, Number(r.id)));
    stmts.push(db.prepare("UPDATE order_items SET blankShippedAt = COALESCE(blankShippedAt, ?) WHERE id = ?").bind(shippedIso, Number(r.id)));
  }
  await db.batch(stmts);   // rows.length >= 1, so this is never empty
  for (const orderId of [...new Set(rows.map(r => r.orderId))]) await recomputeOrderBlankStatus_(db, orderId);
  return shipmentId;
}

export async function deleteBlankShipment(db, id) {
  const sid = Number(id);
  // Remember the lines this shipment covered + their orders, so we can clear a line's blankShippedAt
  // when no OTHER shipment still covers it, and roll the order summaries back up.
  const { results: covered } = await db.prepare(
    "SELECT si.itemId, oi.orderId FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId WHERE si.shipmentId=?").bind(sid).all();
  await db.prepare("DELETE FROM blank_tracking_events WHERE shipmentId=?").bind(sid).run();
  await db.prepare("DELETE FROM blank_shipment_items WHERE shipmentId=?").bind(sid).run();
  await db.prepare("DELETE FROM blank_shipments WHERE id=?").bind(sid).run();
  for (const r of covered) {
    const still = await db.prepare("SELECT 1 FROM blank_shipment_items WHERE itemId=? LIMIT 1").bind(Number(r.itemId)).first();
    if (!still) await db.prepare("UPDATE order_items SET blankShippedAt=NULL WHERE id=?").bind(Number(r.itemId)).run();
  }
  for (const orderId of [...new Set(covered.map(r => r.orderId))]) await recomputeOrderBlankStatus_(db, orderId);
}

// Edit an existing shipment (migrations/0039): correct its carrier/tracking/ship date and which line
// items it covers, keeping its id (and scan history, unless the tracking number itself changes — then
// the old events/status are cleared so the next poll refetches for the new number).
export async function updateBlankShipment(db, id, { carrier, trackingNumber, shippedAt, itemIds }) {
  const sid = Number(id);
  const ids = [...new Set((itemIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw pricingError_("Pick at least one item for the shipment.");
  const before = await db.prepare("SELECT trackingNumber FROM blank_shipments WHERE id=?").bind(sid).first();
  if (!before) throw pricingError_("That shipment no longer exists.");
  // Resolve the real active lines BEFORE touching anything, and refuse if none resolve — otherwise
  // the item-set replacement below would leave the shipment covering zero lines (an orphan).
  const placeholders = ids.map(() => "?").join(",");
  const { results: rows } = await db.prepare(
    `SELECT id, orderId FROM order_items WHERE id IN (${placeholders}) AND cancelDate IS NULL`).bind(...ids).all();
  if (!rows.length) throw pricingError_("None of the selected items are valid order lines.");
  const now = new Date().toISOString();
  const newTrack = String(trackingNumber || "").slice(0, 100);
  const shippedIso = shippedAt && /^\d{4}-\d{2}-\d{2}/.test(String(shippedAt)) ? String(shippedAt).slice(0, 10) : null;
  const trackChanged = newTrack !== (before.trackingNumber || "");
  await db.prepare(
    `UPDATE blank_shipments SET carrier=?, trackingNumber=?, shippedAt=COALESCE(?, shippedAt), updatedAt=?${trackChanged ? ", status='', statusDetail='', statusDate=NULL, deliveredAt=NULL, lastCheckedAt=NULL" : ""} WHERE id=?`
  ).bind(String(carrier || "").slice(0, 40), newTrack, shippedIso, now, sid).run();
  if (trackChanged) await db.prepare("DELETE FROM blank_tracking_events WHERE shipmentId=?").bind(sid).run();
  // Replace the covered-items set.
  const prev = (await db.prepare("SELECT itemId, (SELECT orderId FROM order_items WHERE id=blank_shipment_items.itemId) AS orderId FROM blank_shipment_items WHERE shipmentId=?").bind(sid).all()).results || [];
  await db.prepare("DELETE FROM blank_shipment_items WHERE shipmentId=?").bind(sid).run();
  const stmts = [];
  const shipDate = shippedIso || now.slice(0, 10);
  for (const r of rows) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO blank_shipment_items (shipmentId, itemId) VALUES (?, ?)").bind(sid, Number(r.id)));
    stmts.push(db.prepare("UPDATE order_items SET blankShippedAt = COALESCE(blankShippedAt, ?) WHERE id = ?").bind(shipDate, Number(r.id)));
  }
  if (stmts.length) await db.batch(stmts);
  // A line dropped from this shipment and covered by no other loses its shipped stamp.
  for (const p of prev) {
    if (rows.some(r => Number(r.id) === Number(p.itemId))) continue;
    const still = await db.prepare("SELECT 1 FROM blank_shipment_items WHERE itemId=? LIMIT 1").bind(Number(p.itemId)).first();
    if (!still) await db.prepare("UPDATE order_items SET blankShippedAt=NULL WHERE id=?").bind(Number(p.itemId)).run();
  }
  const orderIds = [...new Set([...rows.map(r => r.orderId), ...prev.map(p => p.orderId)].filter(Boolean))];
  for (const orderId of orderIds) await recomputeOrderBlankStatus_(db, orderId);
}

// Active blank shipments to poll (not delivered, has a tracking number), oldest-checked first, with
// a representative order/org/customer (the first covered active line) for notices + the roll-up.
export async function listActiveBlankShipments(db, limit = 40) {
  const { results } = await db.prepare(
    `SELECT s.id, s.carrier, s.trackingNumber, s.status,
            (SELECT oi.orderId FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId WHERE si.shipmentId = s.id LIMIT 1) AS orderId,
            (SELECT oi.orgId   FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId WHERE si.shipmentId = s.id LIMIT 1) AS orgId,
            (SELECT o.customerName FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId JOIN orders o ON o.orderId = oi.orderId WHERE si.shipmentId = s.id LIMIT 1) AS customerName
     FROM blank_shipments s
     WHERE s.deliveredAt IS NULL AND s.trackingNumber <> ''
       AND EXISTS (SELECT 1 FROM blank_shipment_items si JOIN order_items oi ON oi.id = si.itemId WHERE si.shipmentId = s.id)
     ORDER BY (s.lastCheckedAt IS NOT NULL), s.lastCheckedAt, s.id
     LIMIT ?`).bind(Math.max(1, Math.min(200, Number(limit) || 40))).all();
  return results.map(r => ({ id: Number(r.id), carrier: r.carrier || "", trackingNumber: r.trackingNumber || "",
    status: r.status || "", orderId: r.orderId || "", orgId: r.orgId || "", customerName: r.customerName || "" }));
}

export async function recordBlankTrackingEvents(db, shipmentId, events) {
  const list = (events || []).filter(e => e && (e.status || e.occurredAt));
  if (!list.length) return 0;
  const now = new Date().toISOString();
  // Each poll re-reports the carrier's FULL history, so read the scans already stored and only insert
  // genuinely-new ones — the batch holds just the new rows instead of mostly-ignored inserts, and the
  // return value is the real new-event count. UNIQUE(shipmentId,status,occurredAt) remains the backstop
  // for a concurrent double-insert. (Two same-status scans that both lack a carrier timestamp still
  // collapse to one row — vanishingly rare, and widening the key would need a table rebuild.)
  const seen = new Set();
  try {
    const { results } = await db.prepare("SELECT status, occurredAt FROM blank_tracking_events WHERE shipmentId=?").bind(Number(shipmentId)).all();
    for (const r of results) seen.add((r.status || "") + "|" + (r.occurredAt || ""));
  } catch (e) { /* table missing or read failed — fall back to insert-or-ignore for all */ }
  const stmts = [];
  for (const e of list) {
    const key = String(e.status || "") + "|" + String(e.occurredAt || "");
    if (seen.has(key)) continue;
    seen.add(key);   // also de-dup within this batch
    stmts.push(db.prepare("INSERT OR IGNORE INTO blank_tracking_events (shipmentId, status, statusDetail, location, occurredAt, recordedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(Number(shipmentId), String(e.status || ""), String(e.statusDetail || ""), String(e.location || ""), String(e.occurredAt || ""), now));
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

export async function setBlankShipmentStatus(db, shipmentId, { status, statusDetail, statusDate, deliveredAt }) {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE blank_shipments SET status=?, statusDetail=?, statusDate=?, deliveredAt=COALESCE(deliveredAt, ?), lastCheckedAt=?, updatedAt=? WHERE id=?`
  ).bind(String(status || ""), String(statusDetail || ""), statusDate || null, deliveredAt || null, now, now, Number(shipmentId)).run();
}

// A blank shipment's full detail: latest status + covered item ids + the per-scan event history.
export async function getBlankShipmentsForOrder(db, orderId) {
  const map = await blankShipmentsByOrder_(db, [orderId]);  // already carries each shipment's events
  return map[orderId] || [];
}

// Shipments (with latest status + covered item ids) grouped by order.
// `scope` is EITHER a small array of order ids, OR { sub, binds } where `sub` is a SELECT that
// returns the order ids and `binds` its parameters — the subquery form avoids D1's ~100-bound-
// parameter cap on a large Orders page (the same trick loadOrders_ uses for its other child joins;
// an expanded `?,?,?…` id list silently threw past ~100 orders, dropping all shipment data).
async function blankShipmentsByOrder_(db, scope) {
  const out = byId_();
  const isSub = scope && !Array.isArray(scope) && typeof scope.sub === "string";
  const orderIds = isSub ? null : (scope || []);
  if (!isSub && !orderIds.length) return out;
  const inClause = isSub ? scope.sub : orderIds.map(() => "?").join(",");
  const whereBinds = isSub ? (scope.binds || []) : orderIds;
  let rows = [];
  try {
    const r = await db.prepare(
      `SELECT DISTINCT s.id, s.carrier, s.trackingNumber, s.vendor, s.shippedAt, s.status, s.statusDetail,
              s.statusDate, s.deliveredAt, s.lastCheckedAt, oi.orderId, si.itemId
       FROM blank_shipments s
       JOIN blank_shipment_items si ON si.shipmentId = s.id
       JOIN order_items oi ON oi.id = si.itemId
       WHERE oi.orderId IN (${inClause})
       ORDER BY s.createdAt`).bind(...whereBinds).all();
    rows = r.results || [];
  } catch (e) {
    // A pre-migration DB has no blank_shipment tables — return empty. Any OTHER error is real
    // (don't let it masquerade as "no shipments" the way a blanket catch would).
    if (/no such (table|column)/i.test(String(e && e.message))) return out;
    throw e;
  }
  const byId = {}, byShipId = {};
  for (const r of rows) {
    const key = r.orderId + "|" + r.id;
    if (!byId[key]) { byId[key] = { id: Number(r.id), carrier: r.carrier || "", trackingNumber: r.trackingNumber || "",
      vendor: r.vendor || "", shippedAt: r.shippedAt || "", status: r.status || "", statusDetail: r.statusDetail || "",
      statusDate: r.statusDate || "", deliveredAt: r.deliveredAt || "", lastCheckedAt: r.lastCheckedAt || "", itemIds: [], events: [] };
      (out[r.orderId] = out[r.orderId] || []).push(byId[key]);
      (byShipId[r.id] = byShipId[r.id] || []).push(byId[key]); }   // a shipment can appear under several orders
    byId[key].itemIds.push(Number(r.itemId));
  }
  // Attach each shipment's full per-scan carrier history (newest first) in one query, scoped through
  // the SAME order filter (not an expanded shipment-id list — that would re-introduce the param cap).
  if (Object.keys(byShipId).length) {
    try {
      const ev = await db.prepare(
        `SELECT shipmentId, status, statusDetail, location, occurredAt FROM blank_tracking_events
         WHERE shipmentId IN (
           SELECT DISTINCT si.shipmentId FROM blank_shipment_items si
           JOIN order_items oi ON oi.id = si.itemId WHERE oi.orderId IN (${inClause}))
         ORDER BY occurredAt DESC, id DESC`).bind(...whereBinds).all();
      for (const e of (ev.results || [])) for (const s of (byShipId[e.shipmentId] || []))
        s.events.push({ status: e.status || "", statusDetail: e.statusDetail || "", location: e.location || "", occurredAt: e.occurredAt || "" });
    } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; /* pre-migration DB */ }
  }
  return out;
}

// Every paid order not yet run (migrations/0038) — the run pages' due-date-ordered backlog. Paid,
// real, not voided/completed, not yet manufactured, with at least one active line. Soonest-due
// first, undated after all dated, then oldest-placed. blankReceived lets the UI flag what's ready.
export async function getPaidUnrunOrders(db) {
  const orders = await loadOrders_(db,
    `o.paid = 1 AND o.isTest = 0 AND o.voidedAt IS NULL AND o.manufacturedAt IS NULL AND o.completedAt IS NULL
     AND EXISTS (SELECT 1 FROM order_items ai WHERE ai.orderId = o.orderId AND ai.cancelDate IS NULL)`,
    [], "(o.dueDate IS NULL) ASC, o.dueDate ASC, placedAt ASC");
  const orgNames = {};
  for (const org of await getAllOrgs(db)) orgNames[org.orgId] = org.name || org.orgId;
  return orders.map(o => ({
    orderId: o.orderId, orgId: o.orgId, orgName: orgNames[o.orgId] || o.orgId,
    customerName: o.customerName, placedAt: o.placedAt, dueDate: o.dueDate || "",
    blankReceived: !!o.blankReceivedAt, blankOrdered: !!o.blankOrderedAt,
    items: o.items.filter(it => !it.cancelDate).map(it => ({ name: it.name, size: it.size, qty: it.qty })),
  }));
}

// ---- Inventory movements & COGS (migrations/0009) -------------------------
// Every stock change is a movement; blank_sizes.quantity is a cache of their
// sum and blank_sizes.purchasePriceCents the running weighted-average cost.

async function blankName_(db, blankId) {
  const b = await db.prepare("SELECT name, brand, color FROM blanks WHERE id=?").bind(Number(blankId)).first();
  return b ? (b.name || [b.brand, b.color].filter(Boolean).join(" ")) : "";
}

// The blank's legacy scalar color, used as the default color dimension when a caller omits one
// (migrations/0037 backfilled a single-color blank's stock + links to this value). An explicit ''
// still means the empty color; only an omitted (null/undefined) color falls back here.
async function blankScalarColor_(db, blankId) {
  const b = await db.prepare("SELECT color FROM blanks WHERE id=?").bind(Number(blankId)).first();
  return b ? (b.color || "") : "";
}

// The INSERT for one movement as a prepared statement (not run), so callers can put it in a
// db.batch() with the stock update it belongs to — one transaction, never half-applied.
// m.blankName must already be resolved (blankName_).
function movementStmt_(db, m) {
  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, orderId, itemId, vendor, vendorRef, note, occurredAt, createdAt, vendorChargedTax, accountId, paidPersonally, receiptKey, receiptName)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(Number(m.blankId), m.blankName || "", m.color || "", m.size || "", Math.trunc(m.qtyDelta),
    Math.max(0, Math.round(Number(m.unitCostCents) || 0)), m.kind, m.orderId || null, m.itemId || null,
    String(m.vendor || "").slice(0, 100), String(m.vendorRef || "").slice(0, 100), String(m.note || "").slice(0, 300),
    m.occurredAt || now, now, m.vendorChargedTax ? 1 : 0, m.accountId ? Number(m.accountId) : null, m.paidPersonally ? 1 : 0,
    String(m.receiptKey || "").slice(0, 300), String(m.receiptName || "").slice(0, 200));
}

async function insertMovement_(db, m) {
  const r = await movementStmt_(db, { ...m, blankName: m.blankName || await blankName_(db, m.blankId) }).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// Blanks received from a vendor: lines = [{ size, qty, unitCost }] (dollars).
// Updates each size's weighted-average cost and stock.
// Landed cost: spreads shipping/other costs (extraCents) over the sizes in
// proportion to each size's cost (by quantity if every size cost $0), with
// largest-remainder rounding so the cents add up exactly, then turns each
// size's landed total into whole-cent unit costs — a total that doesn't
// divide evenly becomes two unit costs a cent apart (4 for $24.50 →
// 2 × $6.12 + 2 × $6.13). in: [{size, qty, cents}] → [{size, qty, unitCost}].
// Splits extraCents over parts in proportion to their weights, whole cents
// that always add back up exactly (largest remainder). All-zero weights → all 0.
export function spreadCents(weights, extraCents) {
  const extra = Math.max(0, Math.round(Number(extraCents) || 0));
  const w = weights.map(x => Math.max(0, Number(x) || 0)), totalW = w.reduce((a, x) => a + x, 0);
  const shares = w.map(x => totalW ? extra * x / totalW : 0);
  const alloc = shares.map(Math.floor);
  let left = totalW ? extra - alloc.reduce((a, c) => a + c, 0) : 0;
  shares.map((sh, i) => [sh - Math.floor(sh), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { alloc[i]++; left--; } });
  return alloc;
}

export function landedCostLines(sizes, extraCents = 0) {
  const rows = sizes.filter(x => Number(x.qty) > 0).map(x => ({ color: x.color || "", size: x.size, qty: Math.floor(Number(x.qty)), cents: Math.max(0, Math.round(Number(x.cents) || 0)) }));
  const byValue = rows.some(r => r.cents > 0);
  const alloc = spreadCents(rows.map(r => byValue ? r.cents : r.qty), extraCents);
  const out = [];
  rows.forEach((r, i) => {
    const cents = r.cents + alloc[i], base = Math.floor(cents / r.qty), up = cents - base * r.qty;
    if (r.qty - up > 0) out.push({ color: r.color, size: r.size, qty: r.qty - up, unitCost: base / 100 });
    if (up > 0) out.push({ color: r.color, size: r.size, qty: up, unitCost: (base + 1) / 100 });
  });
  return out;
}

// Returns the new purchase movements' ids (one per size received).
export async function receiveBlanks(db, { blankId, lines, vendor, vendorRef, receivedAt, vendorChargedTax, accountId, paidPersonally, note, receiptKey, receiptName }) {
  const name = await blankName_(db, blankId);
  const defColor = await blankScalarColor_(db, blankId);
  const ids = [];
  for (const l of lines) {
    const color = (l.color == null ? defColor : String(l.color)).slice(0, 80);
    const size = String(l.size || "").slice(0, 20);
    const qty = Math.floor(Number(l.qty) || 0);
    const costCents = Math.max(0, toCents(l.unitCost));
    if (qty <= 0) continue;
    // The movement and the stock/average-cost update commit together (one batch = one
    // transaction), and the new weighted average is computed INSIDE the upsert from the row's
    // current values — two receives of the same color+size can't both start from a stale average.
    // Same formula as before: round((onHand × avg + qty × cost) / (onHand + qty)), onHand ≥ 0.
    const res = await db.batch([
      movementStmt_(db, { blankId, blankName: name, color, size, qtyDelta: qty, unitCostCents: costCents, kind: "purchase",
        vendor, vendorRef, note: note || "Received", occurredAt: receivedAt, vendorChargedTax: !!vendorChargedTax,
        accountId: paidPersonally ? null : (accountId || null), paidPersonally: !!paidPersonally, receiptKey, receiptName }),
      db.prepare(
        `INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(blankId, color, size) DO UPDATE SET
           purchasePriceCents = CAST(ROUND((MAX(blank_sizes.quantity, 0) * blank_sizes.purchasePriceCents + ? * ?) * 1.0
                                           / (MAX(blank_sizes.quantity, 0) + ?)) AS INTEGER),
           quantity = blank_sizes.quantity + ?`
      ).bind(Number(blankId), color, size, costCents, qty, qty, costCents, qty, qty),
    ]);
    ids.push(Number(res[0] && res[0].meta && res[0].meta.last_row_id) || 0);
  }
  return ids;
}

// Blanks removed from stock without a sale — damaged, lost/miscounted, or used for
// testing/samples/shop scrap (qty > 0 = units removed), at the blank's current average
// cost. Reduces ending inventory the same way any write-off does (Schedule C Part III),
// so it flows into COGS through the inventory formula regardless of reason; `note`
// records which for reporting.
export async function writeOffBlanks(db, { blankId, color, size, qty, note, occurredAt }) {
  const q = Math.floor(Number(qty) || 0);
  if (q <= 0) return;
  const clr = color == null ? await blankScalarColor_(db, blankId) : String(color);
  const cur = await db.prepare("SELECT purchasePriceCents FROM blank_sizes WHERE blankId=? AND color=? AND size=?").bind(Number(blankId), clr, size).first();
  await db.batch([
    movementStmt_(db, { blankId, blankName: await blankName_(db, blankId), color: clr, size, qtyDelta: -q, unitCostCents: cur ? cur.purchasePriceCents : 0,
      kind: "writeoff", note: note || "Write-off", occurredAt }),
    db.prepare("UPDATE blank_sizes SET quantity = quantity - ? WHERE blankId=? AND color=? AND size=?").bind(q, Number(blankId), clr, size),
  ]);
}

// Called when an order is marked "manufactured": each active line whose
// product is linked to a blank consumes qty blanks at the current average
// cost, and that becomes the line's COGS. Idempotent (skips lines that
// already have a cost). Unlinked lines are left without a cost — the
// Inventory & COGS report lists them so the link can be added.
//
// makeItemPieces_ is the single consume primitive — the whole-order path and the per-piece Run
// Order path both go through it, so cost/stock are computed identically however the line is made.
// It moves ONE line's manufacturedQty from `fromQty` to `toQty`, consuming (toQty − fromQty)
// blanks at the current weighted-average cost: a dated `consume` movement, lower stock, and the
// line's COGS ACCUMULATED (a migration-era 'estimate' cost is overwritten on the first real piece).
//
// ATOMIC + RACE-SAFE: everything is one db.batch() (one transaction), and every statement in it is
// conditioned on the line's manufacturedQty still being `fromQty` — the value the caller read. The
// claim (manufacturedQty = toQty) runs LAST. Batches run one at a time, so if two requests (a
// double-click, two tabs, Run Order + Orders) read the same fromQty, the second batch finds the
// count already moved and every statement in it matches nothing: no second consume, no stock or
// COGS change. Returns { claimed, consumed }: claimed=false means someone else got there first.
async function makeItemPieces_(db, item, fromQty, toQty) {
  const pieces = toQty - fromQty;
  if (pieces <= 0) return { claimed: false, consumed: false };
  const id = Number(item.id);
  const productColor = String(item.color || "");
  const stillAt = "(SELECT COALESCE(manufacturedQty,0) FROM order_items WHERE id = ? AND cancelDate IS NULL) = ?";
  const link = await db.prepare(
    "SELECT blankId, blankColor, blankSize FROM product_blank_links WHERE orgId = ? AND productId = ? AND productColor = ? AND productSize = ?"
  ).bind(item.orgId, item.productId, productColor, item.size).first();
  const stmts = [];
  const linked = !!(link && link.blankId != null);
  if (linked) {
    const blankId = Number(link.blankId), color = link.blankColor || "", size = link.blankSize || "";
    const avgSql = "COALESCE((SELECT purchasePriceCents FROM blank_sizes WHERE blankId = ? AND color = ? AND size = ?), 0)";
    const now = new Date().toISOString();
    stmts.push(db.prepare(
      `INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, orderId, itemId, vendor, vendorRef, note, occurredAt, createdAt, vendorChargedTax, accountId, paidPersonally, receiptKey, receiptName)
       SELECT ?, ?, ?, ?, ?, MAX(0, ${avgSql}), 'consume', ?, ?, '', '', ?, ?, ?, 0, NULL, 0, '', '' WHERE ${stillAt}`
    ).bind(blankId, await blankName_(db, blankId), color, size, -pieces, blankId, color, size, item.orderId, id,
      ("Used for order " + item.orderId).slice(0, 300), now, now, id, fromQty));
    stmts.push(db.prepare(
      `UPDATE order_items SET cogsCents = (CASE WHEN cogsSource='consumed' THEN COALESCE(cogsCents,0) ELSE 0 END) + ? * MAX(0, ${avgSql}),
         cogsSource = 'consumed'
       WHERE id = ? AND cancelDate IS NULL AND COALESCE(manufacturedQty,0) = ?`
    ).bind(pieces, blankId, color, size, id, fromQty));
    stmts.push(db.prepare(`UPDATE blank_sizes SET quantity = quantity - ? WHERE blankId = ? AND color = ? AND size = ? AND ${stillAt}`)
      .bind(pieces, blankId, color, size, id, fromQty));
  }
  stmts.push(db.prepare("UPDATE order_items SET manufacturedQty = ? WHERE id = ? AND cancelDate IS NULL AND COALESCE(manufacturedQty,0) = ?")
    .bind(toQty, id, fromQty));
  const res = await db.batch(stmts);
  const claimed = Number(res.at(-1) && res.at(-1).meta && res.at(-1).meta.changes) === 1;
  return { claimed, consumed: claimed && linked };
}

// Making the WHOLE order: consume whatever pieces each active line still has left (so calling this
// after some pieces were already made per-piece never double-consumes), and mark every active line
// fully made. Idempotent — a line with nothing remaining is skipped, and a line another request is
// finishing at the same moment is consumed by exactly one of them.
// The garment color an order line consumes stock in: a configurable line's chosen
// config.garmentColor, else '' (a classic single-color product). Used to resolve the color-aware
// product_blank_links row (migrations/0037).
function itemColor_(row) {
  const cfg = tryParse_(row.configJson, null);
  return cfg && cfg.garmentColor ? String(cfg.garmentColor) : "";
}

export async function consumeBlanksForOrder(db, orderId) {
  const { results: items } = await db.prepare(
    `SELECT id, orderId, orgId, productId, size, qty, configJson, COALESCE(manufacturedQty,0) AS manufacturedQty
     FROM order_items WHERE orderId = ? AND cancelDate IS NULL`
  ).bind(orderId).all();
  let consumed = 0;
  for (const it of items) {
    const qty = Math.max(1, Number(it.qty) || 1);
    const made = Math.max(0, Number(it.manufacturedQty) || 0);
    if (made >= qty) continue;
    if ((await makeItemPieces_(db, { ...it, color: itemColor_(it) }, made, qty)).consumed) consumed++;
  }
  return consumed;
}

// Mark ONE physical piece of a line item manufactured: consume one blank for it and bump its
// manufacturedQty. When every active line of the order has reached its qty, stamp the order-level
// orders.manufacturedAt (the "fully made" signal the rest of the app keys off). Per-piece is how
// the Run Order screen lets qty>1 lines be split across machines and finished independently.
// If a concurrent request claims the same piece first, this re-reads and makes the NEXT piece
// (both clicks meant "one more piece done"), or reports the line complete if none are left.
export async function markItemPieceManufactured(db, orderId, itemId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const item = await db.prepare(
      `SELECT id, orderId, orgId, productId, size, qty, configJson, COALESCE(manufacturedQty,0) AS manufacturedQty, cancelDate
       FROM order_items WHERE id = ? AND orderId = ?`
    ).bind(Number(itemId), orderId).first();
    if (!item) throw new Error("Line item not found");
    if (item.cancelDate) throw new Error("That line item is cancelled");
    item.color = itemColor_(item);
    const qty = Math.max(1, Number(item.qty) || 1);
    const made = Math.max(0, Number(item.manufacturedQty) || 0);
    if (made >= qty) {
      return { alreadyComplete: true, orderComplete: await maybeCompleteManufacture_(db, orderId) };
    }
    if ((await makeItemPieces_(db, item, made, made + 1)).claimed) {
      // When the last piece lands, consume the line's transfer applications once (migrations/0036).
      if (made + 1 >= qty) await consumeLineTransfersOnce_(db, orderId, Number(itemId));
      return { pieceMarked: true, orderComplete: await maybeCompleteManufacture_(db, orderId) };
    }
  }
  throw new Error("This line is being updated by another request — refresh and try again");
}

// Stamp orders.manufacturedAt once every active line is fully made; no-op (and returns false)
// while any active line still has pieces left. Idempotent — never moves an existing timestamp.
async function maybeCompleteManufacture_(db, orderId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS remaining FROM order_items
     WHERE orderId = ? AND cancelDate IS NULL AND COALESCE(manufacturedQty,0) < qty`
  ).bind(orderId).first();
  if (Number(row && row.remaining) > 0) return false;
  await db.prepare("UPDATE orders SET manufacturedAt = COALESCE(manufacturedAt, ?) WHERE orderId = ?")
    .bind(new Date().toISOString(), orderId).run();
  return true;
}

// ---- Run tracking (migrations/0030) ------------------------------------------
// A production_runs row is one physical piece actually run on a machine, with start/finish times.
// A running row (status='running') is the sole source of truth for "piece in progress" AND
// "machine busy". machineName/designName/abortReasonLabel are snapshotted so the report survives a
// later rename/delete. Abort reasons are a tiny managed list, same shape as hoops.

function parseAbortReason_(r) {
  return { id: Number(r.id), label: r.label || "", sortOrder: Number(r.sortOrder) || 0 };
}

export async function listAbortReasons(db) {
  const { results } = await db.prepare("SELECT * FROM run_abort_reasons ORDER BY sortOrder, label").all();
  return results.map(parseAbortReason_);
}

export async function createAbortReason(db, fields) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    "INSERT INTO run_abort_reasons (label, sortOrder, createdAt, updatedAt) VALUES (?, ?, ?, ?)"
  ).bind(String(fields.label || "").slice(0, 100), Number(fields.sortOrder) || 0, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateAbortReason(db, id, fields) {
  await db.prepare("UPDATE run_abort_reasons SET label=?, sortOrder=?, updatedAt=? WHERE id=?")
    .bind(String(fields.label || "").slice(0, 100), Number(fields.sortOrder) || 0, new Date().toISOString(), Number(id)).run();
}

// Always safe to delete — runs snapshot abortReasonLabel, so no row depends on the id surviving.
export async function deleteAbortReason(db, id) {
  await db.prepare("DELETE FROM run_abort_reasons WHERE id=?").bind(Number(id)).run();
}

// The running runs right now, for the Run Order screen: which piece is in progress and which
// machines are therefore busy. Newest first.
export async function listActiveRuns(db) {
  const { results } = await db.prepare(
    `SELECT * FROM production_runs WHERE status='running' ORDER BY startedAt DESC, id DESC`
  ).all();
  return results.map(r => ({
    runId: Number(r.id), orgId: r.orgId, orderId: r.orderId, itemId: Number(r.itemId),
    machineId: r.machineId == null ? null : Number(r.machineId), machineName: r.machineName || "",
    designId: r.designId == null ? null : Number(r.designId), designName: r.designName || "", startedAt: r.startedAt,
    pieceNo: r.pieceNo == null ? null : Number(r.pieceNo), stepNo: r.stepNo == null ? null : Number(r.stepNo),
    stepCount: r.stepCount == null ? null : Number(r.stepCount), stepLabel: r.stepLabel || "",
    hoopId: r.hoopId == null ? null : Number(r.hoopId),
  }));
}

// Snapshots the machine + current design (same joins getProductionQueue uses) and opens a running
// run. Refuses if the machine is already running a job, or if the line has no piece left to start
// (every piece is already made or in progress).
// Starts one HOOPING of one piece (migrations/0032). pieceNo omitted = a new piece (its first
// hooping); otherwise the piece's next undone hooping (stepNo, if given, must be that one). With
// untimed = true the hooping is recorded as already done ("Mark done (no timing)") and kept out of
// the timing report. Snapshots the machine, the hooping's design (or order-specific design) and
// hoop; the machine's mounted hoop is updated to the one used. Returns {runId, pieceNo, stepNo}.
export async function startHooping(db, { orgId, orderId, itemId, machineId, pieceNo, stepNo, hoopId, untimed = false }) {
  const item = await db.prepare(
    `SELECT id, orgId, orderId, productId, qty, COALESCE(manufacturedQty,0) AS manufacturedQty, cancelDate
     FROM order_items WHERE id=? AND orderId=?`
  ).bind(Number(itemId), orderId).first();
  if (!item) throw new Error("Line item not found");
  if (item.cancelDate) throw new Error("That line item is cancelled");
  machineId = machineId == null || machineId === "" ? null : Number(machineId);
  if (machineId && !untimed) {
    const busy = await db.prepare("SELECT COUNT(*) n FROM production_runs WHERE machineId=? AND status='running'").bind(machineId).first();
    if (Number(busy && busy.n) > 0) throw new Error("That machine is already running a job");
  }
  const steps = await itemHoopings_(db, Number(itemId));
  if (!steps) return legacyStartRun_(db, { orgId, orderId, itemId, machineId }); // pre-0032 database
  const { results: runs } = await db.prepare(
    "SELECT id, pieceNo, stepNo, status FROM production_runs WHERE itemId=? AND status IN ('running','done')").bind(Number(itemId)).all();
  const qty = Math.max(1, Number(item.qty) || 1), made = Math.max(0, Number(item.manufacturedQty) || 0);
  const { pieces } = pieceStates_(runs, steps.length);
  if (pieceNo == null || pieceNo === "") {
    if (made + pieces.length >= qty) throw new Error("Every piece of this line is already started or made");
    const maxNo = runs.reduce((m, r) => Math.max(m, Number(r.pieceNo) || 0), made);
    pieceNo = maxNo + 1;
    if (stepNo != null && Number(stepNo) !== 1) throw new Error("A new piece starts with hooping 1");
    stepNo = 1;
  } else {
    pieceNo = Number(pieceNo);
    const p = pieces.find(x => x.pieceNo === pieceNo);
    if (!p) throw new Error("That piece is already finished");
    if (p.running) throw new Error("That piece is already running a hooping");
    if (stepNo != null && Number(stepNo) !== p.nextStepNo) throw new Error(`Hooping ${p.nextStepNo} of this piece is next`);
    stepNo = p.nextStepNo;
  }
  const step = steps[stepNo - 1];
  if (!step) throw new Error("No such hooping");
  if (step.blocked) throw new Error(step.blocked);
  // The hoop: one of the hooping's hoops — the requested one, else what's mounted, else the first
  // the machine supports.
  let machine = null;
  if (machineId) machine = await db.prepare("SELECT id, name, currentHoopId FROM machines WHERE id=?").bind(machineId).first();
  hoopId = hoopId == null || hoopId === "" ? null : Number(hoopId);
  if (hoopId && step.hoopIds.length && !step.hoopIds.includes(hoopId)) throw new Error("That hoop isn't one of this hooping's hoops");
  if (!hoopId && step.hoopIds.length) {
    const supported = machineId ? (await db.prepare("SELECT hoopId FROM machine_hoops WHERE machineId=?").bind(machineId).all()).results.map(r => Number(r.hoopId)) : [];
    hoopId = (machine && step.hoopIds.includes(Number(machine.currentHoopId)) ? Number(machine.currentHoopId) : null)
      || step.hoopIds.find(h => supported.includes(h)) || step.hoopIds[0];
  }
  const now = new Date().toISOString();
  let r;
  try {
    r = await db.prepare(
      `INSERT INTO production_runs (orgId, orderId, itemId, machineId, machineName, designId, designVersionId, designName, startedAt, finishedAt, status, createdAt,
         pieceNo, stepNo, stepCount, stepLabel, hoopId, itemDesignId, timed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(item.orgId, orderId, Number(itemId), machineId, (machine && machine.name) || "", step.designId, step.versionId,
      step.designName || "", now, untimed ? now : null, untimed ? "done" : "running", now,
      pieceNo, stepNo, steps.length, step.label || "", hoopId, step.itemDesignId, untimed ? 0 : 1).run();
  } catch (e) {
    // Two Starts at the same moment can both pass the checks above; the unique indexes reject the
    // second (one running job per machine, 0031; one running/done row per piece hooping, 0032).
    if (!/UNIQUE constraint failed/i.test(String(e && e.message))) throw e;
    if (machineId && !untimed) {
      const busy = await db.prepare("SELECT COUNT(*) n FROM production_runs WHERE machineId=? AND status='running'").bind(machineId).first();
      if (Number(busy && busy.n) > 0) throw new Error("That machine is already running a job");
    }
    throw new Error("That hooping was just started or finished — refresh");
  }
  if (machineId && hoopId) await db.prepare("UPDATE machines SET currentHoopId=?, updatedAt=? WHERE id=?").bind(hoopId, now, machineId).run().catch(() => {});
  return { runId: Number(r.meta && r.meta.last_row_id) || 0, pieceNo, stepNo, stepCount: steps.length };
}

// Kept for callers that start "the next piece" without knowing about hoopings: returns the runId.
export async function startProductionRun(db, args) {
  const r = await startHooping(db, args);
  return typeof r === "number" ? r : r.runId;
}

async function legacyStartRun_(db, { orgId, orderId, itemId, machineId }) {
  const item = await db.prepare("SELECT orgId, qty, COALESCE(manufacturedQty,0) AS manufacturedQty FROM order_items WHERE id=?").bind(Number(itemId)).first();
  const running = await db.prepare("SELECT COUNT(*) n FROM production_runs WHERE itemId=? AND status='running'").bind(Number(itemId)).first();
  if (Number(item.manufacturedQty) + Number(running && running.n || 0) >= Math.max(1, Number(item.qty) || 1)) throw new Error("Every piece of this line is already started or made");
  const now = new Date().toISOString();
  const r = await db.prepare(
    "INSERT INTO production_runs (orgId, orderId, itemId, machineId, machineName, designName, startedAt, status, createdAt) VALUES (?, ?, ?, ?, '', '', ?, 'running', ?)"
  ).bind(item.orgId, orderId, Number(itemId), machineId, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

// After a hooping is recorded done: when it was the piece's last, the piece is made (consumes its
// blank, may finish the order). Returns {pieceComplete, orderComplete, nextStepNo}.
async function afterHoopingDone_(db, run) {
  if (run.pieceNo == null) {
    const res = await markItemPieceManufactured(db, run.orderId, Number(run.itemId));
    return { pieceComplete: true, orderComplete: !!res.orderComplete, nextStepNo: null };
  }
  const { results } = await db.prepare(
    "SELECT DISTINCT stepNo FROM production_runs WHERE itemId=? AND pieceNo=? AND status='done'").bind(Number(run.itemId), Number(run.pieceNo)).all();
  const done = results.map(r => Number(r.stepNo));
  const total = Math.max(1, Number(run.stepCount) || 1);
  if (done.length >= total) {
    const res = await markItemPieceManufactured(db, run.orderId, Number(run.itemId));
    return { pieceComplete: true, orderComplete: !!res.orderComplete, nextStepNo: null };
  }
  let next = 1; while (done.includes(next)) next++;
  return { pieceComplete: false, orderComplete: false, nextStepNo: next, stepCount: total };
}

// "Mark done (no timing)" for one hooping: recorded done at once (timed = 0), then as above.
export async function markHoopingDone(db, args) {
  const started = await startHooping(db, Object.assign({}, args, { untimed: true }));
  return Object.assign({ pieceNo: started.pieceNo, stepNo: started.stepNo },
    await afterHoopingDone_(db, { orderId: args.orderId, itemId: args.itemId, pieceNo: started.pieceNo, stepCount: started.stepCount }));
}

// ---- Issues noted when a timed run is finished (migrations/0046) --------------------------------
// The fixed list the Run Order prompt offers, in the order shown. Each can happen more than once in
// a run, so each carries a count. "other" comes with a free-text note.
export const RUN_ISSUE_KINDS = [
  { key: "threadBreak", label: "Thread break" },
  { key: "bobbinOut", label: "Bobbin ran out" },
  { key: "birdsNest", label: "Bird's nest" },
  { key: "needleBreak", label: "Needle break" },
  { key: "needleReplaced", label: "Needle replaced" },
  { key: "other", label: "Other" },
];
const RUN_ISSUE_MAX_ = 99;
// Tidies what the prompt sends → { issues: {key: count ≥ 1}, note }. Unknown kinds and counts
// below 1 are dropped; a note typed without ticking Other still counts as one "other".
export function cleanRunIssues(raw, rawNote) {
  const issues = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  for (const k of RUN_ISSUE_KINDS) {
    const n = Math.floor(Number(src[k.key]));
    if (Number.isFinite(n) && n >= 1) issues[k.key] = Math.min(RUN_ISSUE_MAX_, n);
  }
  const note = String(rawNote == null ? "" : rawNote).replace(/\s+/g, " ").trim().slice(0, 500);
  if (note && !issues.other) issues.other = 1;
  return { issues, note };
}
// "Thread break ×3, Bobbin ran out" — for the audit log and anywhere a one-line summary is wanted.
export function runIssuesText(issues) {
  return RUN_ISSUE_KINDS.filter(k => issues && issues[k.key]).map(k => k.label + (issues[k.key] > 1 ? " ×" + issues[k.key] : "")).join(", ");
}
const avgRun_ = (rows) => { const ms = rows.map(r => Math.max(0, Date.parse(r.finishedAt) - Date.parse(r.startedAt))).filter(Number.isFinite);
  return { runs: ms.length, avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0 }; };
// What the finish prompt shows at the top: when this run started, and how long this design usually
// takes — on the machine it's running on, and on any machine (timed, finished runs only).
export async function getRunStats(db, runId) {
  const run = await db.prepare("SELECT id, status, startedAt, designId, designName, machineId, machineName, stepLabel FROM production_runs WHERE id=?").bind(Number(runId)).first();
  if (!run) throw new Error("Run not found");
  let rows = [];
  if (run.designId != null) {
    rows = (await db.prepare(
      `SELECT machineId, startedAt, finishedAt FROM production_runs
       WHERE designId = ? AND status = 'done' AND finishedAt IS NOT NULL AND COALESCE(timed, 1) = 1 AND id <> ?`).bind(Number(run.designId), Number(run.id)).all()).results || [];
  }
  return {
    runId: Number(run.id), status: run.status, startedAt: run.startedAt, designName: run.designName || "", machineName: run.machineName || "", stepLabel: run.stepLabel || "",
    onMachine: avgRun_(rows.filter(r => run.machineId != null && Number(r.machineId) === Number(run.machineId))),
    allMachines: avgRun_(rows),
  };
}

// `opts` (all optional): issues + issueNote = what the operator ticked in the finish prompt
// (cleanRunIssues); finishedAt = when they pressed Mark done — the prompt takes a few seconds to
// fill in, and that time isn't run time. It's only trusted between the run's start and now.
export async function completeProductionRun(db, runId, opts = {}) {
  const run = await db.prepare("SELECT id, orderId, itemId, status, pieceNo, stepNo, stepCount, startedAt FROM production_runs WHERE id=?").bind(Number(runId)).first();
  if (!run) throw new Error("Run not found");
  if (run.status !== "running") throw new Error("That job is not running");
  const { issues, note } = cleanRunIssues(opts.issues, opts.issueNote);
  const now = Date.now(), asked = Date.parse(opts.finishedAt || ""), started = Date.parse(run.startedAt);
  const finishedAt = new Date(Number.isFinite(asked) && asked <= now + 5000 && (!Number.isFinite(started) || asked >= started) ? Math.min(asked, now) : now).toISOString();
  // Guarded: only the request that actually flips running → done goes on, so a double-clicked
  // "Mark done" (or two tabs) can't count one hooping — or one piece — twice.
  const flip = await db.prepare("UPDATE production_runs SET finishedAt=?, status='done', issuesJson=?, issueNote=? WHERE id=? AND status='running'")
    .bind(finishedAt, JSON.stringify(issues), note, Number(runId)).run();
  if (Number(flip && flip.meta && flip.meta.changes) !== 1) throw new Error("That job is not running");
  return Object.assign({ pieceNo: run.pieceNo == null ? null : Number(run.pieceNo), stepNo: run.stepNo == null ? null : Number(run.stepNo), issues, issueNote: note, finishedAt },
    await afterHoopingDone_(db, run));
}

export async function abortProductionRun(db, runId, { abortReasonId, abortNote } = {}) {
  const run = await db.prepare("SELECT id, status FROM production_runs WHERE id=?").bind(Number(runId)).first();
  if (!run) throw new Error("Run not found");
  if (run.status !== "running") throw new Error("That job is not running");
  let label = "";
  if (abortReasonId != null && abortReasonId !== "") {
    const rr = await db.prepare("SELECT label FROM run_abort_reasons WHERE id=?").bind(Number(abortReasonId)).first();
    label = (rr && rr.label) || "";
  }
  await db.prepare("UPDATE production_runs SET finishedAt=?, status='aborted', abortReasonId=?, abortReasonLabel=?, abortNote=? WHERE id=?")
    .bind(new Date().toISOString(), abortReasonId != null && abortReasonId !== "" ? Number(abortReasonId) : null,
      label, String(abortNote || "").slice(0, 500), Number(runId)).run();
}

// Run-time report grouped by design (with a per-machine breakdown), over DONE runs in the range,
// plus a detailed log of every run (done + aborted) in range. Durations in ms.
// Issues (migrations/0046): each design and each of its machines carries `issues` — the total count
// of every kind noted on its runs — and `runsWithIssues`; `issueTotals` is the same across the whole
// range; each log row has its own `issues` / `issueNote`; `otherNotes` lists the free-text details.
export async function getRunReportByDesign(db, { from, to } = {}) {
  const lo = from ? String(from) : "0000";
  const hi = to ? String(to) + "T23:59:59.999Z" : "9999";
  const { results: done } = await db.prepare(
    `SELECT designId, designName, orgId, machineName, startedAt, finishedAt, issuesJson
     FROM production_runs WHERE status='done' AND finishedAt IS NOT NULL AND startedAt >= ? AND startedAt <= ?
       AND COALESCE(timed, 1) = 1`
  ).bind(lo, hi).all();
  const { results: aborted } = await db.prepare(
    "SELECT designId, designName FROM production_runs WHERE status='aborted' AND startedAt >= ? AND startedAt <= ?"
  ).bind(lo, hi).all();
  const dur = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a));
  const byDesign = new Map();
  const keyOf = (r) => (r.designId == null ? "none" : String(r.designId));
  const ensure = (r) => {
    const k = keyOf(r);
    if (!byDesign.has(k)) byDesign.set(k, { designId: r.designId == null ? null : Number(r.designId),
      designName: r.designName || "(no design)", runs: 0, totalMs: 0, abortedCount: 0, issues: {}, runsWithIssues: 0, _byMachine: new Map() });
    return byDesign.get(k);
  };
  const issuesOf = (r) => cleanRunIssues(tryParse_(r.issuesJson, {}), "").issues;
  const addIssues = (into, issues) => { for (const k of Object.keys(issues)) into[k] = (into[k] || 0) + issues[k]; };
  const issueTotals = {};
  let runsWithIssues = 0;
  for (const r of done) {
    const g = ensure(r); const ms = dur(r.startedAt, r.finishedAt);
    g.runs++; g.totalMs += ms;
    const mk = r.machineName || "(unassigned)";
    const mm = g._byMachine.get(mk) || { machineName: mk, runs: 0, totalMs: 0, issues: {}, runsWithIssues: 0 };
    mm.runs++; mm.totalMs += ms; g._byMachine.set(mk, mm);
    const issues = issuesOf(r);
    if (Object.keys(issues).length) {
      addIssues(g.issues, issues); addIssues(mm.issues, issues); addIssues(issueTotals, issues);
      g.runsWithIssues++; mm.runsWithIssues++; runsWithIssues++;
    }
  }
  for (const r of aborted) ensure(r).abortedCount++;
  const designs = [...byDesign.values()].map(g => ({
    designId: g.designId, designName: g.designName, runs: g.runs, totalMs: g.totalMs,
    avgMs: g.runs ? Math.round(g.totalMs / g.runs) : 0, abortedCount: g.abortedCount,
    issues: g.issues, runsWithIssues: g.runsWithIssues,
    byMachine: [...g._byMachine.values()].map(m => ({ machineName: m.machineName, runs: m.runs,
      totalMs: m.totalMs, avgMs: m.runs ? Math.round(m.totalMs / m.runs) : 0, issues: m.issues, runsWithIssues: m.runsWithIssues }))
      .sort((a, b) => b.runs - a.runs),
  })).sort((a, b) => b.runs - a.runs);
  const { results: detailRows } = await db.prepare(
    `SELECT pr.id AS runId, pr.designName, pr.machineName, pr.orgId, org.name AS orgName, pr.orderId,
            pr.startedAt, pr.finishedAt, pr.status, pr.abortReasonLabel, pr.abortNote, pr.stepLabel, pr.issuesJson, pr.issueNote
     FROM production_runs pr LEFT JOIN orgs org ON org.orgId = pr.orgId
     WHERE pr.startedAt >= ? AND pr.startedAt <= ? AND COALESCE(pr.timed, 1) = 1 ORDER BY pr.startedAt DESC, pr.id DESC`
  ).bind(lo, hi).all();
  const detail = detailRows.map(r => ({
    runId: Number(r.runId), designName: r.designName || "(no design)", machineName: r.machineName || "(unassigned)",
    orgName: r.orgName || r.orgId, orderId: r.orderId, startedAt: r.startedAt, finishedAt: r.finishedAt || "",
    status: r.status, durationMs: r.finishedAt ? dur(r.startedAt, r.finishedAt) : null,
    abortReasonLabel: r.abortReasonLabel || "", abortNote: r.abortNote || "", stepLabel: r.stepLabel || "",
    issues: r.status === "done" ? issuesOf(r) : {}, issueNote: r.status === "done" ? (r.issueNote || "") : "",
  }));
  // The free-text "other" details, newest first — the list at the bottom of the report.
  const otherNotes = detail.filter(x => x.issueNote).map(x => ({ runId: x.runId, startedAt: x.startedAt, designName: x.designName, machineName: x.machineName,
    orgName: x.orgName, orderId: x.orderId, stepLabel: x.stepLabel, count: x.issues.other || 1, note: x.issueNote }));
  return { designs, detail, issueKinds: RUN_ISSUE_KINDS, issueTotals, runsWithIssues, doneRuns: done.length, otherNotes };
}

// ---- Catch-up: use blanks for orders that were made before stock was tracked ----
// An order line qualifies when its product/size is linked to a blank, the order is real and
// already made (manufactured, shipped or delivered) and the line has no real cost yet
// (none at all, or only the estimate the tracking migration gave it). Each is dated when the order
// was made and priced at the weighted-average cost the blank had THEN, by replaying the movement
// history in date order — so backdated receipts count. The plan is computed the same way for the
// preview and for the apply, so what you approve is what gets written.
export async function planBlankCatchUp(db) {
  // The link is resolved by the item's color too (migrations/0037): a configurable line's
  // config.garmentColor, else '' for a classic product.
  const ITEM_COLOR_SQL = "(CASE WHEN i.configJson LIKE '{%' THEN COALESCE(json_extract(i.configJson,'$.garmentColor'),'') ELSE '' END)";
  const { results: cands } = await db.prepare(
    `SELECT i.id AS itemId, i.orderId, i.orgId, i.name, i.size, i.qty, i.cogsCents, i.cogsSource,
            l.blankId, l.blankColor, l.blankSize, o.customerName,
            COALESCE(o.manufacturedAt, o.shippedAt, o.deliveredAt) AS useDate
     FROM order_items i
     JOIN orders o ON o.orderId = i.orderId
     JOIN product_blank_links l ON l.orgId = i.orgId AND l.productId = i.productId
            AND l.productColor = ${ITEM_COLOR_SQL} AND l.productSize = i.size
     WHERE i.cancelDate IS NULL AND o.voidedAt IS NULL AND o.isTest = 0
       AND COALESCE(o.manufacturedAt, o.shippedAt, o.deliveredAt) IS NOT NULL
       AND (i.cogsCents IS NULL OR i.cogsSource = 'estimate')
     ORDER BY useDate, i.id`).all();
  if (!cands.length) return { lines: [], totalUnits: 0, totalCents: 0, replacedEstimateCents: 0, shortLines: 0 };
  const { results: mv } = await db.prepare(
    "SELECT id, blankId, color, size, qtyDelta, unitCostCents, kind, occurredAt FROM inventory_movements WHERE voidedAt IS NULL ORDER BY occurredAt, id").all();
  const { results: cur } = await db.prepare("SELECT blankId, color, size, purchasePriceCents FROM blank_sizes").all();
  const curAvg = new Map(cur.map(r => [r.blankId + "|" + (r.color || "") + "|" + r.size, Number(r.purchasePriceCents) || 0]));
  const { results: names } = await db.prepare("SELECT id, name FROM blanks").all();
  const blankNames = new Map(names.map(r => [Number(r.id), r.name]));

  const byKey = new Map();
  const bucket = (k) => { if (!byKey.has(k)) byKey.set(k, []); return byKey.get(k); };
  for (const m of mv) bucket(m.blankId + "|" + (m.color || "") + "|" + m.size).push({ at: m.occurredAt, order: 0, id: Number(m.id), d: Number(m.qtyDelta), cost: Number(m.unitCostCents), kind: m.kind });
  for (const c of cands) bucket(c.blankId + "|" + (c.blankColor || "") + "|" + (c.blankSize || "")).push({ at: c.useDate, order: 1, id: Number(c.itemId), cand: c });

  const lines = [];
  for (const [key, seq] of byKey) {
    seq.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.id - b.id);
    let qty = 0, avg = 0;
    for (const e of seq) {
      if (!e.cand) {
        if (e.d > 0 && (e.kind === "purchase" || e.kind === "adjust")) { const on = Math.max(0, qty); avg = Math.round((on * avg + e.d * e.cost) / (on + e.d)); }
        qty += e.d;
        continue;
      }
      const c = e.cand, q = Math.max(1, Number(c.qty) || 1);
      let unit = avg, costNote = "";
      if (!unit) { unit = curAvg.get(key) || 0; costNote = unit ? "no purchase yet on that date — used the blank's current cost" : "no cost known for this blank size"; }
      const before = qty; qty -= q;
      lines.push({ itemId: Number(c.itemId), orderId: c.orderId, orgId: c.orgId, customerName: c.customerName, name: c.name, size: c.size || "", qty: q,
        blankId: Number(c.blankId), blankColor: c.blankColor || "", blankSize: c.blankSize || "", blankName: blankNames.get(Number(c.blankId)) || "", useDate: c.useDate,
        unitCostCents: unit, costCents: unit * q, costNote,
        shortBy: Math.max(0, Math.min(q, q - Math.max(0, before))), oldCostCents: c.cogsCents == null ? null : Number(c.cogsCents), oldSource: c.cogsSource || "" });
    }
  }
  lines.sort((a, b) => a.useDate < b.useDate ? -1 : a.useDate > b.useDate ? 1 : a.itemId - b.itemId);
  return { lines, totalUnits: lines.reduce((t, l) => t + l.qty, 0), totalCents: lines.reduce((t, l) => t + l.costCents, 0),
    replacedEstimateCents: lines.reduce((t, l) => t + (l.oldCostCents || 0), 0), shortLines: lines.filter(l => l.shortBy > 0).length };
}

// Writes the planned lines for the chosen items: a dated "consume" movement, stock down, real cost on the line.
// Re-planned here (not trusted from the browser); already-done lines no longer qualify, so it's idempotent.
export async function applyBlankCatchUp(db, itemIds) {
  const want = new Set((itemIds || []).map(Number));
  const plan = await planBlankCatchUp(db);
  const chosen = plan.lines.filter(l => want.has(l.itemId));
  for (const l of chosen) {
    await insertMovement_(db, { blankId: l.blankId, blankName: l.blankName, color: l.blankColor, size: l.blankSize, qtyDelta: -l.qty, unitCostCents: l.unitCostCents,
      kind: "consume", orderId: l.orderId, itemId: l.itemId, note: "Used for order " + l.orderId + " (catch-up)", occurredAt: l.useDate });
    await db.prepare("UPDATE blank_sizes SET quantity = quantity - ? WHERE blankId=? AND color=? AND size=?").bind(l.qty, l.blankId, l.blankColor || "", l.blankSize).run();
    await db.prepare("UPDATE order_items SET cogsCents = ?, cogsSource = 'consumed' WHERE id = ? AND (cogsCents IS NULL OR cogsSource = 'estimate')")
      .bind(l.costCents, l.itemId).run();
  }
  return { applied: chosen, totalUnits: chosen.reduce((t, l) => t + l.qty, 0), totalCents: chosen.reduce((t, l) => t + l.costCents, 0) };
}

export async function getBlankMovements(db, blankId) {
  const { results } = await db.prepare(
    "SELECT * FROM inventory_movements WHERE blankId=? ORDER BY occurredAt DESC, id DESC LIMIT 500"
  ).bind(Number(blankId)).all();
  return results.map(r => ({ id: Number(r.id), color: r.color || "", size: r.size, qtyDelta: Number(r.qtyDelta), unitCost: fromCents(r.unitCostCents),
    kind: r.kind, orderId: r.orderId || "", vendor: r.vendor || "", vendorRef: r.vendorRef || "", note: r.note || "", occurredAt: r.occurredAt,
    receiptKey: r.receiptKey || "", receiptName: r.receiptName || "", voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" }));
}

// Recomputes blank_sizes.quantity/purchasePriceCents for one blank+size from its
// non-voided movement history (same weighted-average algorithm as
// getInventoryValuation) — the only correct way to reflect a void, since a movement
// in the middle of the history can change every average after it.
async function recomputeBlankSizeFromHistory_(db, blankId, color, size) {
  const { results } = await db.prepare(
    "SELECT qtyDelta, unitCostCents, kind FROM inventory_movements WHERE blankId=? AND color=? AND size=? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(Number(blankId), String(color || ""), size).all();
  let qty = 0, avg = 0;
  for (const m of results) {
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, qty);
      avg = Math.round((onHand * avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    qty += d;
  }
  await db.prepare(
    `INSERT INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(blankId, color, size) DO UPDATE SET purchasePriceCents = excluded.purchasePriceCents, quantity = excluded.quantity`
  ).bind(Number(blankId), String(color || ""), size, avg, qty).run();
}

export async function getInventoryMovementById(db, id) {
  const r = await db.prepare("SELECT * FROM inventory_movements WHERE id=?").bind(Number(id)).first();
  if (!r) return null;
  return { id: Number(r.id), blankId: Number(r.blankId), blankName: r.blankName, color: r.color || "", size: r.size, qtyDelta: Number(r.qtyDelta),
    unitCost: fromCents(r.unitCostCents), kind: r.kind, orderId: r.orderId || "", vendor: r.vendor || "", vendorRef: r.vendorRef || "",
    note: r.note || "", occurredAt: r.occurredAt, voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" };
}

// Voids a mistaken inventory movement (a duplicate receive, a wrong cost/date/vendor) —
// stays in history, struck through, excluded from stock and every report, same pattern
// as voidOrder/voidPayment. Only purchase/adjust/writeoff rows can be voided here — a
// 'consume' row is system-generated from an order's own fulfillment and is corrected by
// editing that order instead. Recomputes the blank+size's stock/average cost from what's
// left. Returns the movement (pre-void) for the caller to audit, or null if not found/
// already voided/wrong kind.
export async function voidInventoryMovement(db, id, reason) {
  const row = await db.prepare("SELECT * FROM inventory_movements WHERE id=?").bind(Number(id)).first();
  if (!row || row.voidedAt || !["purchase", "adjust", "writeoff"].includes(row.kind)) return null;
  await db.prepare("UPDATE inventory_movements SET voidedAt=?, voidReason=? WHERE id=? AND voidedAt IS NULL")
    .bind(new Date().toISOString(), String(reason || "").slice(0, 300), Number(id)).run();
  await recomputeBlankSizeFromHistory_(db, row.blankId, row.color || "", row.size);
  return row;
}

// Why a voided entry can't be restored right now, or "" if it can. Only purchase/adjust/writeoff rows
// can be voided, so only those can be restored. A restored entry that TAKES stock out (a write-off, a
// downward adjustment) is refused when that would leave less than zero on hand — the stock was
// probably counted again while it was voided, and restoring would take the same pieces out twice.
export async function getInventoryRestoreBlocker(db, row) {
  if (!row) return "Entry not found";
  if (!row.voidedAt) return "That entry isn't voided";
  if (!["purchase", "adjust", "writeoff"].includes(row.kind)) return "This entry was generated automatically (from an order) and was never voidable.";
  const delta = Number(row.qtyDelta);
  if (delta < 0) {
    const cur = await db.prepare("SELECT quantity FROM blank_sizes WHERE blankId=? AND color=? AND size=?")
      .bind(Number(row.blankId), String(row.color || ""), row.size).first();
    const onHand = cur ? Number(cur.quantity) : 0;
    if (onHand + delta < 0) {
      return `Restoring this would take ${-delta} out of stock but only ${onHand} ${onHand === 1 ? "is" : "are"} on hand now (it would go below zero).`;
    }
  }
  return "";
}

// Undoes a void: the entry counts toward stock, average cost and every report again, and the
// blank+size is recomputed from the full history (a movement in the middle changes every average
// cost after it, so this is the same recompute a void does). Returns the entry (as it was while
// voided) for the caller to audit, or null if it can't be restored (see getInventoryRestoreBlocker).
export async function restoreInventoryMovement(db, id) {
  const row = await db.prepare("SELECT * FROM inventory_movements WHERE id=?").bind(Number(id)).first();
  if (await getInventoryRestoreBlocker(db, row)) return null;
  const r = await db.prepare("UPDATE inventory_movements SET voidedAt=NULL, voidReason='' WHERE id=? AND voidedAt IS NOT NULL")
    .bind(Number(id)).run();
  if (!((r.meta && r.meta.changes) > 0)) return null; // someone else restored it first
  await recomputeBlankSizeFromHistory_(db, row.blankId, row.color || "", row.size);
  return row;
}

// Inventory on hand and its value at the END of a given moment (ISO), from
// the movement history, using a running weighted-average cost per blank/size.
// (Schedule C Part III: beginning and ending inventory.)
export async function getInventoryValuation(db, asOf) {
  const { results } = await db.prepare(
    "SELECT blankId, blankName, color, size, qtyDelta, unitCostCents, kind FROM inventory_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(asOf).all();
  const state = new Map();
  for (const m of results) {
    const key = m.blankId + "|" + (m.color || "") + "|" + m.size;
    const st = state.get(key) || { blankId: Number(m.blankId), name: m.blankName, color: m.color || "", size: m.size, qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, st.qty);
      st.avg = Math.round((onHand * st.avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    st.qty += d;
    st.name = m.blankName || st.name;
    state.set(key, st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0)
    .map(r => ({ blankId: r.blankId, name: r.name, color: r.color, size: r.size, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg) }))
    .sort((a, b) => (a.name + a.color + a.size).localeCompare(b.name + b.color + b.size));
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0),
    value: fromCents(rows.reduce((s, r) => s + toCents(r.value), 0)) };
}

// COGS for a period by month: blanks consumed (at average cost, by the
// month consumed) + estimated costs of lines manufactured before movement
// tracking (by the month manufactured), plus purchases and write-offs.
// Blanks bought for resale that the vendor charged sales tax on anyway — they
// should be bought exempt (with a resale certificate), so the tax
// is an avoidable cost / possibly refundable from the vendor.
export async function getTaxedResalePurchases(db, dateFrom, dateTo) {
  const { results } = await db.prepare(
    `SELECT occurredAt, blankName, color, size, qtyDelta, unitCostCents, vendor, vendorRef FROM inventory_movements
     WHERE kind = 'purchase' AND vendorChargedTax = 1 AND voidedAt IS NULL AND occurredAt >= ? AND occurredAt <= ? ORDER BY occurredAt`
  ).bind(dateFrom, dateTo).all();
  return results.map(r => ({ date: r.occurredAt, blank: r.blankName, color: r.color || "", size: r.size, qty: Number(r.qtyDelta),
    cost: fromCents(Number(r.qtyDelta) * Number(r.unitCostCents)), vendor: r.vendor || "", invoice: r.vendorRef || "" }));
}

export async function getCogsReport(db, dateFrom, dateTo) {
  const { results: mv } = await db.prepare(
    `SELECT substr(occurredAt, 1, 7) AS month, kind, SUM(-qtyDelta * unitCostCents) AS outCents,
            SUM(qtyDelta * unitCostCents) AS inCents, SUM(qtyDelta) AS units
     FROM inventory_movements WHERE occurredAt >= ? AND occurredAt <= ? AND kind IN ('consume', 'purchase', 'writeoff') AND voidedAt IS NULL
     GROUP BY month, kind`
  ).bind(dateFrom, dateTo).all();
  const { results: est } = await db.prepare(
    `SELECT substr(o.manufacturedAt, 1, 7) AS month, SUM(i.cogsCents) AS cents, SUM(i.qty) AS units
     FROM order_items i JOIN orders o ON o.orderId = i.orderId
     WHERE i.cogsSource = 'estimate' AND o.manufacturedAt >= ? AND o.manufacturedAt <= ? AND o.isTest = 0
     GROUP BY month`
  ).bind(dateFrom, dateTo).all();
  const { results: missing } = await db.prepare(
    `SELECT i.orderId, i.name, i.size, i.qty, i.productId, o.orgId,
            EXISTS (SELECT 1 FROM product_blank_links l WHERE l.orgId = i.orgId AND l.productId = i.productId
                      AND l.productColor = (CASE WHEN i.configJson LIKE '{%' THEN COALESCE(json_extract(i.configJson,'$.garmentColor'),'') ELSE '' END)
                      AND l.productSize = i.size) AS linkedNow
     FROM order_items i JOIN orders o ON o.orderId = i.orderId
     WHERE o.manufacturedAt >= ? AND o.manufacturedAt <= ? AND i.cancelDate IS NULL AND i.cogsCents IS NULL
       AND o.isTest = 0 AND o.voidedAt IS NULL ORDER BY o.manufacturedAt`
  ).bind(dateFrom, dateTo).all();
  const months = {};
  const at = (m) => (months[m] = months[m] || { month: m, cogs: 0, estimated: 0, unitsUsed: 0, purchases: 0, writeoffs: 0 });
  for (const r of mv) {
    const m = at(r.month);
    if (r.kind === "consume") { m.cogs += Number(r.outCents); m.unitsUsed += -Number(r.units); }
    if (r.kind === "purchase") m.purchases += Number(r.inCents);
    if (r.kind === "writeoff") m.writeoffs += Number(r.outCents);
  }
  for (const r of est) { const m = at(r.month); m.estimated += Number(r.cents); m.unitsUsed += Number(r.units); }
  const rows = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map(m => ({
    month: m.month, cogs: fromCents(m.cogs + m.estimated), estimatedPart: fromCents(m.estimated),
    unitsUsed: m.unitsUsed, purchases: fromCents(m.purchases), writeoffs: fromCents(m.writeoffs) }));
  // Why each made line has no cost: `reason` "linkedNow" (its size IS linked now — it was made before
  // the link existed; "Use blanks for past orders" fixes it), "notLinked" (link the size first) or
  // "custom" (a custom line with no product — it can't be linked to a blank).
  return { rows, missingCost: missing.map(r => ({ orderId: r.orderId, orgId: r.orgId, name: r.name, size: r.size, qty: Number(r.qty),
    reason: !r.productId || r.productId === "__custom__" ? "custom" : Number(r.linkedNow) ? "linkedNow" : "notLinked" })) };
}

// ---- Transfer-sheet inventory & COGS (migrations/0036) --------------------
// Mirrors blanks: transfers.quantity caches the transfer_movements sum (applications on hand),
// purchasePriceCents is the running weighted-average cost per application. A graphic (kind
// 'transfer') links to a transfer item; using that graphic on a made order consumes one
// application per garment at the average cost → the line's COGS (blank + transfers).

function parseTransfer_(r) {
  return { id: Number(r.id), name: r.name || "", description: r.description || "",
    orgIds: tryParse_(r.orgIdsJson, []) || [], quantity: Number(r.quantity) || 0,
    purchasePrice: fromCents(r.purchasePriceCents), visible: !!r.visible, sortOrder: Number(r.sortOrder) || 0 };
}

// All transfer items, or (with orgId) those available to that org (no org list = all orgs).
export async function listTransfers(db, orgId) {
  const { results } = await db.prepare("SELECT * FROM transfers ORDER BY sortOrder, name").all();
  let rows = results.map(parseTransfer_);
  if (orgId) rows = rows.filter(t => !t.orgIds.length || t.orgIds.includes(orgId));
  return rows;
}

export async function createTransfer(db, f) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO transfers (name, description, orgIdsJson, quantity, purchasePriceCents, visible, sortOrder, createdAt, updatedAt)
     VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`
  ).bind(String(f.name || "").slice(0, 120), String(f.description || "").slice(0, 500),
    JSON.stringify(Array.isArray(f.orgIds) ? f.orgIds : []), f.visible === false ? 0 : 1, Number(f.sortOrder) || 0, now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateTransfer(db, id, f) {
  await db.prepare("UPDATE transfers SET name=?, description=?, orgIdsJson=?, visible=?, sortOrder=?, updatedAt=? WHERE id=?")
    .bind(String(f.name || "").slice(0, 120), String(f.description || "").slice(0, 500),
      JSON.stringify(Array.isArray(f.orgIds) ? f.orgIds : []), f.visible === false ? 0 : 1, Number(f.sortOrder) || 0, new Date().toISOString(), Number(id)).run();
}

// Refused while any graphic links to it (same reference-check pattern as deleteBlank/deleteHoop).
export async function deleteTransfer(db, id) {
  const used = await db.prepare("SELECT COUNT(*) n FROM graphics WHERE transferId=?").bind(Number(id)).first().catch(() => null);
  if (used && Number(used.n) > 0) throw new Error("A graphic uses this transfer — change that first");
  // A reorder QR code points straight at its transfer (migrations/0047).
  const qrOrg = await db.prepare("SELECT COUNT(*) n FROM orgs WHERE reorderQrTransferId=?").bind(Number(id)).first().catch(() => null);
  if (qrOrg && Number(qrOrg.n) > 0) throw new Error("A shop uses this transfer as its reorder QR code — change that first (Manage catalog → the shop → Edit)");
  const qrProd = await db.prepare("SELECT COUNT(*) n FROM products WHERE reorderQr=?").bind("t" + Number(id)).first().catch(() => null);
  if (qrProd && Number(qrProd.n) > 0) throw new Error("A product uses this transfer as its reorder QR code — change that on the product first");
  await db.prepare("DELETE FROM transfers WHERE id=?").bind(Number(id)).run();
}

async function transferName_(db, id) {
  const t = await db.prepare("SELECT name FROM transfers WHERE id=?").bind(Number(id)).first();
  return t ? (t.name || "") : "";
}

function transferMovementStmt_(db, m) {
  const now = new Date().toISOString();
  return db.prepare(
    `INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, vendor, vendorRef, note, pctOfSheet, occurredAt, createdAt, accountId, paidPersonally, receiptKey, receiptName)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(Number(m.transferId), m.transferName || "", Math.trunc(m.qtyDelta), Math.max(0, Math.round(Number(m.unitCostCents) || 0)),
    m.kind, m.orderId || null, m.itemId || null, String(m.vendor || "").slice(0, 100), String(m.vendorRef || "").slice(0, 100),
    String(m.note || "").slice(0, 300), m.pctOfSheet == null ? null : Number(m.pctOfSheet), m.occurredAt || now, now,
    m.accountId ? Number(m.accountId) : null, m.paidPersonally ? 1 : 0, String(m.receiptKey || "").slice(0, 300), String(m.receiptName || "").slice(0, 200));
}

// How a transfer sheet's cost divides: each row gets its own percentage of the sheet, and the two parts
// that never become inventory — written off (an expense) and personal use (an owner draw) — get theirs.
// Whole cents that always add back up to the total exactly (largest remainder). receiveTransferSheet and
// the admin API both use this, so the cost recorded on the movements and the cost recorded for the
// other two parts can't disagree.
export const SHEET_PCT_TOLERANCE = 0.05; // percentage points of slack for typed values like 33.3 + 33.3 + 33.4
export function transferSheetShares(pcts, writeoffPct, personalPct, totalCents) {
  const wo = Math.max(0, Number(writeoffPct) || 0), pe = Math.max(0, Number(personalPct) || 0);
  const shares = spreadCents([...pcts, wo, pe], totalCents);
  return { rowCents: shares.slice(0, pcts.length), writeoffCents: shares[pcts.length], personalCents: shares[pcts.length + 1] };
}

// One transfer-sheet receipt (totalCents) split across rows by each row's percentage of the sheet;
// each row's $ is then divided across its `count` applications into whole-cent unit costs (a total
// that doesn't divide evenly becomes two unit costs a cent apart — same trick as landedCostLines).
// Each part writes a `purchase` movement and updates the item's weighted-average cost + quantity in
// one batch (atomic, race-safe), exactly like receiveBlanks. rows: [{transferId, count, pctOfSheet}].
export async function receiveTransferSheet(db, { rows, totalCents, vendor, vendorRef, receivedAt, accountId, paidPersonally, note, receiptKey, receiptName, writeoffPct = 0, personalPct = 0 }) {
  const clean = (rows || []).map(r => ({ transferId: Number(r.transferId), count: Math.floor(Number(r.count) || 0), pct: Math.max(0, Number(r.pctOfSheet) || 0) }))
    .filter(r => r.transferId && r.count > 0);
  if (!clean.length) return [];
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  // $ per row by its share of the sheet. writeoffPct / personalPct are the parts NOT put into inventory (recorded
  // by the caller as an expense / owner draw); with neither, the rows split the whole total.
  const { rowCents } = transferSheetShares(clean.map(r => r.pct), writeoffPct, personalPct, total);
  const ids = [];
  for (let i = 0; i < clean.length; i++) {
    const r = clean[i], cents = rowCents[i], base = Math.floor(cents / r.count), up = cents - base * r.count;
    const name = await transferName_(db, r.transferId);
    const parts = [];
    if (r.count - up > 0) parts.push({ qty: r.count - up, unit: base });
    if (up > 0) parts.push({ qty: up, unit: base + 1 });
    for (const p of parts) {
      const res = await db.batch([
        transferMovementStmt_(db, { transferId: r.transferId, transferName: name, qtyDelta: p.qty, unitCostCents: p.unit, kind: "purchase",
          vendor, vendorRef, note: note || "Received", pctOfSheet: r.pct, occurredAt: receivedAt,
          accountId: paidPersonally ? null : (accountId || null), paidPersonally: !!paidPersonally, receiptKey, receiptName }),
        db.prepare(
          `UPDATE transfers SET
             purchasePriceCents = CAST(ROUND((MAX(quantity, 0) * purchasePriceCents + ? * ?) * 1.0 / (MAX(quantity, 0) + ?)) AS INTEGER),
             quantity = quantity + ?, updatedAt = ? WHERE id = ?`
        ).bind(p.unit, p.qty, p.qty, p.qty, new Date().toISOString(), r.transferId),
      ]);
      ids.push(Number(res[0] && res[0].meta && res[0].meta.last_row_id) || 0);
    }
  }
  return ids;
}

export async function writeOffTransfers(db, { transferId, qty, note, occurredAt }) {
  const q = Math.floor(Number(qty) || 0);
  if (q <= 0) return;
  const cur = await db.prepare("SELECT purchasePriceCents FROM transfers WHERE id=?").bind(Number(transferId)).first();
  await db.batch([
    transferMovementStmt_(db, { transferId, transferName: await transferName_(db, transferId), qtyDelta: -q, unitCostCents: cur ? cur.purchasePriceCents : 0,
      kind: "writeoff", note: note || "Write-off", occurredAt }),
    db.prepare("UPDATE transfers SET quantity = quantity - ?, updatedAt=? WHERE id=?").bind(q, new Date().toISOString(), Number(transferId)),
  ]);
}

// Consume one application per garment of each given transfer for one line (customer-chosen options +
// the reorder QR), at the current average cost, adding to the line's COGS (blank + transfers).
// Called when a transfer application is marked made. Returns total cents added.
async function consumeTransfersForItem_(db, item, transferIds) {
  const qty = Math.max(1, Number(item.qty) || 1);
  let added = 0;
  for (const tid of (transferIds || [])) {
    if (!tid) continue;
    const t = await db.prepare("SELECT name, purchasePriceCents FROM transfers WHERE id=?").bind(Number(tid)).first();
    if (!t) continue;
    const cost = Number(t.purchasePriceCents) || 0;
    await db.batch([
      transferMovementStmt_(db, { transferId: Number(tid), transferName: t.name || "", qtyDelta: -qty, unitCostCents: cost, kind: "consume",
        orderId: item.orderId, itemId: item.id, note: "Used for order " + item.orderId, occurredAt: new Date().toISOString() }),
      db.prepare("UPDATE transfers SET quantity = quantity - ?, updatedAt=? WHERE id=?").bind(qty, new Date().toISOString(), Number(tid)),
    ]);
    added += cost * qty;
  }
  if (added > 0) await db.prepare("UPDATE order_items SET cogsCents = COALESCE(cogsCents,0) + ?, cogsSource='consumed' WHERE id=?").bind(added, Number(item.id)).run();
  return added;
}

// Consume a fully-made configurable line's transfer applications (customer options + reorder QR)
// exactly once — whichever screen completed it (embroidery Run Order hoopings OR Run Transfer
// Sheets). Idempotent (a prior consume movement for this line = already done) and a no-op on a
// pre-0036 schema. Called when a line reaches its full manufacturedQty.
async function consumeLineTransfersOnce_(db, orderId, itemId) {
  try {
    const item = await db.prepare("SELECT id, orderId, qty, configJson FROM order_items WHERE id=?").bind(Number(itemId)).first();
    const cfg = item && tryParse_(item.configJson, null);
    if (!cfg) return;
    const transferIds = (cfg.locations || []).filter(l => l.kind === "transfer" && Number(l.transferId)).map(l => Number(l.transferId));
    if (!transferIds.length) return;
    const already = await db.prepare("SELECT COUNT(*) n FROM transfer_movements WHERE itemId=? AND kind='consume'").bind(Number(itemId)).first();
    if (already && Number(already.n) > 0) return;
    await consumeTransfersForItem_(db, { id: item.id, orderId: item.orderId, qty: Math.max(1, Number(item.qty) || 1) }, transferIds);
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
}

export async function getTransferMovements(db, transferId) {
  const { results } = await db.prepare(
    "SELECT * FROM transfer_movements WHERE transferId=? ORDER BY occurredAt DESC, id DESC LIMIT 500"
  ).bind(Number(transferId)).all();
  return results.map(r => ({ id: Number(r.id), qtyDelta: Number(r.qtyDelta), unitCost: fromCents(r.unitCostCents), kind: r.kind,
    orderId: r.orderId || "", vendor: r.vendor || "", vendorRef: r.vendorRef || "", note: r.note || "", pctOfSheet: r.pctOfSheet == null ? null : Number(r.pctOfSheet),
    occurredAt: r.occurredAt, receiptKey: r.receiptKey || "", receiptName: r.receiptName || "", voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" }));
}

async function recomputeTransferFromHistory_(db, transferId) {
  const { results } = await db.prepare(
    "SELECT qtyDelta, unitCostCents, kind FROM transfer_movements WHERE transferId=? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(Number(transferId)).all();
  let qty = 0, avg = 0;
  for (const m of results) {
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, qty);
      avg = Math.round((onHand * avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    qty += d;
  }
  await db.prepare("UPDATE transfers SET quantity=?, purchasePriceCents=?, updatedAt=? WHERE id=?")
    .bind(qty, avg, new Date().toISOString(), Number(transferId)).run();
}

// Void a mistaken transfer movement (purchase/adjust/writeoff only); recompute from what's left.
export async function voidTransferMovement(db, id, reason) {
  const row = await db.prepare("SELECT * FROM transfer_movements WHERE id=?").bind(Number(id)).first();
  if (!row || row.voidedAt || !["purchase", "adjust", "writeoff"].includes(row.kind)) return null;
  await db.prepare("UPDATE transfer_movements SET voidedAt=?, voidReason=? WHERE id=? AND voidedAt IS NULL")
    .bind(new Date().toISOString(), String(reason || "").slice(0, 300), Number(id)).run();
  await recomputeTransferFromHistory_(db, row.transferId);
  return row;
}

export async function getTransferMovementById(db, id) {
  const r = await db.prepare("SELECT * FROM transfer_movements WHERE id=?").bind(Number(id)).first();
  if (!r) return null;
  return { id: Number(r.id), transferId: Number(r.transferId), transferName: r.transferName || "", qtyDelta: Number(r.qtyDelta),
    unitCost: fromCents(r.unitCostCents), kind: r.kind, orderId: r.orderId || "", vendor: r.vendor || "", vendorRef: r.vendorRef || "",
    note: r.note || "", occurredAt: r.occurredAt, voidedAt: r.voidedAt || "", voidReason: r.voidReason || "" };
}

export async function transferMovementMonth(db, id) {
  const r = await db.prepare("SELECT occurredAt FROM transfer_movements WHERE id=?").bind(Number(id)).first();
  return r ? monthOf(r.occurredAt) : "";
}

// Why a voided transfer movement can't be restored right now, or "" if it can. Same rules as blanks
// (getInventoryRestoreBlocker): only purchase/adjust/writeoff rows are voidable, so only they are
// restorable, and a restore that TAKES applications out of stock is refused when fewer are on hand.
export async function getTransferRestoreBlocker(db, row) {
  if (!row) return "Entry not found";
  if (!row.voidedAt) return "That entry isn't voided";
  if (!["purchase", "adjust", "writeoff"].includes(row.kind)) return "This entry was generated automatically (from an order) and was never voidable.";
  const delta = Number(row.qtyDelta);
  if (delta < 0) {
    const cur = await db.prepare("SELECT quantity FROM transfers WHERE id=?").bind(Number(row.transferId)).first();
    const onHand = cur ? Number(cur.quantity) : 0;
    if (onHand + delta < 0) {
      return `Restoring this would take ${-delta} out of stock but only ${onHand} ${onHand === 1 ? "is" : "are"} on hand now (it would go below zero).`;
    }
  }
  return "";
}

// Undo a transfer void: counts toward stock, average cost, valuation and COGS again (recomputed from
// the whole history, like the void). Returns the row, or null if it can't be restored.
export async function restoreTransferMovement(db, id) {
  const row = await db.prepare("SELECT * FROM transfer_movements WHERE id=?").bind(Number(id)).first();
  if (await getTransferRestoreBlocker(db, row)) return null;
  const r = await db.prepare("UPDATE transfer_movements SET voidedAt=NULL, voidReason='' WHERE id=? AND voidedAt IS NOT NULL")
    .bind(Number(id)).run();
  if (!((r.meta && r.meta.changes) > 0)) return null;
  await recomputeTransferFromHistory_(db, row.transferId);
  return row;
}

// Transfer inventory on hand + value at the end of a moment, and COGS by month — same shape as the
// blank valuation/COGS, so the Inventory & COGS report can show a Transfers section beside blanks.
export async function getTransferValuation(db, asOf) {
  const { results } = await db.prepare(
    "SELECT transferId, transferName, qtyDelta, unitCostCents, kind FROM transfer_movements WHERE occurredAt <= ? AND voidedAt IS NULL ORDER BY occurredAt, id"
  ).bind(asOf).all();
  const state = new Map();
  for (const m of results) {
    const key = String(m.transferId);
    const st = state.get(key) || { transferId: Number(m.transferId), name: m.transferName, qty: 0, avg: 0 };
    const d = Number(m.qtyDelta);
    if (d > 0 && (m.kind === "purchase" || m.kind === "adjust")) {
      const onHand = Math.max(0, st.qty);
      st.avg = Math.round((onHand * st.avg + d * Number(m.unitCostCents)) / (onHand + d));
    }
    st.qty += d; st.name = m.transferName || st.name;
    state.set(key, st);
  }
  const rows = [...state.values()].filter(r => r.qty !== 0)
    .map(r => ({ transferId: r.transferId, name: r.name, qty: r.qty, avgCost: fromCents(r.avg), value: fromCents(Math.max(0, r.qty) * r.avg) }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { asOf, rows, units: rows.reduce((s, r) => s + r.qty, 0), value: fromCents(rows.reduce((s, r) => s + toCents(r.value), 0)) };
}

export async function getTransferCogs(db, dateFrom, dateTo) {
  const { results: mv } = await db.prepare(
    `SELECT substr(occurredAt, 1, 7) AS month, kind, SUM(-qtyDelta * unitCostCents) AS outCents, SUM(qtyDelta * unitCostCents) AS inCents
     FROM transfer_movements WHERE occurredAt >= ? AND occurredAt <= ? AND kind IN ('consume', 'purchase', 'writeoff') AND voidedAt IS NULL
     GROUP BY month, kind`
  ).bind(dateFrom, dateTo).all();
  const months = {};
  const at = (m) => (months[m] = months[m] || { month: m, cogs: 0, purchases: 0, writeoffs: 0 });
  for (const r of mv) {
    const m = at(r.month);
    if (r.kind === "consume") m.cogs += Number(r.outCents);
    if (r.kind === "purchase") m.purchases += Number(r.inCents);
    if (r.kind === "writeoff") m.writeoffs += Number(r.outCents);
  }
  return Object.values(months).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ month: m.month, cogs: fromCents(m.cogs), purchases: fromCents(m.purchases), writeoffs: fromCents(m.writeoffs) }));
}

// ---- Graphics / selectable options catalog + tier prices (migrations/0036) ----
// A graphic is a customer-selectable option in a configurable product's per-location menu — either
// an embroidery design (→ designs, feeds the Run Order hooping flow) or a transfer-sheet graphic
// (→ a transfer inventory item, feeds Run Transfer Sheets). Its tier sets the add-on price from the
// org's per-org tier prices (NULL tier = $0/included).

function parseGraphic_(r) {
  return { id: Number(r.id), orgId: r.orgId, name: r.name || "", kind: r.kind === "embroidery" ? "embroidery" : "transfer",
    designId: r.designId == null ? null : Number(r.designId), transferId: r.transferId == null ? null : Number(r.transferId),
    tier: r.tier || null, inkColors: tryParse_(r.inkColorsJson, []) || [], imageUrl: r.imageUrl || "", thumbUrl: r.thumbUrl || "",
    allowedLocations: tryParse_(r.allowedLocationsJson, []) || [], allowedGarmentColors: tryParse_(r.allowedGarmentColorsJson, []) || [],
    visible: !!r.visible, sortOrder: Number(r.sortOrder) || 0 };
}

export async function listGraphics(db, orgId) {
  const { results } = await db.prepare("SELECT * FROM graphics WHERE orgId=? ORDER BY sortOrder, name").bind(orgId).all();
  return results.map(parseGraphic_);
}

export async function getGraphic(db, id) {
  const r = await db.prepare("SELECT * FROM graphics WHERE id=?").bind(Number(id)).first();
  return r ? parseGraphic_(r) : null;
}

function graphicBinds_(g) {
  return [String(g.name || "").slice(0, 120), g.kind === "embroidery" ? "embroidery" : "transfer",
    g.designId == null || g.designId === "" ? null : Number(g.designId),
    g.transferId == null || g.transferId === "" ? null : Number(g.transferId),
    g.tier && ["small", "medium", "large"].includes(g.tier) ? g.tier : null,
    JSON.stringify(Array.isArray(g.inkColors) ? g.inkColors : []),
    String(g.imageUrl || "").slice(0, 600), String(g.thumbUrl || "").slice(0, 600),
    JSON.stringify(Array.isArray(g.allowedLocations) ? g.allowedLocations : []),
    JSON.stringify(Array.isArray(g.allowedGarmentColors) ? g.allowedGarmentColors : []),
    g.visible === false ? 0 : 1, Number(g.sortOrder) || 0];
}

export async function createGraphic(db, orgId, g) {
  const now = new Date().toISOString();
  const r = await db.prepare(
    `INSERT INTO graphics (orgId, name, kind, designId, transferId, tier, inkColorsJson, imageUrl, thumbUrl,
       allowedLocationsJson, allowedGarmentColorsJson, visible, sortOrder, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(orgId, ...graphicBinds_(g), now, now).run();
  return Number(r.meta && r.meta.last_row_id) || 0;
}

export async function updateGraphic(db, id, g) {
  await db.prepare(
    `UPDATE graphics SET name=?, kind=?, designId=?, transferId=?, tier=?, inkColorsJson=?, imageUrl=?, thumbUrl=?,
       allowedLocationsJson=?, allowedGarmentColorsJson=?, visible=?, sortOrder=?, updatedAt=? WHERE id=?`
  ).bind(...graphicBinds_(g), new Date().toISOString(), Number(id)).run();
}

// Switch a graphic off (or back on) for ONE color of ONE product — the mockup table's "don't offer
// this combination" (migrations/0050). Per product because a color name is the blank vendor's label.
// Kept apart from updateProduct so a caller that doesn't know the list can't clear it.
export async function setProductGraphicColorBlocked(db, orgId, productId, graphicId, color, blocked) {
  const row = await db.prepare("SELECT blockedGraphicColorsJson FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();
  if (!row) throw new Error("Product not found");
  const gid = Number(graphicId), c = String(color || "").trim().slice(0, 120);
  if (!gid || !c) throw new Error("A graphic and a color are required");
  const list = (tryParse_(row.blockedGraphicColorsJson, []) || []).filter(b => !(Number(b.graphicId) === gid && b.color === c));
  if (blocked) list.push({ graphicId: gid, color: c });
  await db.prepare("UPDATE products SET blockedGraphicColorsJson=?, updatedAt=? WHERE orgId=? AND productId=?").bind(JSON.stringify(list), new Date().toISOString(), orgId, productId).run();
  return list;
}

// Refused while a product's location menu or an org's reorder-QR default references it.
export async function deleteGraphic(db, id) {
  const gid = Number(id);
  const g = await db.prepare("SELECT orgId FROM graphics WHERE id=?").bind(gid).first();
  if (!g) return;
  const { results: prods } = await db.prepare("SELECT locationsJson FROM products WHERE orgId=? AND configurable=1").bind(g.orgId).all().catch(() => ({ results: [] }));
  for (const p of prods) {
    for (const loc of (tryParse_(p.locationsJson, []) || [])) {
      if ((loc.graphicIds || []).map(Number).includes(gid)) throw new Error("A product's option menu uses this graphic — remove it there first");
    }
  }
  const org = await db.prepare("SELECT COUNT(*) n FROM orgs WHERE reorderQrGraphicId=?").bind(gid).first().catch(() => null);
  if (org && Number(org.n) > 0) throw new Error("An org's Reorder QR default uses this graphic — change that first");
  await db.prepare("DELETE FROM graphics WHERE id=?").bind(gid).run();
}

// Per-org tier prices (cents) + the org's default reorder QR code: a transfer (reorderQrTransferId,
// migrations/0047), or — the old way — a graphic (reorderQrGraphicId).
export async function getTierPrices(db, orgId) {
  // SELECT * so a database from before 0047 (no reorderQrTransferId column) still answers.
  const r = await db.prepare("SELECT * FROM orgs WHERE orgId=?").bind(orgId).first().catch(() => null);
  const t = tryParse_(r && r.tierPricesJson, null) || { small: 100, medium: 200, large: 400 };
  return { tiersCents: { small: Number(t.small) || 0, medium: Number(t.medium) || 0, large: Number(t.large) || 0 },
    reorderQrGraphicId: r && r.reorderQrGraphicId != null ? Number(r.reorderQrGraphicId) : null,
    reorderQrTransferId: r && r.reorderQrTransferId != null ? Number(r.reorderQrTransferId) : null };
}

export async function setTierPrices(db, orgId, tiersDollars) {
  const toC = (v) => Math.max(0, Math.round((Number(v) || 0) * 100));
  const json = JSON.stringify({ small: toC(tiersDollars.small), medium: toC(tiersDollars.medium), large: toC(tiersDollars.large) });
  await db.prepare("UPDATE orgs SET tierPricesJson=?, updatedAt=? WHERE orgId=?").bind(json, new Date().toISOString(), orgId).run();
}

export async function setOrgReorderQr(db, orgId, graphicId) {
  await db.prepare("UPDATE orgs SET reorderQrGraphicId=?, updatedAt=? WHERE orgId=?")
    .bind(graphicId == null || graphicId === "" ? null : Number(graphicId), new Date().toISOString(), orgId).run();
}

// The shop's default reorder QR code as a transfer (migrations/0047). Setting it clears the old
// graphic pointer, so there's one answer and that graphic can be deleted.
export async function setOrgReorderQrTransfer(db, orgId, transferId) {
  await db.prepare("UPDATE orgs SET reorderQrTransferId=?, reorderQrGraphicId=NULL, updatedAt=? WHERE orgId=?")
    .bind(transferId == null || transferId === "" ? null : Number(transferId), new Date().toISOString(), orgId).run();
}

// A product's effective reorder QR code → {transferId} | {graphicId} | null.
// 'none' → null; 'default' → the shop's (its transfer, else its old-style graphic); 't<id>' → that
// transfer; a bare number → that graphic (the old way).
function resolveReorderQr_(productReorderQr, orgDefault) {
  const v = String(productReorderQr || "default");
  if (v === "none") return null;
  if (v === "default") return orgDefault && orgDefault.transferId ? { transferId: Number(orgDefault.transferId) }
    : orgDefault && orgDefault.graphicId ? { graphicId: Number(orgDefault.graphicId) } : null;
  const t = v.match(/^t(\d+)$/);
  if (t) return Number(t[1]) > 0 ? { transferId: Number(t[1]) } : null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? { graphicId: n } : null;
}

// ---- Run Transfer Sheets queue / gang sheet (migrations/0036) -------------
// Lines carrying a transfer application (a customer's transfer option, or the reorder QR — which a
// plain product can carry too, migrations/0048), on real/paid/active orders.
// "ready" = blank received AND transfer received; "waiting" = missing either.
// Two kinds of line (`hasEmbroidery`, from the same hooping plan Run Order uses):
//   * transfer-only — listed until it's made; "Mark made" here makes the line.
//   * also embroidered — it's on Run Order too. Finishing the embroidery there makes the piece; it
//     stays listed HERE until its transfers are marked applied (transfersAppliedAt), even after the
//     embroidery is done, until the order ships. `embroideryDone` says where the other half is.
export async function getTransferQueue(db) {
  const { results } = await db.prepare(
    `SELECT i.id AS itemId, i.orderId, i.orgId, i.name AS itemName, i.size AS itemSize, i.qty, i.configJson,
            COALESCE(i.manufacturedQty,0) AS manufacturedQty, i.transfersAppliedAt, o.manufacturedAt AS orderMadeAt,
            i.transferReceivedAt, COALESCE(i.blankReceivedAt, o.blankReceivedAt) AS blankReceivedAt,
            org.name AS orgName, o.customerName, o.dueDate,
            l.blankId, l.blankSize, b.name AS blankName, COALESCE(NULLIF(l.blankColor, ''), b.color) AS blankColor
     FROM order_items i
     JOIN orders o ON o.orderId = i.orderId
     JOIN orgs org ON org.orgId = i.orgId
     -- The link for THIS line's garment color (migrations/0037). Without the color a product linked
     -- per color matched one row per color, so each line was listed once for every color it comes in.
     LEFT JOIN product_blank_links l ON l.orgId = i.orgId AND l.productId = i.productId AND l.productSize = i.size
            AND l.productColor = (CASE WHEN i.configJson LIKE '{%' THEN COALESCE(json_extract(i.configJson,'$.garmentColor'),'') ELSE '' END)
     LEFT JOIN blanks b ON b.id = l.blankId
     WHERE i.cancelDate IS NULL AND o.paid = 1 AND o.isTest = 0 AND o.voidedAt IS NULL AND i.configJson <> ''
       AND ((o.manufacturedAt IS NULL AND COALESCE(i.manufacturedQty,0) < i.qty)
         OR (i.transfersAppliedAt IS NULL AND o.completedAt IS NULL AND o.shippedAt IS NULL AND o.deliveredAt IS NULL))
     ORDER BY (o.dueDate IS NULL), o.dueDate, o.placedAt`
  ).all();
  const rows = [];
  for (const r of results) {
    const cfg = tryParse_(r.configJson, null);
    const transfers = cfg ? (cfg.locations || []).filter(l => l.kind === "transfer") : [];
    if (transfers.length) rows.push({ r, cfg, transfers });   // embroidery-only lines belong to Run Order alone
  }
  const embroidered = await linesWithEmbroidery_(db, rows.map(x => Number(x.r.itemId)));
  const ready = [], waiting = [];
  for (const { r, cfg, transfers } of rows) {
    const hasEmbroidery = embroidered.has(Number(r.itemId));
    const made = !!r.orderMadeAt || Number(r.manufacturedQty) >= (Number(r.qty) || 1);
    if (hasEmbroidery ? !!r.transfersAppliedAt : made) continue;
    const card = {
      itemId: Number(r.itemId), orderId: r.orderId, orgId: r.orgId, orgName: r.orgName || r.orgId,
      customerName: r.customerName, itemName: r.itemName, itemSize: r.itemSize || "", qty: Number(r.qty) || 1,
      dueDate: r.dueDate || "", garmentColor: cfg.garmentColor || "",
      blank: r.blankId == null ? null : { id: Number(r.blankId), name: r.blankName || "", color: r.blankColor || "", size: r.blankSize || "" },
      transfers: transfers.map(t => ({ location: t.label || t.location, graphicName: t.graphicName, ink: t.ink || "",
        imageUrl: t.imageUrl || "", thumbUrl: t.thumbUrl || "", auto: !!t.auto,
        // The customer's own image (migrations/0054), in the private bucket — the page asks for a signed link.
        ...(t.custom ? { custom: true, fileKey: t.fileKey || "", fileName: t.fileName || "" } : {}) })),
      blankReceived: !!r.blankReceivedAt, transferReceived: !!r.transferReceivedAt,
      hasEmbroidery, embroideryDone: hasEmbroidery && made,
    };
    (card.blankReceived && card.transferReceived ? ready : waiting).push(card);
  }
  return { ready, waiting };
}

// Which of these line items have embroidery to run (at least one hooping in Run Order's plan).
async function linesWithEmbroidery_(db, itemIds) {
  const out = new Set();
  if (!itemIds.length) return out;
  let ctx = null;
  try { ctx = await hoopingContext_(db, itemIds); }
  catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; return out; }
  for (const id of itemIds) { const it = ctx.items[id]; if (it && lineIsEmbroidered_(it, planHoopings_(ctx, it))) out.add(id); }
  return out;
}

export async function setTransferReceived(db, itemId, on) {
  await db.prepare("UPDATE order_items SET transferReceivedAt=? WHERE id=?")
    .bind(on ? new Date().toISOString() : null, Number(itemId)).run();
}

// A line that is also embroidered: record that its transfers were pressed (it then leaves Run
// Transfer Sheets). Doesn't make the piece — finishing the embroidery on Run Order does that, and
// that's also when the transfers' stock is used (consumeLineTransfersOnce_). `on` false undoes it.
export async function setTransfersApplied(db, orderId, itemId, on = true) {
  const item = await db.prepare("SELECT id, cancelDate FROM order_items WHERE id=? AND orderId=?").bind(Number(itemId), orderId).first();
  if (!item) throw new Error("Line item not found");
  if (item.cancelDate) throw new Error("That line item is cancelled");
  await db.prepare("UPDATE order_items SET transfersAppliedAt=? WHERE id=?").bind(on ? new Date().toISOString() : null, Number(itemId)).run();
}
export async function lineHasEmbroidery(db, itemId) {
  return (await linesWithEmbroidery_(db, [Number(itemId)])).has(Number(itemId));
}

// Totals transfer applications (customer options + reorder QR) by graphic × ink × garment size over
// every line still on Run Transfer Sheets (ready or waiting) — for building gang sheets.
export async function getGangSheet(db) {
  const q = await getTransferQueue(db);
  const map = new Map();
  for (const c of q.ready.concat(q.waiting)) {
    for (const t of c.transfers) {
      // A customer's own image is its own art: keyed by its file, so two customers' designs never add up.
      const key = [t.custom ? "custom:" + (t.fileKey || c.itemId) : t.graphicName, t.ink || "", c.itemSize || ""].join("|");
      const row = map.get(key) || { graphic: t.custom ? "Customer design — " + c.customerName + " (" + c.orderId + ")" : t.graphicName,
        ink: t.ink || "", size: c.itemSize || "", count: 0, ...(t.custom ? { custom: true, fileKey: t.fileKey || "", fileName: t.fileName || "" } : {}) };
      row.count += c.qty;
      map.set(key, row);
    }
  }
  return [...map.values()].sort((a, b) => (a.graphic + a.ink + a.size).localeCompare(b.graphic + b.ink + b.size));
}

// Run Transfer Sheets "Mark made": mark the whole line manufactured — which consumes the linked
// blank per piece AND the line's transfer applications once (consumeLineTransfersOnce_ fires from
// markItemPieceManufactured when the last piece lands, so embroidery Run Order and Run Transfer
// Sheets both consume transfers exactly once). Idempotent once the line is fully made.
export async function makeTransferLine(db, orderId, itemId) {
  const item = await db.prepare(
    "SELECT id, orderId, orgId, productId, size, qty, COALESCE(manufacturedQty,0) AS manufacturedQty, configJson, cancelDate FROM order_items WHERE id=? AND orderId=?"
  ).bind(Number(itemId), orderId).first();
  if (!item) throw new Error("Line item not found");
  if (item.cancelDate) throw new Error("That line item is cancelled");
  const qty = Math.max(1, Number(item.qty) || 1);
  if (Number(item.manufacturedQty) >= qty) return { alreadyDone: true, orderComplete: false };
  let res = { orderComplete: false };
  for (let made = Number(item.manufacturedQty); made < qty; made++) res = await markItemPieceManufactured(db, orderId, Number(itemId));
  return { orderComplete: !!res.orderComplete };
}

// ---- Product → blank links ---------------------------------------------

export async function getBlankLinks(db, orgId) {
  const { results } = await db.prepare(
    "SELECT * FROM product_blank_links WHERE orgId=? ORDER BY productId, productColor, productSize"
  ).bind(orgId).all();
  return results.map(r => ({
    id:           Number(r.id),
    orgId:        r.orgId,
    productId:    r.productId,
    productColor: r.productColor || "",
    productSize:  r.productSize  || "",
    blankId:      Number(r.blankId),
    blankColor:   r.blankColor   || "",
    blankSize:    r.blankSize    || "",
  }));
}

// A product's color+size → a blank's color+size (migrations/0037). Accepts the new 8-arg form
// (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) and, for older
// callers/tests, the legacy 6-arg form (orgId, productId, productSize, blankId, blankSize) which
// maps productColor/blankColor to '' (a single-color blank's stock lives under color '').
export async function setBlankLink(db, orgId, productId, a, b, c, d, e) {
  let productColor, productSize, blankId, blankColor, blankSize;
  if (arguments.length >= 8) { productColor = a; productSize = b; blankId = c; blankColor = d; blankSize = e; }
  else { productColor = ""; productSize = a; blankId = b; blankColor = null; blankSize = c; }
  // An omitted blankColor targets the blank's legacy scalar color (single-color blanks), matching
  // receiveBlanks' default, so a legacy link resolves to where that blank's stock actually lives.
  if (blankColor == null) blankColor = await blankScalarColor_(db, Number(blankId));
  await db.prepare(
    `INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (orgId, productId, productColor, productSize) DO UPDATE SET blankId=excluded.blankId, blankColor=excluded.blankColor, blankSize=excluded.blankSize`
  ).bind(orgId, productId, String(productColor || ""), productSize || "", Number(blankId), String(blankColor || ""), blankSize || "").run();
}

export async function deleteBlankLink(db, orgId, productId, a, b) {
  // New: (orgId, productId, productColor, productSize); legacy: (orgId, productId, productSize).
  const productColor = arguments.length >= 5 ? String(a || "") : "";
  const productSize = arguments.length >= 5 ? (b || "") : (a || "");
  await db.prepare(
    "DELETE FROM product_blank_links WHERE orgId=? AND productId=? AND productColor=? AND productSize=?"
  ).bind(orgId, productId, productColor, productSize).run();
}

// ---- Blanks to order (admin → Inventory → Blanks to Order) --------------------------------------
// What to buy from each supplier to make every open order: each order line that still has pieces
// to make is resolved to its blank (the same product_blank_links row that marking it manufactured
// uses — org + product + the line's garment color + size) and added up per blank / color / size.
// A line is one of:
//   need     — its blanks haven't been ordered yet → this is the shopping list
//   onOrder  — its blanks are ordered but not received → already on a supplier order, left out
//   received — its blanks are in → its pieces are spoken for out of the stock on hand (`reserved`),
//              so that stock isn't offered to another order
// Returns the raw counts per row (needed / reserved / onHand / price); the screen turns them into
// "to order" and cost, because it lets the owner choose whether to use stock on hand first. Unpaid
// orders are left out unless `includeUnpaid` (don't order blanks until payment is confirmed — the
// same rule as the per-shop breakdown on Orders), and counted so the screen can say how many.
// Lines with no blank link are returned separately rather than silently dropped. Read-only.
export async function getBlanksToOrder(db, { includeUnpaid = false } = {}) {
  const [{ results: lines }, { results: links }, { results: blanks }, { results: sizes }] = await Promise.all([
    db.prepare(
      `SELECT oi.id, oi.orderId, oi.orgId, oi.productId, oi.name, oi.size, oi.qty, COALESCE(oi.manufacturedQty, 0) AS made, oi.configJson,
              COALESCE(oi.blankOrderedAt, o.blankOrderedAt) AS orderedAt, COALESCE(oi.blankReceivedAt, o.blankReceivedAt) AS receivedAt,
              o.paid, o.customerName
       FROM order_items oi JOIN orders o ON o.orderId = oi.orderId
       WHERE oi.cancelDate IS NULL AND o.voidedAt IS NULL AND o.isTest = 0 AND o.completedAt IS NULL AND o.manufacturedAt IS NULL
       ORDER BY o.placedAt, oi.id`).all(),
    db.prepare("SELECT orgId, productId, productColor, productSize, blankId, blankColor, blankSize FROM product_blank_links").all(),
    db.prepare("SELECT id, name, vendor, brand, sku, productType FROM blanks").all(),
    db.prepare("SELECT blankId, color, size, quantity, purchasePriceCents FROM blank_sizes").all(),
  ]);
  const linkAt = new Map(links.map(l => [[l.orgId, l.productId, l.productColor || "", l.productSize || ""].join("\u0001"), l]));
  const blankAt = new Map(blanks.map(b => [Number(b.id), b]));
  const sizeAt = new Map(sizes.map(s => [[s.blankId, s.color || "", s.size || ""].join("\u0001"), s]));
  const rows = new Map(), unlinked = [];
  let onOrderPieces = 0, unpaidPieces = 0, unpaidOrders = new Set();
  for (const ln of lines) {
    const left = (Number(ln.qty) || 0) - (Number(ln.made) || 0);
    if (left <= 0) continue;
    const state = ln.receivedAt ? "received" : ln.orderedAt ? "onOrder" : "need";
    if (state === "onOrder") { onOrderPieces += left; continue; }
    if (state === "need" && !ln.paid && !includeUnpaid) { unpaidPieces += left; unpaidOrders.add(ln.orderId); continue; }
    const color = itemColor_(ln);
    const link = ln.productId ? linkAt.get([ln.orgId, ln.productId, color, ln.size || ""].join("\u0001")) : null;
    const blank = link ? blankAt.get(Number(link.blankId)) : null;
    if (!blank) {
      if (state === "need") unlinked.push({ orderId: ln.orderId, orgId: ln.orgId, customerName: ln.customerName || "", name: ln.name || "", color, size: ln.size || "", qty: left,
        reason: ln.productId ? "notLinked" : "custom" });
      continue;
    }
    const key = [blank.id, link.blankColor || "", link.blankSize || ""].join("\u0001");
    let row = rows.get(key);
    if (!row) {
      const sz = sizeAt.get(key);
      row = { blankId: Number(blank.id), vendor: blank.vendor || "", blank: blank.name || "", brand: blank.brand || "", sku: blank.sku || "", productType: blank.productType || "",
        color: link.blankColor || "", size: link.blankSize || "", needed: 0, reserved: 0,
        onHand: sz ? Number(sz.quantity) || 0 : 0, price: sz ? fromCents(sz.purchasePriceCents) : 0, orders: [] };
      rows.set(key, row);
    }
    if (state === "received") row.reserved += left;
    else { row.needed += left; if (!row.orders.includes(ln.orderId)) row.orders.push(ln.orderId); }
  }
  // Only rows something still has to be bought for; grouped by supplier.
  const bySupplier = new Map();
  for (const row of rows.values()) {
    if (!row.needed) continue;
    (bySupplier.get(row.vendor) || bySupplier.set(row.vendor, []).get(row.vendor)).push(row);
  }
  const suppliers = [...bySupplier].map(([vendor, list]) => ({ vendor, rows: list }))
    .sort((a, b) => (a.vendor === "") - (b.vendor === "") || a.vendor.localeCompare(b.vendor));
  return { suppliers, unlinked, onOrderPieces, unpaidPieces, unpaidOrders: unpaidOrders.size, includeUnpaid: !!includeUnpaid, generatedAt: new Date().toISOString() };
}

// ---- CSV import: blanks and products ------------------------------------------------------------
// Blanks → Import CSV (one row per vendor style, a cost column per size) and a shop's Products →
// Import CSV (one row per listing, linked to its blank by style). Both take the file's rows as plain
// {header: value} objects and do ALL the interpreting here, so the preview (`dryRun`) and the real
// import can't disagree. Re-importing the same file updates instead of duplicating: blanks match on
// their style (blanks.sku), products on their id (the SKU, lower-cased). A row with a `problems`
// entry is never written; `notes` are just things worth knowing.
// Rows per request. The browser sends a big file in small batches (each its own request), because a
// row costs a handful of queries and a Worker invocation only gets so many.
export const IMPORT_MAX_ROWS = 100;
// One INSERT … VALUES (…),(…),… per `perStmt` rows — D1 allows 100 bound values a statement, and a
// style with 20 colors × 10 sizes is 200 rows, so single-row inserts would burn the query budget.
function importMultiInsert_(db, head, rowSql, tail, rows, perStmt) {
  const out = [];
  for (let i = 0; i < rows.length; i += perStmt) {
    const part = rows.slice(i, i + perStmt);
    out.push(db.prepare(`${head} VALUES ${part.map(() => rowSql).join(", ")}${tail ? " " + tail : ""}`).bind(...part.flat()));
  }
  return out;
}
const IMPORT_PRODUCT_ID_RE_ = /^[a-z0-9-]{1,40}$/;   // same rule as catalogValidation's PRODUCT_ID_RE

const importRow_ = (raw) => {
  const o = {};
  for (const k of Object.keys(raw || {})) o[String(k).replace(/^﻿/, "").trim().toLowerCase()] = raw[k] == null ? "" : String(raw[k]).trim();
  return o;
};
// "Navy | Black|navy" → ["Navy", "Black"] (order kept, blanks and case-insensitive repeats dropped).
const importList_ = (v, max = 80) => {
  const seen = new Set(), out = [];
  for (const part of String(v || "").split("|")) {
    const t = part.trim(); if (!t) continue;
    const k = t.toLowerCase(); if (seen.has(k)) continue;
    seen.add(k); out.push(t.slice(0, max));
  }
  return out;
};
// "$1,234.50" → 1234.5; blank → null; anything else (or negative) → NaN.
const importMoney_ = (v) => {
  const t = String(v == null ? "" : v).replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};
const importSize_ = (v) => String(v || "").trim().toUpperCase().slice(0, 20);
const importBool_ = (v, dflt) => {
  const t = String(v == null ? "" : v).trim().toLowerCase();
  if (!t) return dflt;
  return ["true", "yes", "y", "1", "active", "visible", "x"].includes(t);
};
const importMoneyText_ = (n) => "$" + Number(n).toFixed(2);

// A vendor/catalog category ("Shirts", "Hoodies & Layers", "Headwear") → this site's product type.
// "" when it can't tell. "sweat…" is checked before "shirt" so "Sweatshirts" lands right.
export function importTypeFromCategory(category) {
  const c = String(category || "").trim().toLowerCase();
  if (["shirt", "sweatshirt", "cap", "other"].includes(c)) return c;
  if (/hood|sweat|fleece|layer|pullover|crew|quarter|zip|jacket|outerwear/.test(c)) return "sweatshirt";
  if (/\bcaps?\b|\bhats?\b|beanie|visor|headwear/.test(c)) return "cap";
  if (/shirt|polo|\btees?\b|\btops?\b/.test(c)) return "shirt";
  return "";
}

// Makes sure a blank has the given colors and sizes WITHOUT touching stock: missing colors and
// missing color×size rows are added at quantity 0, nothing is deleted or re-ordered, and no stock
// movement is written (nothing moved). `sizeCosts` (Map size → dollars) are the file's costs: a
// size with no stock takes the file's cost (it's only a reference price until something is
// received), a size WITH stock keeps its weighted-average cost. Without `sizeCosts` a new color
// copies each size's cost from the blank's existing rows. The empty-named placeholder color a
// colorless import creates is dropped once real colors exist, provided it never held stock, has
// no history and nothing links to it. Returns what it did (or would do, with `dryRun`).
async function ensureBlankColorSizes_(db, blankId, addColors, sizeCosts, opts = {}) {
  const id = Number(blankId);
  const [{ results: cRows }, { results: sRows }] = await Promise.all([
    db.prepare("SELECT color, sortOrder FROM blank_colors WHERE blankId=? ORDER BY sortOrder, color").bind(id).all(),
    db.prepare("SELECT color, size, quantity, purchasePriceCents FROM blank_sizes WHERE blankId=? ORDER BY color, id").bind(id).all(),
  ]);
  const info = { addedColors: [], addedSizes: 0, costUpdated: 0, costKept: 0, droppedPlaceholder: false, colors: [], sizes: [] };
  let colorNames = [];
  const haveColor = new Map();   // lower-case → the name as stored
  const note = (c) => { const k = String(c || "").toLowerCase(); if (!haveColor.has(k)) { haveColor.set(k, c || ""); colorNames.push(c || ""); } };
  cRows.forEach(r => note(r.color)); sRows.forEach(r => note(r.color));
  const inCatalog = new Set(cRows.map(r => r.color || ""));
  let maxSort = cRows.reduce((m, r) => Math.max(m, Number(r.sortOrder) || 0), -1);
  const toAdd = (addColors || []).map(c => String(c || "").slice(0, 80)).filter(c => !haveColor.has(c.toLowerCase()));
  const deletes = [], updates = [], colorIns = [], sizeIns = [], now = new Date().toISOString();

  // Costs known today, per size (the placeholder color first, so its file-given costs win).
  const knownCost = new Map(), knownSizes = [];
  for (const r of [...sRows].sort((a, b) => (a.color === "" ? -1 : 0) - (b.color === "" ? -1 : 0))) {
    if (!knownCost.has(r.size)) { knownCost.set(r.size, Number(r.purchasePriceCents) || 0); knownSizes.push(r.size); }
  }

  // Drop the unnamed placeholder once the blank has real colors.
  const named = colorNames.filter(c => c !== "").length + toAdd.filter(c => c !== "").length;
  let dropped = false;
  if (haveColor.has("") && named > 0) {
    const stock = sRows.filter(r => (r.color || "") === "").some(r => Number(r.quantity) !== 0);
    const used = stock ? null : await db.prepare(
      `SELECT (SELECT count(*) FROM inventory_movements WHERE blankId=?1 AND color='') +
              (SELECT count(*) FROM product_blank_links WHERE blankId=?1 AND blankColor='') AS n`).bind(id).first();
    if (!stock && !(used && Number(used.n))) {
      dropped = true; info.droppedPlaceholder = true;
      deletes.push(db.prepare("DELETE FROM blank_sizes WHERE blankId=? AND color=''").bind(id));
      deletes.push(db.prepare("DELETE FROM blank_colors WHERE blankId=? AND color=''").bind(id));
      colorNames = colorNames.filter(c => c !== "");
    }
  }

  const sizeList = [...new Set([...(sizeCosts ? [...sizeCosts.keys()] : []), ...knownSizes])];
  const costOf = (size) => (sizeCosts && sizeCosts.has(size)) ? Math.max(0, toCents(sizeCosts.get(size))) : (knownCost.get(size) || 0);
  const rowAt = new Map(sRows.map(r => [(r.color || "") + "|" + r.size, r]));
  const finalColors = [...colorNames, ...toAdd];
  for (const color of finalColors) {
    const isNew = toAdd.includes(color);
    if (isNew || !inCatalog.has(color)) {
      colorIns.push([id, color, ++maxSort, now, now]);
      if (isNew) info.addedColors.push(color);
    }
    for (const size of sizeList) {
      const cur = isNew ? null : rowAt.get(color + "|" + size);
      const cents = costOf(size);
      if (!cur) {
        sizeIns.push([id, color, size, cents]);
        info.addedSizes++;
      } else if (sizeCosts && sizeCosts.has(size) && (Number(cur.purchasePriceCents) || 0) !== cents) {
        if (Number(cur.quantity) > 0) info.costKept++;
        else { updates.push(db.prepare("UPDATE blank_sizes SET purchasePriceCents=? WHERE blankId=? AND color=? AND size=?").bind(cents, id, color, size)); info.costUpdated++; }
      }
    }
  }
  info.colors = finalColors; info.sizes = sizeList;
  if (!opts.dryRun) {
    // Deletes (the placeholder) first, then the new rows, then cost updates — one transaction.
    const all = [
      ...deletes,
      ...importMultiInsert_(db, "INSERT OR IGNORE INTO blank_colors (blankId, color, imagesJson, sortOrder, createdAt, updatedAt)", "(?, ?, '[]', ?, ?, ?)", "", colorIns, 19),
      ...importMultiInsert_(db, "INSERT OR IGNORE INTO blank_sizes (blankId, color, size, purchasePriceCents, quantity)", "(?, ?, ?, ?, 0)", "", sizeIns, 24),
      ...updates,
    ];
    if (all.length) await db.batch(all);
  }
  return info;
}

// The notes line the blank import writes: backing and the reference prices have no column of their
// own, so they're kept here rather than dropped. Starts with one of these labels, which is how a
// later import tells its own text (safe to refresh) from notes typed by hand (left alone).
const IMPORT_NOTE_RE_ = /^(Backing:|Book \$|Floor \$|Sale cost \$)/;
function importBlankNotes_(r) {
  const money = (label, v) => { const n = importMoney_(v); return n != null && !Number.isNaN(n) ? `${label} ${importMoneyText_(n)}` : ""; };
  return [r.backing ? "Backing: " + r.backing : "", money("Book", r.book_price), money("Floor", r.floor_price),
    money("Sale cost", r.sale_cost_base || r.sale_cost), r.notes || ""].filter(Boolean).join(" · ").slice(0, 500);
}

// Blanks → Import CSV. Columns (header names, any case): style (required — matched against the
// blank's SKU), name, brand, supplier, category, one cost_<SIZE> per size (blank = the style
// doesn't come in it), needle, backing, notes, sale_cost_base / book_price / floor_price, and an
// optional colors (or all_colors) list separated by |. size_range is ignored (the costs say it).
export async function importBlanksCsv(db, rawRows, opts = {}) {
  const dryRun = !!opts.dryRun;
  const rows = (rawRows || []).slice(0, IMPORT_MAX_ROWS).map(importRow_);
  const { results: blankRows } = await db.prepare("SELECT id, sku, vendor, notes FROM blanks ORDER BY id").all();
  const bySku = new Map();
  for (const b of blankRows) { const k = String(b.sku || "").trim().toLowerCase(); if (k) (bySku.get(k) || bySku.set(k, []).get(k)).push(b); }
  const needleTypes = await listNeedleTypes(db);
  const findNeedle = (name) => {
    const n = name.toLowerCase();
    return needleTypes.find(t => t.name.toLowerCase() === n)
      || needleTypes.find(t => t.name && (n.startsWith(t.name.toLowerCase()) || t.name.toLowerCase().startsWith(n)));
  };
  // `seen`: styles in the batches the browser already sent, so a repeat further down the file is
  // still caught; `rowOffset` keeps row numbers matching the spreadsheet (header = row 1).
  const out = [], seen = new Set((opts.seen || []).map(x => String(x).toLowerCase())), newNeedleTypes = [];
  const rowOffset = Math.max(0, Math.floor(Number(opts.rowOffset) || 0));
  let created = 0, updated = 0, skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const style = (r.style || r.sku || r.blank_style || "").slice(0, 100);
    const res = { row: rowOffset + i + 2, style, name: "", action: "skip", problems: [], notes: [], sizes: [], colors: [] };
    out.push(res);
    if (!style) { res.problems.push("No style — every row needs one"); skipped++; continue; }
    if (seen.has(style.toLowerCase())) { res.problems.push("This style is in the file more than once"); skipped++; continue; }
    seen.add(style.toLowerCase());
    const name = (r.name || [r.brand, style].filter(Boolean).join(" ")).slice(0, 200);
    res.name = name;
    let type = importTypeFromCategory(r.category || r.type);
    if (!type) { type = "other"; if (r.category) res.notes.push(`Category "${r.category}" isn't one this site knows — filed under Other`); }

    const sizeCosts = new Map();
    for (const k of Object.keys(r)) {
      if (!k.startsWith("cost_")) continue;
      const size = importSize_(k.slice(5)), v = importMoney_(r[k]);
      if (!size || v == null) continue;
      if (Number.isNaN(v)) { res.problems.push(`Cost for ${size} isn't a number ("${r[k]}")`); continue; }
      sizeCosts.set(size, v);
    }
    if (!sizeCosts.size && !res.problems.length) res.problems.push("No size costs — fill at least one cost_<size> column (e.g. cost_M, or cost_OSFA for one size)");
    res.sizes = [...sizeCosts.keys()];
    const colors = importList_(r.colors || r.all_colors);
    res.colors = colors;

    let needleTypeId, needleName = "";
    if (r.needle) {
      const t = findNeedle(r.needle);
      if (t) { needleTypeId = t.id; needleName = t.name; }
      else { needleName = r.needle.slice(0, 60); if (!newNeedleTypes.includes(needleName)) newNeedleTypes.push(needleName); res.notes.push(`Adds the needle type "${needleName}"`); }
    }
    res.needle = needleName;

    const matches = bySku.get(style.toLowerCase()) || [];
    const vendor = (r.supplier || r.vendor || "").slice(0, 100);
    const existing = matches.find(b => String(b.vendor || "").toLowerCase() === vendor.toLowerCase()) || matches[0] || null;
    if (matches.length > 1) res.notes.push(`${matches.length} blanks already use this style — updating ${existing && existing.vendor ? "the " + existing.vendor + " one" : "the first"}`);
    if (res.problems.length) { skipped++; continue; }
    res.action = existing ? "update" : "create";
    const notes = importBlankNotes_(r);

    if (!dryRun && needleTypeId === undefined && needleName) {
      const made = findNeedle(needleName);   // an earlier row may have just created it
      needleTypeId = made ? made.id : await saveNeedleType(db, { name: needleName });
      if (!made) needleTypes.push({ id: needleTypeId, name: needleName });
    }

    if (!existing) {
      if (!dryRun) {
        const sizes = [...sizeCosts].map(([size, cost]) => ({ size, purchasePrice: cost, quantity: 0 }));
        const fields = { name, productType: type, vendor, brand: (r.brand || "").slice(0, 100), sku: style, color: "", notes,
          colors: (colors.length ? colors : [""]).map(color => ({ color, sizes })) };
        if (needleTypeId !== undefined) fields.needleTypeId = needleTypeId;
        res.id = (await createBlank(db, fields)).id;
      }
      created++;
      continue;
    }

    // Existing blank: refresh its catalog fields, add what's missing, never touch stock.
    res.id = Number(existing.id);
    const keepNotes = !!existing.notes && !IMPORT_NOTE_RE_.test(existing.notes);
    if (keepNotes && notes && notes !== existing.notes) res.notes.push("Its notes were typed by hand — left as they are");
    if (!dryRun) {
      await db.prepare("UPDATE blanks SET name=?, productType=?, vendor=?, brand=?, notes=?, updatedAt=? WHERE id=?")
        .bind(name, type, vendor, (r.brand || "").slice(0, 100), keepNotes ? existing.notes : notes, new Date().toISOString(), Number(existing.id)).run();
      if (needleTypeId !== undefined) await setBlankNeedleType_(db, Number(existing.id), { needleTypeId });
    }
    const did = await ensureBlankColorSizes_(db, existing.id, colors, sizeCosts, { dryRun });
    if (did.addedColors.length) res.notes.push(`Adds ${did.addedColors.length} color${did.addedColors.length === 1 ? "" : "s"}`);
    if (did.addedSizes) res.notes.push(`Adds ${did.addedSizes} size row${did.addedSizes === 1 ? "" : "s"}`);
    if (did.costUpdated) res.notes.push(`Updates the cost on ${did.costUpdated} size row${did.costUpdated === 1 ? "" : "s"} with no stock`);
    if (did.costKept) res.notes.push(`${did.costKept} size row${did.costKept === 1 ? " has" : "s have"} stock — the average cost is kept, not replaced`);
    updated++;
  }
  return { dryRun, results: out, created, updated, skipped, newNeedleTypes };
}

// A shop's Products → Import CSV. Columns: sku (required — becomes the product id, lower-cased),
// name, category, price, sizes (S|M|L…), size_upcharges (2XL:1.00|3XL:3.00, added to price),
// description, features (a|b|c), default_colors (the garment colors offered) and all_colors (every
// color the blank comes in), graphics_locations ("Front: left chest|Back"), personalization_price,
// active, no_design_needed, and blank_style (the blank's style — links every color and size to that blank, adding
// the colors to it when it doesn't have them yet). brand and margin_base are read by nobody.
// `opts.graphicIds` (already checked to belong to the shop) are offered at each NEW location; a
// location the product already has keeps its own graphics. Images, weight, designs, the pick list
// and anything else not in the file are left alone on a product that already exists.
export async function importProductsCsv(db, orgId, rawRows, opts = {}) {
  const dryRun = !!opts.dryRun;
  const rows = (rawRows || []).slice(0, IMPORT_MAX_ROWS).map(importRow_);
  const existingProducts = await getProductsByOrg(db, orgId, false);
  const byId = new Map(existingProducts.map(p => [p.productId, p]));
  const { results: blankRows } = await db.prepare("SELECT id, sku, name, productType, color FROM blanks ORDER BY id").all();
  const blankBySku = new Map();
  for (const b of blankRows) { const k = String(b.sku || "").trim().toLowerCase(); if (k && !blankBySku.has(k)) blankBySku.set(k, b); }
  const locations = await listLocations(db);
  const graphicIds = (opts.graphicIds || []).map(Number).filter(Boolean);
  let nextSort = existingProducts.reduce((m, p) => Math.max(m, Number(p.sortOrder) || 0), 0) + 1;
  const out = [], seen = new Set((opts.seen || []).map(x => String(x).toLowerCase())), newLocations = [];
  const rowOffset = Math.max(0, Math.floor(Number(opts.rowOffset) || 0));
  let created = 0, updated = 0, skipped = 0, linked = 0;
  const ci = (list, want) => list.find(x => String(x).toLowerCase() === String(want).toLowerCase());

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const sku = r.sku || r.product_id || r.productid || r.id || "";
    const productId = sku.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const res = { row: rowOffset + i + 2, sku, productId, name: (r.name || "").slice(0, 200), action: "skip", problems: [], notes: [],
      sizes: [], colors: [], locations: [], price: "", blank: null };
    out.push(res);
    if (!sku) { res.problems.push("No SKU — every row needs one"); skipped++; continue; }
    if (!IMPORT_PRODUCT_ID_RE_.test(productId)) { res.problems.push(`SKU "${sku}" can't be a product id (use up to 40 letters, numbers and hyphens)`); skipped++; continue; }
    if (seen.has(productId)) { res.problems.push("This SKU is in the file more than once"); skipped++; continue; }
    seen.add(productId);
    if (!res.name) res.problems.push("No name");
    const type = importTypeFromCategory(r.category || r.type);
    if (!type || type === "other") res.problems.push(`Category "${r.category || ""}" isn't a shirt, hoodie/sweatshirt or cap`);
    const price = importMoney_(r.price);
    if (price == null) res.problems.push("No price");
    else if (Number.isNaN(price)) res.problems.push(`Price isn't a number ("${r.price}")`);

    let sizes = importList_(r.sizes, 20).map(importSize_);
    const upcharges = {};
    for (const part of importList_(r.size_upcharges)) {
      const m = part.match(/^(.+?)\s*[:=]\s*(.+)$/);
      const amt = m ? importMoney_(m[2]) : NaN;
      if (!m || amt == null || Number.isNaN(amt)) { res.problems.push(`Size upcharge "${part}" should look like 2XL:1.00`); continue; }
      upcharges[importSize_(m[1])] = amt;
    }
    const oneSize = sizes.length <= 1 && (!sizes.length || /^(OSFA|OS|ONE SIZE|ONESIZE)$/.test(sizes[0]));
    const flat = type === "cap" || (oneSize && type !== "shirt" && type !== "sweatshirt");
    if (!flat && !sizes.length) res.problems.push("No sizes — list them separated by | (S|M|L|XL)");
    if (type === "cap" && sizes.length > 1) res.notes.push("Caps are sold as one size — the size list is ignored");
    const sizePricing = {};
    if (!flat && price != null && !Number.isNaN(price)) {
      for (const sz of sizes) sizePricing[sz] = Math.round((price + (upcharges[sz] || 0)) * 100) / 100;
      const stray = Object.keys(upcharges).filter(sz => !sizes.includes(sz));
      if (stray.length) res.notes.push(`Upcharge for ${stray.join(", ")} ignored — not in the size list`);
    }
    if (flat) sizes = ["OSFA"];
    res.sizes = sizes;
    if (price != null && !Number.isNaN(price)) {
      const all = flat ? [price] : Object.values(sizePricing);
      const lo = Math.min(...all), hi = Math.max(...all);
      res.price = all.length ? (lo === hi ? importMoneyText_(lo) : importMoneyText_(lo) + "–" + importMoneyText_(hi)) : "";
    }

    const hasPers = Object.prototype.hasOwnProperty.call(r, "personalization_price");
    const pers = importMoney_(r.personalization_price);
    if (Number.isNaN(pers)) res.problems.push(`Personalization price isn't a number ("${r.personalization_price}")`);

    const allColors = importList_(r.all_colors);
    let garmentColors = importList_(r.default_colors || r.colors);
    if (!garmentColors.length && allColors.length) { garmentColors = allColors.slice(); res.notes.push("No default colors — offering every color in all_colors"); }
    res.colors = garmentColors;

    const ex = byId.get(productId) || null;
    // Locations: "Front: left chest" → the Front location (the part after the colon is a placement
    // note, kept on a location this import creates).
    const locEntries = [];
    for (const part of importList_(r.graphics_locations || r.locations, 200)) {
      const cut = part.indexOf(":");
      const lname = (cut < 0 ? part : part.slice(0, cut)).trim().slice(0, 100), lnote = cut < 0 ? "" : part.slice(cut + 1).trim();
      if (!lname) continue;
      let L = locations.find(x => x.name.toLowerCase() === lname.toLowerCase());
      if (!L) {
        if (!newLocations.includes(lname)) newLocations.push(lname);
        res.notes.push(`Adds the location "${lname}"`);
        if (!dryRun && !res.problems.length) {
          const sortOrder = locations.reduce((m, x) => Math.max(m, x.sortOrder), 0) + 1;
          L = { id: await saveLocation(db, { name: lname, notes: lnote, sortOrder }), name: lname, notes: lnote, sortOrder };
          locations.push(L);
        }
      }
      const prev = ex && (ex.locations || []).find(x => (L && Number(x.locationId) === L.id) || String(x.label || "").toLowerCase() === lname.toLowerCase());
      res.locations.push(L ? L.name : lname);
      if (L || prev) locEntries.push({ key: (prev && prev.key) || "loc" + L.id, label: L ? L.name : prev.label, locationId: L ? L.id : (prev.locationId || null),
        graphicIds: prev ? (prev.graphicIds || []) : graphicIds.slice() });
    }
    // Locations the product already has that the file doesn't mention stay (with their graphics).
    if (ex) for (const x of (ex.locations || [])) if (!locEntries.some(e => e.key === x.key)) locEntries.push(x);

    if (res.problems.length) { skipped++; continue; }
    res.action = ex ? "update" : "create";
    const configurable = garmentColors.length > 0 || locEntries.length > 0 || !!(ex && ex.configurable);
    const p = {
      productId, type, name: res.name, sub: (r.description || r.sub || "").slice(0, 600),
      features: importList_(r.features, 300).slice(0, 20),
      pricingMode: flat ? "flat" : "sized", flatPrice: flat ? price : null, sizePricing: flat ? {} : sizePricing,
      personalizationPrice: hasPers ? pers : (ex ? ex.personalizationPrice : null),
      visible: importBool_(r.active !== undefined ? r.active : r.visible, ex ? ex.visible : true),
      configurable, garmentColors, locations: locEntries,
      // Not in the file — carried over untouched on an update, defaults on a new product.
      weightOz: ex ? ex.weightOz : null, personalizationOptions: ex ? ex.personalizationOptions : [],
      images: ex ? ex.images : [], sortOrder: ex ? ex.sortOrder : nextSort++, taxable: ex ? ex.taxable : true,
    };
    // Optional: TRUE for a transfer-only (DTF) product, so the catalog check doesn't ask for a design.
    if (Object.prototype.hasOwnProperty.call(r, "no_design_needed") && r.no_design_needed !== "") p.noDesignNeeded = importBool_(r.no_design_needed, false);
    if (!dryRun) { if (ex) await updateProduct(db, orgId, p); else await createProduct(db, orgId, p); }
    if (ex) updated++; else created++;

    // Link every color × size to the blank.
    const style = r.blank_style || r.blank || r.blank_sku || "";
    if (!style) { res.notes.push("No blank_style — not linked to a blank (stock and cost won't be tracked)"); continue; }
    const blank = blankBySku.get(style.toLowerCase());
    if (!blank) { res.blank = { style, found: false, links: 0 }; res.notes.push(`Blank "${style}" isn't in Blanks yet — import the blanks file first, then import this again to link it`); continue; }
    if (blank.productType && blank.productType !== type) res.notes.push(`Blank "${style}" is filed as ${blank.productType}, this product as ${type}`);
    const wantColors = [...allColors]; for (const c of garmentColors) if (!ci(wantColors, c)) wantColors.push(c);
    const did = await ensureBlankColorSizes_(db, blank.id, wantColors, null, { dryRun });
    if (did.addedColors.length) res.notes.push(`Adds ${did.addedColors.length} color${did.addedColors.length === 1 ? "" : "s"} to the blank`);
    const productColors = garmentColors.length ? garmentColors : [""];
    const missing = [], linkRows = [];
    let n = 0;
    for (const pc of productColors) {
      const blankColor = pc ? ci(did.colors, pc) : (did.colors.includes("") ? "" : (did.colors[0] || ""));
      if (blankColor === undefined) continue;
      for (const ps of sizes) {
        const blankSize = ci(did.sizes, ps) || (flat && did.sizes.length === 1 ? did.sizes[0] : undefined);
        if (blankSize === undefined) { if (!missing.includes(ps)) missing.push(ps); continue; }
        linkRows.push([orgId, productId, pc, ps, Number(blank.id), blankColor, blankSize]);
        n++;
      }
    }
    if (!dryRun && linkRows.length) await db.batch(importMultiInsert_(db,
      "INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize)", "(?, ?, ?, ?, ?, ?, ?)",
      "ON CONFLICT (orgId, productId, productColor, productSize) DO UPDATE SET blankId=excluded.blankId, blankColor=excluded.blankColor, blankSize=excluded.blankSize",
      linkRows, 14));
    linked += n;
    res.blank = { style, found: true, name: blank.name || "", links: n };
    if (missing.length) res.notes.push(`The blank has no cost for ${missing.join(", ")} — ${missing.length === 1 ? "that size isn't" : "those sizes aren't"} linked`);
  }
  return { dryRun, results: out, created, updated, skipped, linked, newLocations };
}

// ---- Order helpers -----------------------------------------------------

// range = {from, to} as YYYY-MM-DD (either optional): only orders placed in that window, so the
// admin Orders page (default: last 30 days) doesn't load a shop's whole history on every visit.
// Padded a day each side — the dates are the admin's local calendar days and placedAt
// is UTC — and the browser still applies the exact range (ordersDateFilter_), so nothing shown changes.
export async function getOrdersByOrg(db, orgId, range = {}) {
  const day = (s, add) => { const d = new Date(String(s) + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + add); return d.toISOString(); };
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s));
  const where = ["o.orgId = ?"], params = [orgId];
  if (valid(range.from)) { where.push("o.placedAt >= ?"); params.push(day(range.from, -1)); }
  if (valid(range.to))   { where.push("o.placedAt < ?");  params.push(day(range.to, 2)); }
  return loadOrders_(db, where.join(" AND "), params, "placedAt DESC");
}

// Every open order across all orgs: not completed, not voided, not a test, and at least one
// item that isn't cancelled (an order whose items are all cancelled is a cancelled order).
export async function getOpenOrders(db) {
  return loadOrders_(db,
    `o.completedAt IS NULL AND o.voidedAt IS NULL AND o.isTest = 0
     AND EXISTS (SELECT 1 FROM order_items ai WHERE ai.orderId = o.orderId AND ai.cancelDate IS NULL)`,
    [], "placedAt ASC");
}

// Loads full orders (items, payments, labels) matching a WHERE clause on `orders o`. The child
// tables are filtered with the same clause as a subquery rather than an IN (?, ?, …) list, so the
// number of orders is never limited by D1's cap on bound parameters per query.
// How many active lines with typed-in (free-form) personalization — or the customer's own design to
// stitch (migrations/0054) — have NO order-specific design uploaded yet (migrations/0032) — per
// order, for the orders matched by `where` on `orders o`. Digitizing complete and Design approved
// wait for those uploads (stagePrereqError). {} on a database without order_item_designs.
async function orderDesignsMissingBy_(db, where, binds) {
  const out = byId_();
  const hasConfig = await orderItemsHasConfigCol_(db);
  const hasLoc = await orderItemDesignsHasLocation_(db);
  try {
    // The lines that can need one (typed-in text, the customer's own design), with the locations
    // they have designs for; orderDesignsMissingOnLine_ counts what's still missing.
    const { results } = await db.prepare(
      `SELECT ax.orderId, ax.personalized, ax.persName, ${hasConfig ? "ax.configJson" : "'' AS configJson"}, px.personalizationOptions,
              (SELECT json_group_array(${hasLoc ? "z.location" : "''"}) FROM order_item_designs z WHERE z.itemId = ax.id) AS designLocs
       FROM order_items ax
       LEFT JOIN products px ON px.orgId = ax.orgId AND px.productId = ax.productId
       WHERE ax.orderId IN (SELECT o.orderId FROM orders o WHERE ${where})
         AND ${featureOnSql_("production")}
         AND ax.cancelDate IS NULL
         AND (ax.personalized = 1${hasConfig ? ` OR ax.configJson LIKE '%"custom":true%'` : ""})`).bind(...binds).all();
    for (const r of results) {
      const n = orderDesignsMissingOnLine_(r, new Set((tryParse_(r.designLocs, []) || []).map(String)));
      if (n) out[r.orderId] = (out[r.orderId] || 0) + n;
    }
  } catch (e) { if (!/no such (table|column)/i.test(String(e && e.message))) throw e; }
  return out;
}

// A lookup keyed by an id someone else chose (an order id comes from the browser). It has no
// prototype, so it holds exactly what was put in it: with a plain {} an order called "constructor"
// or "toString" would find Object's own members there, and listing orders would fail for good.
export function byId_() { return Object.create(null); }

async function loadOrders_(db, where, binds, orderBy) {
  const stage = await stageSql_(db);
  const { results: orderRows } = await db.prepare(
    `SELECT o.*, ${stage.approval} AS needsDesignApproval, ${stage.digitizing} AS needsDigitizing FROM orders o WHERE ${where} ORDER BY ${orderBy}`
  ).bind(...binds).all();

  if (!orderRows.length) return [];
  const missing = await orderDesignsMissingBy_(db, where, binds);
  for (const r of orderRows) r.orderDesignsMissing = missing[r.orderId] || 0;

  const sub = `SELECT o.orderId FROM orders o WHERE ${where}`;
  const { results: itemRows } = await db.prepare(
    `SELECT * FROM order_items WHERE orderId IN (${sub}) ORDER BY id`
  ).bind(...binds).all();

  const { results: paymentRows } = await db.prepare(
    `SELECT * FROM order_payments WHERE orderId IN (${sub}) ORDER BY receivedAt ASC`
  ).bind(...binds).all();

  const itemsByOrder = byId_();
  for (const it of itemRows) {
    if (!itemsByOrder[it.orderId]) itemsByOrder[it.orderId] = [];
    itemsByOrder[it.orderId].push(parseItem_(it));
  }

  const paymentsByOrder = byId_();
  for (const p of paymentRows) {
    if (!paymentsByOrder[p.orderId]) paymentsByOrder[p.orderId] = [];
    paymentsByOrder[p.orderId].push(parsePayment_(p));
  }

  const { results: labelRows } = await db.prepare(
    `SELECT * FROM shipping_labels WHERE orderId IN (${sub}) ORDER BY purchasedAt ASC`
  ).bind(...binds).all();
  const labelsByOrder = byId_();
  for (const l of labelRows) (labelsByOrder[l.orderId] = labelsByOrder[l.orderId] || []).push(parseLabel_(l));

  // Blank (garment) shipments per order (migrations/0039) — the Blank Shipped cell links them and
  // the edit modal loads them. Scoped by the SAME order subquery the joins above use, so a large
  // Orders page can't hit D1's bound-parameter cap. A pre-migration DB yields {} internally.
  const shipmentsByOrder = await blankShipmentsByOrder_(db, { sub, binds });

  return orderRows.map((r) => {
    const o = parseOrder_(r, itemsByOrder[r.orderId] || [], paymentsByOrder[r.orderId] || [], labelsByOrder[r.orderId] || []);
    o.blankShipments = shipmentsByOrder[r.orderId] || [];
    return o;
  });
}

export async function getOrderById(db, orderId) {
  const stage = await stageSql_(db);
  const row = await db.prepare(`SELECT o.*, ${stage.approval} AS needsDesignApproval, ${stage.digitizing} AS needsDigitizing FROM orders o WHERE o.orderId=?`).bind(orderId).first();
  if (!row) return null;
  row.orderDesignsMissing = (await orderDesignsMissingBy_(db, "o.orderId=?", [orderId]))[orderId] || 0;
  const { results: itemRows } = await db.prepare(
    "SELECT * FROM order_items WHERE orderId=? ORDER BY id"
  ).bind(orderId).all();
  const { results: paymentRows } = await db.prepare(
    "SELECT * FROM order_payments WHERE orderId=? ORDER BY receivedAt ASC"
  ).bind(orderId).all();
  const { results: labelRows } = await db.prepare(
    "SELECT * FROM shipping_labels WHERE orderId=? ORDER BY purchasedAt ASC"
  ).bind(orderId).all();
  const order = parseOrder_(row, itemRows.map(parseItem_), paymentRows.map(parsePayment_), labelRows.map(parseLabel_));
  order.blankShipments = await getBlankShipmentsForOrder(db, orderId).catch(() => []);
  return order;
}

// Atomic insert: order header + all items in one batch.
export async function insertOrder(db, order, pricedItems) {
  const stmts = [];
  // configJson is additive (migrations/0036); tolerate a pre-0036 schema (tests pin older subsets).
  let hasConfig = false;
  try { const { results } = await db.prepare("PRAGMA table_info(order_items)").all(); hasConfig = results.some(c => c.name === "configJson"); } catch (e) { /* ignore */ }

  // Line and order totals are computed here in integer cents from the unit
  // prices, not taken from the caller's floating-point dollar sums.
  const lines = pricedItems.map((it) => {
    const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
    const unitCents = toCents(it.unitPrice);
    const feeCents = toCents(it.personalizationFee || 0);
    return { it, qty, unitCents, feeCents, lineCents: qty * (unitCents + feeCents) };
  });
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineCents, 0);
  const shippingCents = Math.max(0, toCents(order.shippingCost || 0));

  // Sales tax: today's rate unless the org is tax-exempt; both are snapshotted
  // on the order so later rate/exemption changes never rewrite history.
  const [taxSettings, orgRow] = await Promise.all([
    getSalesTaxSettings(db),
    db.prepare("SELECT taxExempt FROM orgs WHERE orgId=?").bind(order.orgId).first(),
  ]);
  const taxExempt = orgRow && orgRow.taxExempt ? 1 : 0;
  const orderRateBps = Number(taxSettings.rateBps) || 0;
  // Tax in the listed prices, or added to them: today's setting, kept on the order (migrations/0052).
  const mode = taxMode_(order.taxMode || taxSettings.taxMode);
  const outOfState = isOutOfState(stateOf_(order.shippingAddress), taxSettings.jurisdiction);
  const lineRateBps = taxExempt || outOfState ? 0 : orderRateBps;
  // Each line's taxable flag: the catalog product's, or the caller's for a
  // custom (local-sale) line; default taxable.
  const { results: prodRows } = await db.prepare("SELECT productId, taxable FROM products WHERE orgId=?").bind(order.orgId).all();
  const productTaxable = Object.fromEntries(prodRows.map(r => [r.productId, !!r.taxable]));
  const lineTaxable = (it) => (it.productId && it.productId in productTaxable) ? productTaxable[it.productId] : it.taxable !== false;

  const taxed = lines.map(({ it, lineCents }) => {
    const taxable = lineTaxable(it), rate = taxable ? lineRateBps : 0;
    return { taxable, rate, taxCents: taxOn_(lineCents, rate, mode) };
  });
  const taxAddedCents = mode === "exclusive" ? taxed.reduce((sum, t) => sum + t.taxCents, 0) : 0;

  // orders.taxMode is only named when it isn't the column's default, so an order can still be
  // written to a database from before migrations/0052 (where everything is inclusive).
  stmts.push(db.prepare(`INSERT INTO orders
    (orderId,orgId,customerName,contact,paymentMethod,subtotalCents,shippingCostCents,totalCents,
     shippingMethod,shippingAddress,totalWeightOz,placedAt,taxExempt,taxRateBps,isTest${mode === "exclusive" ? ",taxMode" : ""})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${mode === "exclusive" ? ",'exclusive'" : ""})`)
    .bind(
      order.orderId, order.orgId, order.customerName, order.contact,
      order.paymentMethod || "", subtotalCents,
      shippingCents, subtotalCents + shippingCents + taxAddedCents,
      order.shippingMethod || "",
      order.shippingAddress ? JSON.stringify(order.shippingAddress) : null,
      order.totalWeightOz || 0, order.placedAt || new Date().toISOString(),
      taxExempt, orderRateBps,
      // Admin test transactions (createTestTransaction) stay out of sales.
      order.isTest ? 1 : 0
    ));

  for (const [n, { it, qty, unitCents, feeCents, lineCents }] of lines.entries()) {
    const { taxable, rate, taxCents } = taxed[n];
    const baseBinds = [
      order.orderId, order.orgId, it.productId || "",
      it.name, it.type, it.size || "", qty,
      unitCents, it.personalized ? 1 : 0, it.persName || "",
      feeCents, lineCents, rate, taxCents, taxable ? 1 : 0,
    ];
    if (hasConfig) {
      stmts.push(db.prepare(`INSERT INTO order_items
        (orderId,orgId,productId,name,type,size,qty,unitPriceCents,personalized,persName,
         personalizationFeeCents,lineTotalCents,taxRateBps,taxCents,taxable,configJson)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...baseBinds, it.config ? JSON.stringify(it.config) : ""));
    } else {
      stmts.push(db.prepare(`INSERT INTO order_items
        (orderId,orgId,productId,name,type,size,qty,unitPriceCents,personalized,persName,
         personalizationFeeCents,lineTotalCents,taxRateBps,taxCents,taxable)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(...baseBinds));
    }
    // The customer's own design files for this line (migrations/0054), recorded on the line as it is
    // written: the line just inserted is this order's highest id, and the batch is one transaction.
    for (const f of (Array.isArray(it.customFiles) ? it.customFiles : [])) {
      stmts.push(db.prepare(`INSERT INTO order_item_files (itemId, fileKey, fileName, fileExt, uploadedBy, createdAt)
        SELECT max(id), ?, ?, ?, 'customer', ? FROM order_items WHERE orderId=?`)
        .bind(String(f.fileKey), String(f.fileName || "").slice(0, 120), String(f.fileExt || ""), order.placedAt || new Date().toISOString(), order.orderId));
    }
  }

  await db.batch(stmts);
  // What was recorded, in dollars: `total` is what the customer owes (tax included either way).
  const taxCents = taxed.reduce((sum, t) => sum + t.taxCents, 0);
  return { taxMode: mode, subtotal: fromCents(subtotalCents), shippingCost: fromCents(shippingCents), salesTax: fromCents(taxCents),
    total: fromCents(subtotalCents + shippingCents + taxAddedCents) };
}

// Kept for callers that mean "this order is paid": records the outstanding
// balance in the ledger (see settleOrderBalance) instead of flipping a flag
// the ledger doesn't back up.
export async function setOrderPaid(db, orderId, _paidAt, note) {
  return settleOrderBalance(db, orderId, note || "Marked paid");
}

export async function setOrderRefunded(db, orderId, refundedAt) {
  await db.prepare("UPDATE orders SET refundedAt=? WHERE orderId=?")
    .bind(refundedAt || new Date().toISOString(), orderId).run();
}

export async function setOrderDisputeStatus(db, orderId, status) {
  await db.prepare("UPDATE orders SET disputeStatus=? WHERE orderId=?")
    .bind(status, orderId).run();
}

export async function setOrderEmailTimestamp(db, orderId, field, ts) {
  // field must be one of the safe column names
  const allowed = { receivedEmailAt: true, confirmedEmailAt: true };
  if (!allowed[field]) throw new Error("Invalid email timestamp field");
  await db.prepare(`UPDATE orders SET ${field}=? WHERE orderId=?`)
    .bind(ts, orderId).run();
}

// The admin's stage order (mirrors FULFILLMENT_STAGES in admin.js), checked on the server so a
// stage can't be skipped through the API: returns "" when `stage` may be set on order `o`, else
// why not. Deliberately NOT applied to the automatic paths that set a stage because something
// real happened — a customer approving their design (verify.js), a local sale handed over in
// person, the carrier scanning a package (deliveryCheck.js). Delivered needs QA & packed, not
// Shipped: pickup orders go straight from packed to delivered.
// Mark manufactured needs the blank received, plus the design approved — or, for an order with no
// free-form personalization (needsDesignApproval false, see NEEDS_DESIGN_APPROVAL_SQL_), digitizing
// done, unless every product on it already has a design (needsDigitizing false).
function manufacturedPrereq_(o) {
  const needsApproval = o.needsDesignApproval !== false, needsDigitizing = o.needsDigitizing !== false;
  if (needsApproval && !o.designApprovedAt) return [false, "the design isn't approved yet"];
  if (!needsApproval && needsDigitizing && !o.digitizingCompleteAt) return [false, "digitizing isn't complete yet"];
  return [!!o.blankReceivedAt, "the blank hasn't been received yet"];
}

export function stagePrereqError(o, stage) {
  if (!o) return "order not found";
  // The typed-in name has to be digitized and uploaded (Edit items → Files → Order design) before
  // digitizing counts as done or the design can be approved.
  if ((stage === "digitizingComplete" || stage === "designApproved") && Number(o.orderDesignsMissing) > 0) {
    const n = Number(o.orderDesignsMissing);
    return `${n} order design${n === 1 ? " hasn't" : "s haven't"} been uploaded yet (Edit items → Files → Order design)`;
  }
  const need = {
    blankOrdered:       [o.paid, "the order isn't paid yet"],
    blankShipped:       [o.blankOrderedAt, "the blank hasn't been ordered yet"],
    blankReceived:      [o.blankOrderedAt, "the blank hasn't been ordered yet"],
    digitizingComplete: [o.paid, "the order isn't paid yet"],
    designApproved:     [o.needsDigitizing === false ? o.paid : o.digitizingCompleteAt, o.needsDigitizing === false ? "the order isn't paid yet" : "digitizing isn't complete yet"],
    manufactured:       manufacturedPrereq_(o),
    qaPacked:           [o.manufacturedAt, "it isn't manufactured yet"],
    shipped:            [o.qaPackedAt, "it isn't QA'd and packed yet"],
    delivered:          [o.qaPackedAt, "it isn't QA'd and packed yet"],
  }[stage];
  if (!need) return "unknown stage";
  return need[0] ? "" : need[1];
}

// Returns { changed } — for "shipped", whether this call is what moved the order from not shipped
// to shipped (the customer's shipped email goes out exactly once, on that transition). Shipped is
// never overwritten once set: re-marking only fills in a tracking number.
// Which active line items a per-item blank stage applies to: extras.itemIds if given, else all
// active lines of the order. Returns an array of numeric ids.
async function blankTargetItemIds_(db, orderId, extras) {
  if (Array.isArray(extras.itemIds) && extras.itemIds.length) {
    const want = new Set(extras.itemIds.map(Number).filter(Boolean));
    const { results } = await db.prepare("SELECT id FROM order_items WHERE orderId=? AND cancelDate IS NULL").bind(orderId).all();
    return results.map(r => Number(r.id)).filter(id => want.has(id));
  }
  const { results } = await db.prepare("SELECT id FROM order_items WHERE orderId=? AND cancelDate IS NULL").bind(orderId).all();
  return results.map(r => Number(r.id));
}

// Recomputes the order-level blank summary columns (migrations/0039) from its active line items,
// so every order-level reader (completion, CSV, prereqs, queues' legacy fallback) stays correct:
// orders.blankOrderedAt is set only when EVERY active line is ordered, blankReceivedAt only when
// every active line is received; vendor/est-delivery/condition summarize the items.
async function recomputeOrderBlankStatus_(db, orderId) {
  const { results: active } = await db.prepare(
    `SELECT blankOrderedAt, blankReceivedAt, blankVendor, blankVendorOrderId, blankEstDelivery, blankCondition
     FROM order_items WHERE orderId=? AND cancelDate IS NULL`).bind(orderId).all();
  const n = active.length;
  const ordered = active.filter(r => r.blankOrderedAt);
  const received = active.filter(r => r.blankReceivedAt);
  const orderedAt = n > 0 && ordered.length === n ? ordered.map(r => r.blankOrderedAt).sort()[0] : null;
  const receivedAt = n > 0 && received.length === n ? received.map(r => r.blankReceivedAt).sort().slice(-1)[0] : null;
  const withVendor = ordered.find(r => r.blankVendor) || ordered[0] || {};
  const ests = ordered.map(r => r.blankEstDelivery).filter(Boolean).sort();
  const condition = receivedAt ? (active.some(r => r.blankCondition === "Other") ? "Other" : "Good") : "";
  await db.prepare(
    `UPDATE orders SET blankOrderedAt=?, blankReceivedAt=?, blankVendor=?, blankVendorOrderId=?, blankEstDelivery=?, blankCondition=? WHERE orderId=?`
  ).bind(orderedAt, receivedAt, withVendor.blankVendor || "", withVendor.blankVendorOrderId || "",
    ests.slice(-1)[0] || null, condition, orderId).run();
}

export async function setFulfillmentStage(db, orderId, stage, extras = {}) {
  const STAGE_COL = {
    blankOrdered:        "blankOrderedAt",
    blankShipped:        "blankShippedAt",
    blankReceived:       "blankReceivedAt",
    manufactured:        "manufacturedAt",
    digitizingComplete:  "digitizingCompleteAt",
    designApproved:      "designApprovedAt",
    qaPacked:            "qaPackedAt",
    shipped:             "shippedAt",
    delivered:           "deliveredAt",
  };
  const col = STAGE_COL[stage];
  if (!col) throw new Error("Invalid fulfillment stage: " + stage);

  const now = new Date().toISOString();
  if (stage === "blankOrdered") {
    // Stamp the chosen line items (default all active) with the vendor order, then roll up to orders.
    const ids = await blankTargetItemIds_(db, orderId, extras);
    for (const id of ids) {
      await db.prepare(`UPDATE order_items SET blankOrderedAt=COALESCE(blankOrderedAt, ?), blankVendor=?, blankVendorOrderId=?, blankEstDelivery=? WHERE id=? AND orderId=? AND cancelDate IS NULL`)
        .bind(now, extras.vendor || "", extras.vendorOrderId || "", extras.estimatedDelivery || null, id, orderId).run();
    }
    await recomputeOrderBlankStatus_(db, orderId);
  } else if (stage === "blankShipped") {
    // Mark the chosen items shipped (tracking numbers are added separately via addBlankShipment).
    const ids = await blankTargetItemIds_(db, orderId, extras);
    for (const id of ids) {
      await db.prepare(`UPDATE order_items SET blankShippedAt=COALESCE(blankShippedAt, ?) WHERE id=? AND orderId=? AND cancelDate IS NULL`)
        .bind(extras.shippedAt || now, id, orderId).run();
    }
    await recomputeOrderBlankStatus_(db, orderId);
  } else if (stage === "blankReceived") {
    const ids = await blankTargetItemIds_(db, orderId, extras);
    const condByItem = {};
    if (Array.isArray(extras.itemConditions)) for (const ic of extras.itemConditions) {
      const itemId = ic.itemId != null ? ic.itemId : ic.sheetRow;
      if (itemId != null) condByItem[Number(itemId)] = { condition: ic.condition || "Good", note: ic.note || "" };
    }
    for (const id of ids) {
      const c = condByItem[id] || { condition: extras.blankCondition || "Good", note: "" };
      await db.prepare(`UPDATE order_items SET blankReceivedAt=COALESCE(blankReceivedAt, ?), blankCondition=?, blankConditionNote=? WHERE id=? AND orderId=? AND cancelDate IS NULL`)
        .bind(now, c.condition, c.note, id, orderId).run();
    }
    await recomputeOrderBlankStatus_(db, orderId);
  } else if (stage === "shipped") {
    const before = await db.prepare("SELECT shippedAt FROM orders WHERE orderId=?").bind(orderId).first();
    const r = extras.trackingNumber
      ? await db.prepare(`UPDATE orders SET shippedAt = COALESCE(shippedAt, ?), trackingNumber=? WHERE orderId=?`)
          .bind(now, extras.trackingNumber, orderId).run()
      : await db.prepare(`UPDATE orders SET shippedAt = COALESCE(shippedAt, ?) WHERE orderId=?`).bind(now, orderId).run();
    return { changed: !!before && !before.shippedAt && Number(r && r.meta && r.meta.changes) > 0 };
  } else {
    await db.prepare(`UPDATE orders SET ${col}=? WHERE orderId=?`).bind(now, orderId).run();
  }
  // Making the order uses up its blanks: record them as COGS.
  if (stage === "manufactured") await consumeBlanksForOrder(db, orderId);
  return { changed: true };
}

// ---- Completed orders (migrations/0016) --------------------------------------
// An order can be COMPLETED once it's delivered and paid in full: that closes it
// out, and the orders screen then hides it unless "Include completed" is ticked.
// Returns why an order can't be completed yet ("" = it can).
export function whyNotCompletable_(o) {
  if (!o) return "order not found";
  if (o.voidedAt) return "the order is voided";
  if (o.completedAt) return "already completed";
  if (!Number(o.activeItems)) return "every item is cancelled";
  if (!o.deliveredAt) return "not delivered yet";
  if (!o.paid) return "a balance is still due";
  return "";
}

// completed=true closes each order that qualifies; completed=false reopens.
// Returns {updated, skipped:[{orderId, reason}]} — never throws for one bad order.
export async function setOrdersCompleted(db, orderIds, completed) {
  const out = { updated: [], skipped: [] };
  const now = new Date().toISOString();
  for (const orderId of orderIds) {
    const o = await db.prepare(
      `SELECT o.orderId, o.orgId, o.voidedAt, o.completedAt, o.deliveredAt, o.paid,
              (SELECT count(*) FROM order_items i WHERE i.orderId = o.orderId AND i.cancelDate IS NULL) AS activeItems
         FROM orders o WHERE o.orderId = ?`).bind(orderId).first();
    if (!o) { out.skipped.push({ orderId, reason: "order not found" }); continue; }
    if (completed) {
      const why = whyNotCompletable_(o);
      if (why) { out.skipped.push({ orderId, reason: why }); continue; }
      await db.prepare("UPDATE orders SET completedAt = ? WHERE orderId = ? AND completedAt IS NULL").bind(now, orderId).run();
    } else {
      if (!o.completedAt) { out.skipped.push({ orderId, reason: "not completed" }); continue; }
      await db.prepare("UPDATE orders SET completedAt = NULL WHERE orderId = ?").bind(orderId).run();
    }
    out.updated.push({ orderId, orgId: o.orgId });
  }
  return out;
}

// ---- Delivery check (the 6 AM roll-up) ---------------------------------------
// Shipped orders still waiting on a delivery, with a tracking number to look up
// (the order's own, else its site-bought label's) and the carrier to ask.
export async function getShippedAwaitingDelivery(db, limit = 40) {
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT o.orderId, o.orgId, o.customerName, o.shippedAt, o.shippingMethod, o.paid,
         COALESCE(NULLIF(o.trackingNumber, ''),
           (SELECT l.trackingNumber FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL AND l.trackingNumber <> '' ORDER BY l.id DESC LIMIT 1), '') AS tracking,
         (SELECT l.carrier FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL ORDER BY l.id DESC LIMIT 1) AS labelCarrier
       FROM orders o
       WHERE o.shippedAt IS NOT NULL AND o.deliveredAt IS NULL AND o.completedAt IS NULL
         AND o.voidedAt IS NULL AND o.isTest = 0
     ) WHERE tracking <> '' ORDER BY shippedAt ASC LIMIT ?`).bind(Math.max(1, Math.min(200, Number(limit) || 40))).all();
  return results.map(r => ({ orderId: r.orderId, orgId: r.orgId, customerName: r.customerName, shippedAt: r.shippedAt,
    shippingMethod: r.shippingMethod || "", paid: !!r.paid, tracking: r.tracking, labelCarrier: r.labelCarrier || "" }));
}

// Orders with a label or tracking number that AREN'T marked shipped yet — a label existing doesn't
// mean the carrier has the package. The daily check looks these up and marks one shipped only once
// tracking shows a carrier scan (dated by that scan). Oldest label first.
export async function getLabeledAwaitingShipment(db, limit = 40) {
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT o.orderId, o.orgId, o.customerName, o.shippingMethod, o.paid,
         COALESCE(NULLIF(o.trackingNumber, ''),
           (SELECT l.trackingNumber FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL AND l.trackingNumber <> '' ORDER BY l.id DESC LIMIT 1), '') AS tracking,
         (SELECT l.carrier FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL ORDER BY l.id DESC LIMIT 1) AS labelCarrier,
         (SELECT l.purchasedAt FROM shipping_labels l WHERE l.orderId = o.orderId AND l.voidedAt IS NULL ORDER BY l.id DESC LIMIT 1) AS labelAt
       FROM orders o
       WHERE o.shippedAt IS NULL AND o.deliveredAt IS NULL AND o.completedAt IS NULL
         AND o.voidedAt IS NULL AND o.isTest = 0
     ) WHERE tracking <> '' ORDER BY COALESCE(labelAt, '') ASC LIMIT ?`).bind(Math.max(1, Math.min(200, Number(limit) || 40))).all();
  return results.map(r => ({ orderId: r.orderId, orgId: r.orgId, customerName: r.customerName, labelAt: r.labelAt || "",
    shippingMethod: r.shippingMethod || "", paid: !!r.paid, tracking: r.tracking, labelCarrier: r.labelCarrier || "" }));
}

// Marks an order shipped from a carrier scan — only if it isn't already (a person may have got
// there first). Returns true when this call is what marked it.
export async function markOrderShippedByCarrier(db, orderId, iso) {
  const r = await db.prepare("UPDATE orders SET shippedAt = ? WHERE orderId = ? AND shippedAt IS NULL")
    .bind(iso || new Date().toISOString(), orderId).run();
  return !!(r && r.meta && r.meta.changes > 0);
}

// Marks an order delivered — only if it isn't already (a person may have got there first).
export async function markOrderDelivered(db, orderId, iso) {
  const r = await db.prepare("UPDATE orders SET deliveredAt = ? WHERE orderId = ? AND deliveredAt IS NULL")
    .bind(iso || new Date().toISOString(), orderId).run();
  return !!(r && r.meta && r.meta.changes > 0);
}

export async function setTrackingNumbers(db, orderIds, trackingNumber) {
  const results = { updated: 0, skipped: 0, errors: [] };
  for (const orderId of orderIds) {
    try {
      const r = await db.prepare("UPDATE orders SET trackingNumber=? WHERE orderId=?")
        .bind(trackingNumber, orderId).run();
      if (r.meta.changes > 0) results.updated++;
      else results.skipped++;
    } catch (e) {
      results.errors.push(orderId + ": " + e.message);
    }
  }
  return results;
}

export async function cancelLineItem(db, itemId) {
  const now = new Date().toISOString();
  // Check if blank has already been ordered (lateCancel)
  const item = await db.prepare("SELECT orderId FROM order_items WHERE id=?").bind(itemId).first();
  if (!item) return { lateCancel: false };
  const order = await db.prepare("SELECT blankOrderedAt FROM orders WHERE orderId=?").bind(item.orderId).first();
  const lateCancel = !!(order && order.blankOrderedAt);
  await db.prepare("UPDATE order_items SET cancelDate=?, lateCancel=? WHERE id=?")
    .bind(now, lateCancel ? 1 : 0, itemId).run();
  await refreshPaidStatus(db, item.orderId);
  return { lateCancel };
}

export async function cancelLineItemWithReason(db, itemId, reason) {
  const now = new Date().toISOString();
  const item = await db.prepare("SELECT orderId FROM order_items WHERE id=?").bind(itemId).first();
  if (!item) return { lateCancel: false };
  const order = await db.prepare("SELECT blankOrderedAt FROM orders WHERE orderId=?").bind(item.orderId).first();
  const lateCancel = !!(order && order.blankOrderedAt);
  await db.prepare("UPDATE order_items SET cancelDate=?, cancelReason=?, lateCancel=? WHERE id=?")
    .bind(now, reason || "", lateCancel ? 1 : 0, itemId).run();
  await refreshPaidStatus(db, item.orderId);
  return { lateCancel };
}

export async function setLineItemRefund(db, itemId, refundAmount) {
  await db.prepare("UPDATE order_items SET refundDate=?, refundCents=? WHERE id=?")
    .bind(new Date().toISOString(), Math.max(0, toCents(refundAmount)), itemId).run();
}

export async function getOrderItemById(db, itemId) {
  const row = await db.prepare("SELECT * FROM order_items WHERE id=?").bind(Number(itemId)).first();
  return row ? parseItem_(row) : null;
}

// configJson is additive (migrations/0036); cached per-db so pre-0036 schemas (some tests) skip it.
async function orderItemsHasConfigCol_(db) {
  if (db.__oiHasConfig === undefined) {
    try { const { results } = await db.prepare("PRAGMA table_info(order_items)").all(); db.__oiHasConfig = results.some(c => c.name === "configJson"); }
    catch (e) { db.__oiHasConfig = false; }
  }
  return db.__oiHasConfig;
}

export async function updateOrderItem(db, id, { productId, name, type, size, qty, unitPrice, personalized, persName, personalizationFee, taxable: taxableIn, config }) {
  const q = Math.max(1, Math.floor(Number(qty) || 1));
  const unitCents = Math.max(0, toCents(unitPrice)), feeCents = Math.max(0, toCents(personalizationFee));
  const lineCents = q * (unitCents + feeCents);
  const item = await db.prepare("SELECT orderId, orgId FROM order_items WHERE id=?").bind(Number(id)).first();
  if (!item) return;
  const taxable = await productTaxable_(db, item.orgId, productId, taxableIn);
  await db.prepare(
    `UPDATE order_items SET productId=?, name=?, type=?, size=?, qty=?, unitPriceCents=?, personalized=?, persName=?, personalizationFeeCents=?, lineTotalCents=?, taxable=? WHERE id=?`
  ).bind(
    productId || "", name || "", type || "", size || "",
    q, unitCents,
    personalized ? 1 : 0, persName || "",
    feeCents, lineCents, taxable ? 1 : 0,
    Number(id)
  ).run();
  // Only overwrite the configurable snapshot when a (re-validated) one was supplied — undefined
  // leaves a classic line's empty config alone.
  if (config !== undefined && await orderItemsHasConfigCol_(db)) {
    await db.prepare("UPDATE order_items SET configJson=? WHERE id=?").bind(config ? JSON.stringify(config) : "", Number(id)).run();
  }
  await recomputeOrderTax_(db, item.orderId);
}

// A catalog product's taxable flag; for a custom line (no such product) the
// caller's value, default taxable.
async function productTaxable_(db, orgId, productId, fallback) {
  if (productId) {
    const r = await db.prepare("SELECT taxable FROM products WHERE orgId=? AND productId=?").bind(orgId, productId).first();
    if (r) return !!r.taxable;
  }
  return fallback !== false;
}

export async function addOrderItem(db, orderId, orgId, { productId, name, type, size, qty, unitPrice, personalized, persName, personalizationFee, taxable: taxableIn, config }) {
  const q = Math.max(1, Math.floor(Number(qty) || 1));
  const unitCents = Math.max(0, toCents(unitPrice)), feeCents = Math.max(0, toCents(personalizationFee));
  const lineCents = q * (unitCents + feeCents);
  const taxable = await productTaxable_(db, orgId, productId, taxableIn);
  const result = await db.prepare(
    `INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPriceCents, personalized, persName, personalizationFeeCents, lineTotalCents, taxRateBps, taxCents, taxable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).bind(
    orderId, orgId, productId || "", name || "", type || "", size || "",
    q, unitCents,
    personalized ? 1 : 0, persName || "",
    feeCents, lineCents, taxable ? 1 : 0
  ).run();
  const newId = Number(result.meta.last_row_id);
  if (config && await orderItemsHasConfigCol_(db)) {
    await db.prepare("UPDATE order_items SET configJson=? WHERE id=?").bind(JSON.stringify(config), newId).run();
  }
  await recomputeOrderTax_(db, orderId);
  return newId;
}

export async function recalcOrderTotals(db, orderId) {
  const { subtotalCents, totalCents } = await storeOrderTotals_(db, orderId);
  await refreshPaidStatus(db, orderId);
  return { subtotal: fromCents(subtotalCents), total: fromCents(totalCents) };
}

export async function updateOrderShipping(db, orderId, { shippingAddress, totalWeightOz, shippingCost, shippingMethod, parcelLength, parcelWidth, parcelHeight }) {
  await db.prepare(
    "UPDATE orders SET shippingAddress=?, totalWeightOz=?, shippingCostCents=?, shippingMethod=?, parcelLength=?, parcelWidth=?, parcelHeight=? WHERE orderId=?"
  ).bind(
    shippingAddress ? JSON.stringify(shippingAddress) : null,
    Number(totalWeightOz) || 0,
    Math.max(0, toCents(shippingCost)),
    shippingMethod || "",
    Number(parcelLength) || 0,
    Number(parcelWidth)  || 0,
    Number(parcelHeight) || 0,
    orderId
  ).run();
  await recomputeOrderTax_(db, orderId);   // ship-to state decides whether it's taxed
  await refreshPaidStatus(db, orderId);
}

// Updates customer-facing fields on an order. Only non-null values in `updates`
// are written. phone/addressLine merge into the existing shippingAddress object.
// Permanently removes an order and all related rows. Irreversible.
export async function deleteOrder(db, orderId) {
  await db.batch([
    db.prepare("DELETE FROM order_items       WHERE orderId=?").bind(orderId),
    db.prepare("DELETE FROM design_verifications WHERE orderId=?").bind(orderId),
    db.prepare("DELETE FROM orders             WHERE orderId=?").bind(orderId),
  ]);
}

export async function updateOrderCustomerInfo(db, orderId, updates) {
  const { customerName, contact, phone, addressLine } = updates;
  const stmts = [];

  if (customerName !== undefined && customerName !== null) {
    stmts.push(db.prepare("UPDATE orders SET customerName=? WHERE orderId=?").bind(customerName, orderId));
  }
  if (contact !== undefined && contact !== null) {
    stmts.push(db.prepare("UPDATE orders SET contact=? WHERE orderId=?").bind(contact, orderId));
  }

  if ((phone !== undefined && phone !== null) || (addressLine !== undefined && addressLine !== null)) {
    const row = await db.prepare("SELECT shippingAddress FROM orders WHERE orderId=?").bind(orderId).first();
    let addr = {};
    if (row && row.shippingAddress) {
      try { addr = JSON.parse(row.shippingAddress); } catch {}
    }
    if (phone !== undefined && phone !== null)       addr.phone   = phone;
    if (addressLine !== undefined && addressLine !== null) addr.line1   = addressLine;
    stmts.push(db.prepare("UPDATE orders SET shippingAddress=? WHERE orderId=?")
      .bind(JSON.stringify(addr), orderId));
  }

  if (stmts.length > 0) await db.batch(stmts);
}

export async function getOrderForShipping(db, orderId) {
  const [row, itemRows] = await Promise.all([
    db.prepare("SELECT shippingAddress, totalWeightOz, customerName FROM orders WHERE orderId=?").bind(orderId).first(),
    db.prepare("SELECT type, qty FROM order_items WHERE orderId=? ORDER BY id").bind(orderId).all(),
  ]);
  if (!row) return null;
  return { ...row, items: (itemRows.results || []).map(r => ({ type: r.type, qty: r.qty })) };
}

// What /api/checkout needs before charging: the real total, whether it's
// already paid, and the org the order actually belongs to.
// What a card checkout should charge: the BALANCE still due — active items + shipping −
// discount − payments already received (orderAmounts, as refreshPaidStatus) — not orders.totalCents,
// which ignores discounts and anything already paid by Venmo/Zelle/check. Also returns whether
// the order is voided, and the customer's name/email from the order row (checkout.js uses these
// rather than trusting the request body).
export async function getOrderCheckoutState(db, orderId) {
  const row = await withTaxMode_((tm) => db.prepare(`
    SELECT o.paid, o.orgId, o.voidedAt, o.customerName, o.contact, o.shippingMethod, ${ORDER_AMOUNT_COLS_.replace("o.taxMode", tm + " AS taxMode")},
      COALESCE((SELECT SUM(amountCents) FROM order_payments
                WHERE orderId = o.orderId AND kind = 'payment' AND voidedAt IS NULL), 0) AS receivedCents
    FROM orders o WHERE o.orderId = ?`).bind(orderId).first());
  if (!row) return null;
  const amounts = orderAmountsOfRow_(row);
  const balanceCents = Math.max(0, amounts.owedCents - (Number(row.receivedCents) || 0));
  return {
    total: fromCents(balanceCents), paid: !!row.paid, orgId: row.orgId, voided: !!row.voidedAt,
    // Sales tax added on top of the listed prices and so part of what's charged (0 when the prices include it).
    taxAdded: fromCents(amounts.taxAddedCents),
    customerName: row.customerName || "", contact: row.contact || "",
    // Placed with shipping still to be quoted, and the shop hasn't set it yet (see SHIPPING_QUOTE_PENDING).
    shippingPending: row.shippingMethod === SHIPPING_QUOTE_PENDING && !(Number(row.shippingCostCents) > 0),
  };
}

export async function getOrderTotal(db, orderId) {
  const row = await db.prepare("SELECT totalCents FROM orders WHERE orderId=?").bind(orderId).first();
  return row ? fromCents(row.totalCents) : null;
}

// ---- Catalog data for getCatalogData() --------------------------------

export async function getPublicCatalogData(db) {
  const [orgs, baseSettings, salesTax, business, locale, features] = await Promise.all([
    getAllOrgs(db),
    getGlobalSettings(db),
    getSalesTaxSettings(db),
    getBusinessProfile(db),
    getLocaleSettings(db),
    getFeatures(db),
  ]);
  const globalSettings = { ...baseSettings, salesTax };

  // Build subdomainMap: { [subdomain]: orgId }
  const subdomainMap = {};
  for (const org of orgs) {
    subdomainMap[org.subdomain] = org.orgId;
  }

  // Enrich each org with its visible products; configurable products also need the org's visible
  // graphics (option tiles, with the tier add-on resolved) + tier prices (migrations/0036).
  const orgsWithProducts = await Promise.all(
    orgs.map(async (org) => {
      let products = await getProductsByOrg(db, org.orgId, true);
      // Blank color images (migrations/0037): each product's linked blank colors' images, keyed by
      // the product color the link is for, so the storefront can show the garment's photo per color
      // (preferred over a product's own images). Images only — no stock ever reaches the catalog.
      products = await attachBlankColorImages_(db, org.orgId, products);
      if (!products.some(p => p.configurable)) return { ...org, products };
      products = await attachProductGraphicImages_(db, org.orgId, products);   // per-location mockups (0042)
      const { tiersCents } = await getTierPrices(db, org.orgId);
      const graphics = (await listGraphics(db, org.orgId)).filter(g => g.visible).map(g => ({
        id: g.id, name: g.name, kind: g.kind, tier: g.tier, addOnCents: g.tier ? (tiersCents[g.tier] || 0) : 0,
        inkColors: g.inkColors, imageUrl: g.imageUrl, thumbUrl: g.thumbUrl,
        allowedLocations: g.allowedLocations, allowedGarmentColors: g.allowedGarmentColors,
      }));
      return { ...org, products, graphics, tierPricesCents: tiersCents };
    })
  );

  return {
    status: "ok",
    subdomainMap,
    orgs: Object.fromEntries(orgsWithProducts.map((o) => [o.orgId, o])),
    globalSettings,
    business: publicBusinessProfile(business),   // name, contact and payment details shown to visitors
    locale: { country: locale.country },         // address format the storefront's forms use (Region)
    features,                                    // which optional parts of the site are on (Features)
    version: "d1", // static — the cache is keyed by global_settings.catalogVersion
  };
}

// Attaches `colorImages` { <productColor>: [imageUrls] } to each product, resolved from its blank
// links to the linked blank colors' images (migrations/0037). Tolerates a pre-0037 DB (no
// blank_colors / link color columns) by yielding no images.
async function attachBlankColorImages_(db, orgId, products) {
  let rows = [];
  try {
    const r = await db.prepare(
      `SELECT l.productId, l.productColor, bc.imagesJson
       FROM product_blank_links l JOIN blank_colors bc ON bc.blankId = l.blankId AND bc.color = l.blankColor
       WHERE l.orgId = ?`
    ).bind(orgId).all();
    rows = r.results || [];
  } catch (e) { return products; }
  if (!rows.length) return products;
  const byProduct = {};
  for (const r of rows) {
    // Images may be legacy bare strings or {url, locationId} (migrations/0041); the storefront color
    // preview just wants the URLs, so flatten to url strings here (the location-aware preview
    // uses the separate product_graphic_images table, not this map).
    const imgs = (tryParse_(r.imagesJson, []) || []).map(normBlankImage_).filter(Boolean).map(x => x.url);
    if (!imgs.length) continue;
    const p = byProduct[r.productId] || (byProduct[r.productId] = {});
    if (!p[r.productColor || ""]) p[r.productColor || ""] = imgs;   // first non-empty wins per color
  }
  return products.map(p => byProduct[p.productId] ? { ...p, colorImages: byProduct[p.productId] } : p);
}

// ---- Per-location graphic × garment-color mockups (migrations/0042) ----------------------
// A configurable product's storefront preview: for each (location, graphic, garment color) the admin
// composed a mockup (a transparent graphic over the blank color photo). Keyed by the unique tuple.
const parseProductGraphicImage_ = (r) => ({ id: Number(r.id), orgId: r.orgId, productId: r.productId,
  locationId: Number(r.locationId), graphicId: Number(r.graphicId), garmentColor: r.garmentColor || "",
  imageUrl: r.imageUrl || "", thumbUrl: r.thumbUrl || "", placement: tryParse_(r.placementJson, {}) || {} });

export async function listProductGraphicImages(db, orgId, productId) {
  try {
    const { results } = await db.prepare(
      "SELECT * FROM product_graphic_images WHERE orgId=? AND productId=? ORDER BY locationId, graphicId, garmentColor"
    ).bind(orgId, productId).all();
    return results.map(parseProductGraphicImage_);
  } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; }
}

// The blank color photos available as an overlay BASE image, per (product garment color, location).
// Resolves product_blank_links → blank_colors images and groups by the product color + each image's
// location tag (migrations/0041). Key "<productColor>|<locationId>" for location-tagged photos, and
// "<productColor>|" for untagged ones (a fallback when a color has no location-specific photo).
export async function getProductLocationBaseImages(db, orgId, productId) {
  const out = {};
  let rows = [];
  try {
    const r = await db.prepare(
      `SELECT l.productColor, bc.imagesJson FROM product_blank_links l
       JOIN blank_colors bc ON bc.blankId = l.blankId AND bc.color = l.blankColor
       WHERE l.orgId = ? AND l.productId = ?`).bind(orgId, productId).all();
    rows = r.results || [];
  } catch (e) { return out; }   // pre-migration DB
  for (const r of rows) {
    const pc = r.productColor || "";
    const imgs = (tryParse_(r.imagesJson, []) || []).map(normBlankImage_).filter(Boolean);
    for (const im of imgs) {
      const k = pc + "|" + (im.locationId || "");
      (out[k] = out[k] || []).push(im.url);
      // Also under "<color>|*" (every photo of this color, regardless of its location tag) so the
      // overlay editor can always offer the blank's photos — location-matched ones just rank first.
      const all = (out[pc + "|*"] = out[pc + "|*"] || []);
      if (!all.includes(im.url)) all.push(im.url);
    }
  }
  return out;
}

// Upsert one mockup on its unique tuple. An empty imageUrl deletes the cell instead.
export async function setProductGraphicImage(db, m) {
  const orgId = String(m.orgId || ""), productId = String(m.productId || "");
  const locationId = Number(m.locationId) || 0, graphicId = Number(m.graphicId) || 0, garmentColor = String(m.garmentColor || "");
  if (!orgId || !productId || !locationId || !graphicId) throw pricingError_("A mockup needs an org, product, location and graphic.");
  if (!m.imageUrl) { await deleteProductGraphicImage(db, m); return; }
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO product_graphic_images (orgId, productId, locationId, graphicId, garmentColor, imageUrl, thumbUrl, placementJson, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(orgId, productId, locationId, graphicId, garmentColor)
     DO UPDATE SET imageUrl=excluded.imageUrl, thumbUrl=excluded.thumbUrl, placementJson=excluded.placementJson, updatedAt=excluded.updatedAt`
  ).bind(orgId, productId, locationId, graphicId, garmentColor,
    String(m.imageUrl).slice(0, 500), String(m.thumbUrl || "").slice(0, 500), JSON.stringify(safePlacement_(m.placement)), now, now).run();
}

// Keep only the overlay coords + real (non-data:) URLs. A base/graphic uploaded in the editor arrives
// as a huge base64 data: URL; storing it would blow D1's row/param size limit (and it's useless for
// reopening — the base/graphic are re-resolved), so drop it.
function safePlacement_(p) {
  p = p || {};
  const out = {};
  for (const k of ["xPct", "yPct", "wPct"]) { const n = Number(p[k]); if (isFinite(n)) out[k] = n; }
  for (const k of ["baseUrl", "graphicUrl"]) { const u = String(p[k] || ""); if (u && !/^data:/i.test(u) && u.length <= 500) out[k] = u; }
  return out;
}

export async function deleteProductGraphicImage(db, m) {
  await db.prepare(
    "DELETE FROM product_graphic_images WHERE orgId=? AND productId=? AND locationId=? AND graphicId=? AND garmentColor=?"
  ).bind(String(m.orgId || ""), String(m.productId || ""), Number(m.locationId) || 0, Number(m.graphicId) || 0, String(m.garmentColor || "")).run();
}

// Attaches `graphicImages` { "<locationId>|<graphicId>|<garmentColor>": imageUrl } to each
// configurable product, for the storefront's live per-location preview (migrations/0042).
async function attachProductGraphicImages_(db, orgId, products) {
  const configurableIds = products.filter(p => p.configurable).map(p => p.productId);
  if (!configurableIds.length) return products;
  let rows = [];
  try {
    const placeholders = configurableIds.map(() => "?").join(",");
    const r = await db.prepare(
      `SELECT productId, locationId, graphicId, garmentColor, imageUrl FROM product_graphic_images
       WHERE orgId=? AND productId IN (${placeholders}) AND imageUrl <> ''`
    ).bind(orgId, ...configurableIds).all();
    rows = r.results || [];
  } catch (e) { return products; }   // pre-migration DB
  if (!rows.length) return products;
  const byProduct = {};
  for (const r of rows) (byProduct[r.productId] = byProduct[r.productId] || {})[`${r.locationId}|${r.graphicId}|${r.garmentColor}`] = r.imageUrl;
  return products.map(p => byProduct[p.productId] ? { ...p, graphicImages: byProduct[p.productId] } : p);
}

// ---- Design verifications ----------------------------------------------

export async function createDesignVerification(db, { token, orgId, orderId, customerEmail, customerName, message, imagesJson, sentAt }) {
  await db.prepare(`INSERT INTO design_verifications
    (token,orgId,orderId,customerEmail,customerName,message,imagesJson,sentAt)
    VALUES (?,?,?,?,?,?,?,?)`)
    .bind(token, orgId, orderId, customerEmail, customerName, message, imagesJson, sentAt)
    .run();
}

export async function getDesignVerification(db, token) {
  return await db.prepare("SELECT * FROM design_verifications WHERE token=?").bind(token).first();
}

export async function respondToDesignVerification(db, token, { status, customerNote, customerImagesJson, respondedAt }) {
  const result = await db.prepare(
    `UPDATE design_verifications SET status=?,customerNote=?,customerImagesJson=?,respondedAt=?
     WHERE token=? AND status='pending'`
  ).bind(status, customerNote, customerImagesJson, respondedAt, token).run();
  return result.meta && result.meta.changes > 0;
}

// Atomically reserves one upload slot on a pending verification token.
// Returns true if a slot was reserved, false if the token is closed or the
// cap is already reached. A single conditional UPDATE, so concurrent
// uploads can't race past the cap.
export async function reserveVerificationUpload(db, token, maxUploads) {
  const r = await db.prepare(
    "UPDATE design_verifications SET uploadCount = uploadCount + 1 WHERE token=? AND status='pending' AND uploadCount < ?"
  ).bind(token, maxUploads).run();
  return r.meta.changes > 0;
}

export async function releaseVerificationUpload(db, token) {
  await db.prepare(
    "UPDATE design_verifications SET uploadCount = MAX(uploadCount - 1, 0) WHERE token=?"
  ).bind(token).run();
}

export async function getVerificationsByOrder(db, orderId) {
  const { results } = await db.prepare(
    "SELECT * FROM design_verifications WHERE orderId=? ORDER BY sentAt DESC"
  ).bind(orderId).all();
  return results;
}

export async function getLatestVerificationsByOrg(db, orgId) {
  const { results } = await db.prepare(
    "SELECT * FROM design_verifications WHERE orgId=? ORDER BY sentAt DESC"
  ).bind(orgId).all();
  const seen = new Set();
  return results.filter(r => seen.has(r.orderId) ? false : (seen.add(r.orderId), true));
}

// ---- Voids (migrations/0010): nothing financial is ever hard-deleted ---------

// Voids an order: kept on record, excluded from every report. Callers must
// first make sure no money is still held on it (see orders.js voidOrder).
export async function voidOrder(db, orderId, reason) {
  await db.prepare("UPDATE orders SET voidedAt = ?, voidReason = ? WHERE orderId = ? AND voidedAt IS NULL")
    .bind(new Date().toISOString(), String(reason || "").slice(0, 300), orderId).run();
}

// Voids a mistaken payment-ledger entry: stays visible, excluded from totals.
export async function voidPayment(db, id, reason) {
  const row = await db.prepare("SELECT orderId FROM order_payments WHERE id=?").bind(Number(id)).first();
  if (!row) return null;
  await db.prepare("UPDATE order_payments SET voidedAt = ?, voidReason = ? WHERE id = ? AND voidedAt IS NULL")
    .bind(new Date().toISOString(), String(reason || "").slice(0, 300), Number(id)).run();
  await refreshPaidStatus(db, row.orderId);
  return row.orderId;
}

// ---- Closed (filed) periods ------------------------------------------------
export const monthOf = (iso) => String(iso || "").slice(0, 7);

export async function getClosedPeriods(db) {
  const { results } = await db.prepare("SELECT month, closedAt, closedBy FROM closed_periods ORDER BY month DESC").all();
  return results;
}
export async function isMonthClosed(db, month) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) return false;
  return !!(await db.prepare("SELECT 1 AS x FROM closed_periods WHERE month=?").bind(month).first());
}
// Month (YYYY-MM) an existing order / line item / ledger entry belongs to.
export async function orderMonth(db, orderId) {
  const r = await db.prepare("SELECT placedAt FROM orders WHERE orderId=?").bind(orderId).first();
  return r ? monthOf(r.placedAt) : "";
}
export async function itemOrderMonth(db, itemId) {
  const r = await db.prepare("SELECT o.placedAt FROM order_items i JOIN orders o ON o.orderId = i.orderId WHERE i.id=?").bind(Number(itemId)).first();
  return r ? monthOf(r.placedAt) : "";
}
export async function paymentMonth(db, id) {
  const r = await db.prepare("SELECT receivedAt FROM order_payments WHERE id=?").bind(Number(id)).first();
  return r ? monthOf(r.receivedAt) : "";
}

export async function movementMonth(db, id) {
  const r = await db.prepare("SELECT occurredAt FROM inventory_movements WHERE id=?").bind(Number(id)).first();
  return r ? monthOf(r.occurredAt) : "";
}

export async function closePeriod(db, month, closedBy) {
  await db.prepare("INSERT OR IGNORE INTO closed_periods (month, closedAt, closedBy) VALUES (?, ?, ?)")
    .bind(month, new Date().toISOString(), closedBy || "").run();
}
export async function reopenPeriod(db, month) {
  await db.prepare("DELETE FROM closed_periods WHERE month=?").bind(month).run();
}

// ---- Cash-basis revenue ------------------------------------------------------
// Money actually received / returned in a period, by org and by method — by
// the date the money moved (receivedAt), not when the order was placed.
// Test orders' card charges are listed separately (they're real Stripe
// charges and appear on the 1099-K). Dollars out.
export async function getCashReport(db, dateFrom, dateTo) {
  const { results } = await db.prepare(`
    SELECT o.orgId, o.isTest, p.kind, p.method, SUM(p.amountCents) AS cents, SUM(p.feeCents) AS fees, COUNT(*) AS n
    FROM order_payments p JOIN orders o ON o.orderId = p.orderId
    WHERE p.receivedAt >= ? AND p.receivedAt <= ? AND p.voidedAt IS NULL
    GROUP BY o.orgId, o.isTest, p.kind, p.method
  `).bind(dateFrom, dateTo).all();
  const byOrg = {}, byMethod = {};
  let testCard = 0, testFees = 0;
  for (const r of results) {
    const cents = Number(r.cents), fees = Number(r.fees);
    if (r.isTest) { if (r.method === "card") { testCard += cents; testFees += fees; } continue; }
    const o = (byOrg[r.orgId] = byOrg[r.orgId] || { orgId: r.orgId, received: 0, refunded: 0, fees: 0, payments: 0 });
    const m = (byMethod[r.method] = byMethod[r.method] || { method: r.method, received: 0, refunded: 0, fees: 0 });
    if (r.kind === "payment") { o.received += cents; m.received += cents; o.payments += Number(r.n); }
    else { o.refunded += -cents; m.refunded += -cents; }
    o.fees += fees; m.fees += fees;
  }
  const out = (x) => ({ ...x, received: fromCents(x.received), refunded: fromCents(x.refunded), fees: fromCents(x.fees),
    net: fromCents(x.received - x.refunded) });
  return { orgs: Object.values(byOrg).map(out), methods: Object.values(byMethod).map(out),
    testCardCharges: fromCents(testCard), testCardFees: fromCents(testFees) };
}

// ---- Accountant export -------------------------------------------------------
// Raw rows for the year-end / monthly CSVs (admin builds the files). Sales
// lines by the month the order was placed (accrual); ledger rows by the
// date money moved (cash). Voided and test rows are included but flagged,
// so every number can be reconciled.
export async function getAccountantExport(db, dateFrom, dateTo) {
  const { results: lines } = await withTaxMode_((tm) => db.prepare(`
    SELECT o.placedAt, o.orderId, o.orgId, o.customerName, o.paymentMethod, o.taxExempt, o.isTest, o.voidedAt, ${tm} AS taxMode,
           o.shipState, o.discountCents, o.discountTaxCents, o.shippingCostCents,
           i.id AS itemId, i.productId, i.name, i.size, i.qty, i.lineTotalCents, i.taxCents, i.taxRateBps,
           i.cogsCents, i.cogsSource, i.cancelDate
    FROM orders o JOIN order_items i ON i.orderId = o.orderId
    WHERE o.placedAt >= ? AND o.placedAt <= ? ORDER BY o.placedAt, o.orderId, i.id
  `).bind(dateFrom, dateTo).all());
  const { results: ledger } = await db.prepare(`
    SELECT p.receivedAt, p.orderId, o.orgId, p.kind, p.method, p.reference, p.amountCents, p.feeCents, p.note,
           p.externalRef, p.voidedAt, o.isTest, o.voidedAt AS orderVoidedAt
    FROM order_payments p JOIN orders o ON o.orderId = p.orderId
    WHERE p.receivedAt >= ? AND p.receivedAt <= ? ORDER BY p.receivedAt, p.id
  `).bind(dateFrom, dateTo).all();
  const { results: labels } = await db.prepare(`
    SELECT l.purchasedAt, l.orderId, o.orgId, l.carrier, l.service, l.amountCents, l.trackingNumber, l.voidedAt, o.isTest
    FROM shipping_labels l JOIN orders o ON o.orderId = l.orderId
    WHERE l.purchasedAt >= ? AND l.purchasedAt <= ? ORDER BY l.purchasedAt
  `).bind(dateFrom, dateTo).all();
  const [taxRows, refundRows, cogs] = await Promise.all([
    getSalesTaxReport(db, dateFrom, dateTo), getSalesTaxRefunds(db, dateFrom, dateTo), getCogsReport(db, dateFrom, dateTo),
  ]);

  // Monthly summary, every figure in cents while summing.
  const months = {};
  const M = (m) => (months[m] = months[m] || { month: m, grossSales: 0, taxCollected: 0, netSales: 0, exemptSales: 0,
    shippingIncome: 0, taxRefunded: 0, refunds: 0, cardReceipts: 0, otherReceipts: 0, stripeFees: 0, postage: 0,
    cogs: 0, purchases: 0, writeoffs: 0, testCardCharges: 0, expensesDeductible: 0, capitalPurchases: 0, useTax: 0,
    serviceIncome: 0, otherIncome: 0, interestIncome: 0, ownerContributions: 0, ownerDraws: 0 });
  for (const r of taxRows) {
    const m = M(r.month);
    m.grossSales += toCents(r.grossSales); m.taxCollected += toCents(r.taxCollected);
    m.netSales += toCents(r.netSales); m.shippingIncome += toCents(r.shipping);
    if (r.exempt) m.exemptSales += toCents(r.netSales);
  }
  for (const r of refundRows) { const m = M(r.month); m.refunds += toCents(r.refunded); m.taxRefunded += toCents(r.taxRefunded); }
  for (const p of ledger) {
    if (p.voidedAt || p.orderVoidedAt) continue;
    const m = M(monthOf(p.receivedAt));
    if (p.isTest) { if (p.method === "card" && p.kind === "payment") m.testCardCharges += Number(p.amountCents); continue; }
    if (p.kind === "payment") { if (p.method === "card") m.cardReceipts += Number(p.amountCents); else m.otherReceipts += Number(p.amountCents); }
    m.stripeFees += Number(p.feeCents);
  }
  for (const l of labels) if (!l.voidedAt && !l.isTest) M(monthOf(l.purchasedAt)).postage += Number(l.amountCents);
  for (const r of cogs.rows) { const m = M(r.month); m.cogs += toCents(r.cogs); m.purchases += toCents(r.purchases); m.writeoffs += toCents(r.writeoffs); }
  const expenseRows = await listExpenses(db, dateFrom.slice(0, 10), dateTo.slice(0, 10), { includeDeleted: true });
  const useTaxRate = Number((await getSalesTaxSettings(db)).rateBps) || 0;
  const useTaxOf = (x) => x.useTaxDue ? Math.sign(toCents(x.amount)) * Math.round(Math.abs(toCents(x.amount)) * useTaxRate / 10000) : 0;   // a refund reverses to the cent
  for (const x of expenseRows) {
    if (x.deletedAt) continue;
    const m = M(x.date.slice(0, 7));
    m.expensesDeductible += toCents(x.deductible);
    if (x.deductionType === "depreciation") m.capitalPurchases += toCents(x.amount);
    m.useTax += useTaxOf(x);
    if (x.paidPersonally) m.ownerContributions += toCents(x.amount);   // owner paid a business expense
  }
  const d0 = dateFrom.slice(0, 10), d1 = dateTo.slice(0, 10);
  const [incomeRows, ownerRows, transferRows, accountsNow] = await Promise.all([
    listMoneyEntries(db, "income", d0, d1), listMoneyEntries(db, "owner", d0, d1), listMoneyEntries(db, "transfer", d0, d1), listAccounts(db, d1)]);
  const accountName = Object.fromEntries(accountsNow.map(a => [a.id, a.name]));
  for (const i of incomeRows) M(i.date.slice(0, 7))[i.type === "service" ? "serviceIncome" : i.type === "interest" ? "interestIncome" : "otherIncome"] += toCents(i.amount);
  for (const o of ownerRows) M(o.date.slice(0, 7))[o.kind === "contribution" ? "ownerContributions" : "ownerDraws"] += toCents(o.amount);
  const summary = Object.values(months).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, k === "month" ? v : fromCents(v)])));

  const status = (r) => r.voidedAt ? "void" : r.isTest ? "test" : "";
  return {
    summary,
    sales: lines.map(r => ({
      date: r.placedAt, orderId: r.orderId, orgId: r.orgId, customer: r.customerName, paymentMethod: r.paymentMethod,
      product: r.name, productId: r.productId, size: r.size, qty: Number(r.qty),
      // gross = what the customer pays for the line, tax included; net = without it — in either mode.
      ...(taxMode_(r.taxMode) === "exclusive"
        ? { gross: fromCents(Number(r.lineTotalCents) + Number(r.taxCents)), tax: fromCents(r.taxCents), net: fromCents(r.lineTotalCents) }
        : { gross: fromCents(r.lineTotalCents), tax: fromCents(r.taxCents), net: fromCents(r.lineTotalCents - r.taxCents) }),
      taxMode: taxMode_(r.taxMode), taxRate: Number(r.taxRateBps) / 100, taxExempt: !!r.taxExempt, shipState: r.shipState || "",
      cogs: fromCentsOrNull(r.cogsCents), cogsSource: r.cogsSource || "",
      cancelled: r.cancelDate ? r.cancelDate.slice(0, 10) : "", status: status(r),
    })),
    ledger: ledger.map(p => ({
      date: p.receivedAt, orderId: p.orderId, orgId: p.orgId, kind: p.kind, method: p.method, reference: p.reference || "",
      amount: fromCents(p.amountCents), fee: fromCents(p.feeCents), note: p.note || "", stripeRef: p.externalRef || "",
      status: p.voidedAt ? "void" : p.orderVoidedAt ? "order void" : p.isTest ? "test" : "",
    })),
    income: incomeRows.slice().reverse().map(i => ({ date: i.date, description: i.description, type: OTHER_INCOME_TYPES[i.type] || i.type,
      amount: i.amount, account: accountName[i.accountId] || "", reference: i.reference })),
    owner: ownerRows.slice().reverse().map(o => ({ date: o.date, kind: o.kind === "contribution" ? "Contribution" : "Draw", amount: o.amount,
      account: accountName[o.accountId] || "", note: o.note })),
    transfers: transferRows.slice().reverse().map(t => ({ date: t.date, from: accountName[t.fromAccountId] || "", to: accountName[t.toAccountId] || "",
      amount: t.amount, note: t.note, stripePayout: t.externalRef || "" })),
    accounts: accountsNow.map(a => ({ account: a.name, type: ACCOUNT_TYPES[a.type] || a.type, openingDate: a.openingDate,
      openingBalance: a.openingBalance, balanceAtEnd: a.balance })),
    reconciliations: (await listReconciliations(db)).filter(r => r.month >= d0.slice(0, 7) && r.month <= d1.slice(0, 7)),
    expenses: expenseRows.slice().reverse().map(x => ({ date: x.date, description: x.description, vendor: x.vendor, category: x.category, type: x.isRefund ? "Refund" : "Expense",
      scheduleCLine: x.scheduleCLine, scheduleCLabel: SCHEDULE_C_LINES[x.scheduleCLine] || "", deductionType: x.deductionType,
      amount: x.amount, businessUsePct: x.businessUsePct, deductiblePct: x.deductiblePct, deductible: x.deductible,
      placedInService: x.deductionType === "depreciation" ? (x.placedInService || x.date) : "",
      method: x.deductionType === "depreciation" ? (DEPRECIATION_METHODS[x.depMethod] || "Ask CPA") : "",
      vendorChargedTax: x.vendorChargedTax ? "yes" : "no", useTax: fromCents(useTaxOf(x)),
      paidFrom: x.paidPersonally ? "Personal funds" : (accountName[x.accountId] || ""),
      receipt: x.receiptKey ? "yes" : "", status: x.deletedAt ? "deleted" : "" })),
    postage: labels.map(l => ({ date: l.purchasedAt, orderId: l.orderId, orgId: l.orgId, carrier: l.carrier, service: l.service,
      amount: fromCents(l.amountCents), tracking: l.trackingNumber || "", status: l.voidedAt ? "void" : l.isTest ? "test" : "" })),
  };
}

// ---- Shipping labels (postage expense) -----------------------------------

// Idempotent on the Shippo transaction id.
export async function recordShippingLabel(db, { orderId, shippoTransactionId, carrier, service, amount, trackingNumber, labelUrl }) {
  await db.prepare(
    `INSERT OR IGNORE INTO shipping_labels (orderId, shippoTransactionId, carrier, service, amountCents, trackingNumber, labelUrl, purchasedAt, accountId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(orderId, shippoTransactionId, carrier || "", service || "", Math.max(0, toCents(amount)),
    trackingNumber || "", labelUrl || "", new Date().toISOString(), (await getMoneyDefaults(db)).postageAccountId).run();
}

// The order's current (not voided) label, newest first — for re-opening its PDF.
export async function getOrderLabel(db, orderId) {
  const row = await db.prepare("SELECT * FROM shipping_labels WHERE orderId=? AND voidedAt IS NULL ORDER BY purchasedAt DESC, id DESC LIMIT 1")
    .bind(orderId).first();
  return row || null;
}
export async function setShippingLabelUrl(db, id, url) {
  await db.prepare("UPDATE shipping_labels SET labelUrl=? WHERE id=?").bind(String(url || ""), Number(id)).run();
}

function parseLabel_(row) {
  return {
    id: Number(row.id), shippoTransactionId: row.shippoTransactionId, carrier: row.carrier || "",
    service: row.service || "", amount: fromCents(row.amountCents), trackingNumber: row.trackingNumber || "",
    labelUrl: row.labelUrl || "", purchasedAt: row.purchasedAt || "", voidedAt: row.voidedAt || "",
  };
}

// ---- Business expenses (migrations/0012) ------------------------------------
// Schedule C Part II lines an expense category can map to.
export const SCHEDULE_C_LINES = {
  "8": "Advertising", "9": "Car and truck expenses", "10": "Commissions and fees", "11": "Contract labor",
  "12": "Depletion", "13": "Depreciation and section 179", "14": "Employee benefit programs",
  "15": "Insurance (other than health)", "16a": "Interest — mortgage", "16b": "Interest — other",
  "17": "Legal and professional services", "18": "Office expense", "19": "Pension and profit-sharing plans",
  "20a": "Rent or lease — vehicles, machinery, equipment", "20b": "Rent or lease — other business property",
  "21": "Repairs and maintenance", "22": "Supplies", "23": "Taxes and licenses", "24a": "Travel",
  "24b": "Deductible meals", "25": "Utilities", "26": "Wages", "27a": "Other expenses",
};
export const DEDUCTION_TYPES = ["depreciation", "deductible", "none"];
export const DEPRECIATION_METHODS = { section179: "Section 179", bonus: "100% bonus", macrs5: "MACRS 5-year", macrs7: "MACRS 7-year", ask_cpa: "Ask CPA" };

// What's deductible THIS year from an ordinary expense: amount × category
// deductible % × business-use %. Depreciation (capital) and non-deductible
// expenses contribute 0 here — capital purchases are reported separately.
function expenseDeductibleCents_(row) {
  if (row.deductionType !== "deductible") return 0;
  // Rounded on the magnitude, then signed: a refund (negative amount) must reverse the
  // original purchase's deduction to the cent (Math.round(-502.5) = -502 but round(502.5) = 503).
  const amt = Number(row.amountCents);
  return Math.sign(amt) * Math.round(Math.abs(amt) * Number(row.deductiblePct) * Number(row.businessUsePct) / 10000);
}
function parseExpenseCategory_(r) {
  return { id: Number(r.id), name: r.name, deductionType: r.deductionType, scheduleCLine: r.scheduleCLine || "",
    deductiblePct: Number(r.deductiblePct), useTaxable: !!r.useTaxable, expenseCount: Number(r.expenseCount || 0) };
}
function parseExpense_(r) {
  return {
    id: Number(r.id), date: r.expenseDate, description: r.description, vendor: r.vendor || "",
    categoryId: Number(r.categoryId), category: r.categoryName || "", deductionType: r.deductionType || "",
    scheduleCLine: r.scheduleCLine || "", deductiblePct: Number(r.deductiblePct ?? 100),
    amount: fromCents(r.amountCents), businessUsePct: Number(r.businessUsePct), deductible: fromCents(expenseDeductibleCents_(r)),
    receiptKey: r.receiptKey || "", receiptName: r.receiptName || "",
    placedInService: r.placedInService || "", depMethod: r.depMethod || "", deletedAt: r.deletedAt || "",
    vendorChargedTax: r.vendorChargedTax === undefined ? true : !!r.vendorChargedTax,
    useTaxDue: !!r.useTaxable && r.vendorChargedTax === 0,   // use tax owed on this purchase
    accountId: r.accountId == null ? null : Number(r.accountId), paidPersonally: !!r.paidPersonally,
    // A refund is a negative expense (money back for something bought) in the ORIGINAL's category.
    isRefund: Number(r.amountCents) < 0, refundOfId: r.refundOfId == null ? null : Number(r.refundOfId),
  };
}

export async function listExpenseCategories(db) {
  const { results } = await db.prepare(
    `SELECT c.*, (SELECT count(*) FROM expenses e WHERE e.categoryId = c.id) AS expenseCount
     FROM expense_categories c ORDER BY c.name COLLATE NOCASE`).all();
  return results.map(parseExpenseCategory_);
}
export async function getExpenseCategory(db, id) {
  const r = await db.prepare(`SELECT c.*, (SELECT count(*) FROM expenses e WHERE e.categoryId = c.id) AS expenseCount
    FROM expense_categories c WHERE c.id = ?`).bind(Number(id)).first();
  return r ? parseExpenseCategory_(r) : null;
}
export async function findExpenseCategoryByName(db, name) {
  const r = await db.prepare("SELECT id FROM expense_categories WHERE name = ? COLLATE NOCASE").bind(String(name).trim()).first();
  return r ? Number(r.id) : null;
}
export async function saveExpenseCategory(db, id, { name, deductionType, scheduleCLine, deductiblePct, useTaxable }) {
  const now = new Date().toISOString();
  if (id) {
    await db.prepare("UPDATE expense_categories SET name = ?, deductionType = ?, scheduleCLine = ?, deductiblePct = ?, useTaxable = ?, updatedAt = ? WHERE id = ?")
      .bind(String(name).trim(), deductionType, scheduleCLine || "", Number(deductiblePct), useTaxable ? 1 : 0, now, Number(id)).run();
    return Number(id);
  }
  const r = await db.prepare(`INSERT INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, useTaxable, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(String(name).trim(), deductionType, scheduleCLine || "", Number(deductiblePct), useTaxable ? 1 : 0, now, now).first();
  return Number(r.id);
}
// Refused (false) while any expense — even a deleted one — uses the category.
export async function deleteExpenseCategory(db, id) {
  const used = await db.prepare("SELECT count(*) AS n FROM expenses WHERE categoryId = ?").bind(Number(id)).first();
  if (Number(used.n) > 0) return false;
  await db.prepare("DELETE FROM expense_categories WHERE id = ?").bind(Number(id)).run();
  return true;
}

const EXPENSE_SELECT_ = `SELECT e.*, c.name AS categoryName, c.deductionType, c.scheduleCLine, c.deductiblePct, c.useTaxable
  FROM expenses e JOIN expense_categories c ON c.id = e.categoryId`;
// dateFrom/dateTo are YYYY-MM-DD (inclusive).
export async function listExpenses(db, dateFrom, dateTo, { includeDeleted = false } = {}) {
  const { results } = await db.prepare(`${EXPENSE_SELECT_}
    WHERE e.expenseDate >= ? AND e.expenseDate <= ? ${includeDeleted ? "" : "AND e.deletedAt IS NULL"}
    ORDER BY e.expenseDate DESC, e.id DESC`).bind(dateFrom, dateTo).all();
  return results.map(parseExpense_);
}
export async function getExpense(db, id) {
  const r = await db.prepare(`${EXPENSE_SELECT_} WHERE e.id = ?`).bind(Number(id)).first();
  return r ? parseExpense_(r) : null;
}
// Fields already validated by the caller (orders.js saveExpense).
export async function saveExpense(db, id, x) {
  const now = new Date().toISOString();
  const vals = [x.date, String(x.description).trim(), Number(x.categoryId), toCents(x.amount), x.vendor || "",
    Number(x.businessUsePct), x.receiptKey || "", x.receiptName || "", x.placedInService || null, x.depMethod || null,
    x.vendorChargedTax === false ? 0 : 1, x.paidPersonally ? null : (x.accountId ? Number(x.accountId) : null), x.paidPersonally ? 1 : 0,
    x.refundOfId ? Number(x.refundOfId) : null];
  if (id) {
    await db.prepare(`UPDATE expenses SET expenseDate = ?, description = ?, categoryId = ?, amountCents = ?, vendor = ?,
      businessUsePct = ?, receiptKey = ?, receiptName = ?, placedInService = ?, depMethod = ?, vendorChargedTax = ?, accountId = ?, paidPersonally = ?, refundOfId = ?, updatedAt = ?
      WHERE id = ? AND deletedAt IS NULL`).bind(...vals, now, Number(id)).run();
    return Number(id);
  }
  const r = await db.prepare(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, vendor, businessUsePct,
    receiptKey, receiptName, placedInService, depMethod, vendorChargedTax, accountId, paidPersonally, refundOfId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(...vals, now, now).first();
  return Number(r.id);
}
// How much of a purchase has already been refunded (positive cents), counting the live refund
// expenses linked to it (optionally leaving one out — the one being edited).
export async function getRefundedCents(db, originalId, excludeId = 0) {
  const r = await db.prepare("SELECT COALESCE(-SUM(amountCents), 0) AS c FROM expenses WHERE refundOfId = ? AND deletedAt IS NULL AND amountCents < 0 AND id <> ?")
    .bind(Number(originalId), Number(excludeId) || 0).first();
  return Number(r.c);
}

// ---- Deposits: Venmo cash-outs, cash and checks (migrations/0017, 0018) --------
// Payments on real orders that haven't reached the bank yet — Venmo, cash, check and card (Stripe) payments.
// A payment recorded in ANOTHER account (Venmo, Cash on hand) is moved by a transfer, and can be
// deposited in PARTS (an order paid 50% down / 50% at the end reaches the bank in two cash-outs):
// each transfer records how much of the payment it covers (payment_cashouts), and the payment stays
// on the list until those add up to its amount (allocations to a deleted transfer don't count). A
// payment already recorded IN the bank account (checks default there) is matched to the deposit whole.
// One that's already matched to a statement line is left out. With `ids`, only those — used to
// re-validate what the browser sent.
export async function getDepositPayments(db, ids = null) {
  const idFilter = ids ? ` AND p.id IN (${ids.map(() => "?").join(",") || "NULL"})` : "";
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT p.id, p.orderId, p.method, p.amountCents, p.feeCents, p.receivedAt, p.accountId, a.name AS accountName, o.customerName, o.orgId,
         COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
                    WHERE c.paymentId = p.id), 0) AS allocatedCents,
         EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = p.id) AS matched
         FROM order_payments p JOIN orders o ON o.orderId = p.orderId LEFT JOIN accounts a ON a.id = p.accountId
        WHERE p.method IN ('venmo', 'cash', 'check', 'zelle', 'card') AND p.kind = 'payment' AND p.voidedAt IS NULL AND p.accountId IS NOT NULL
          AND o.voidedAt IS NULL AND o.isTest = 0${idFilter}
     ) WHERE allocatedCents < amountCents AND matched = 0 ORDER BY receivedAt DESC, id DESC LIMIT ${ids ? 500 : 300}`).bind(...(ids || [])).all();
  return results.map(r => ({ id: Number(r.id), orderId: r.orderId, orgId: r.orgId, customerName: r.customerName, method: r.method, amountCents: Number(r.amountCents),
    feeCents: Number(r.feeCents || 0), receivedAt: r.receivedAt, accountId: Number(r.accountId), accountName: r.accountName || "",
    allocatedCents: Number(r.allocatedCents), remainingCents: Number(r.amountCents) - Number(r.allocatedCents) }));
}
// What part of a payment's amount reaches the bank: a fee already recorded on the payment is
// taken out in proportion to how much of the payment is being cashed out.
export function cashoutNetCents_(p, allocCents) {
  return p.feeCents > 0 ? Math.round(allocCents * (p.amountCents - p.feeCents) / p.amountCents) : allocCents;
}
// allocations: [{paymentId, amountCents}]
export async function linkPaymentsToCashout(db, allocations, transferId) {
  if (!allocations.length) return;
  const now = new Date().toISOString();
  await db.batch(allocations.map(a => db.prepare("INSERT INTO payment_cashouts (paymentId, transferId, amountCents, createdAt) VALUES (?, ?, ?, ?)")
    .bind(Number(a.paymentId), Number(transferId), Number(a.amountCents), now)));
}
// Soft delete: kept (with the audit snapshot) but excluded from every total.
export async function deleteExpense(db, id) {
  await db.prepare("UPDATE expenses SET deletedAt = ? WHERE id = ? AND deletedAt IS NULL").bind(new Date().toISOString(), Number(id)).run();
}
export async function expenseMonth(db, id) {
  const r = await db.prepare("SELECT expenseDate FROM expenses WHERE id = ?").bind(Number(id)).first();
  return r ? String(r.expenseDate).slice(0, 7) : "";
}

// ---- Expense CSV import helpers ----------------------------------------------
const normDesc_ = (d) => String(d || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// For each candidate row {date, description, amountCents}: is an expense with
// the same date and amount (and similar description) already recorded, and
// which category did you use last time for this description? Suggestion =
// the most recent expense with the same description, else one whose
// description starts with the same first word (4+ letters).
export async function previewExpenseRows(db, rows) {
  const { results: recent } = await db.prepare(
    "SELECT expenseDate, description, amountCents, categoryId FROM expenses WHERE deletedAt IS NULL ORDER BY expenseDate DESC, id DESC LIMIT 2000").all();
  const byDesc = new Map(), byWord = new Map(), existing = new Set();
  for (const e of recent) {
    const n = normDesc_(e.description);
    if (!byDesc.has(n)) byDesc.set(n, Number(e.categoryId));
    const w = n.split(" ")[0];
    if (w && w.length >= 4 && !byWord.has(w)) byWord.set(w, Number(e.categoryId));
    existing.add(`${e.expenseDate}|${Number(e.amountCents)}`);
  }
  return rows.map(r => {
    const n = normDesc_(r.description), w = n.split(" ")[0];
    return { duplicate: existing.has(`${r.date}|${Math.round(r.amountCents)}`),
      suggestedCategoryId: byDesc.get(n) || (w && w.length >= 4 ? byWord.get(w) : null) || null };
  });
}

// Totals for a period: by Schedule C line and by category, plus the capital
// purchases (depreciation) as an asset register for Form 4562. Dollars out.
export async function getExpenseSummary(db, dateFrom, dateTo) {
  const { results } = await db.prepare(`${EXPENSE_SELECT_}
    WHERE e.expenseDate >= ? AND e.expenseDate <= ? AND e.deletedAt IS NULL ORDER BY e.expenseDate`).bind(dateFrom, dateTo).all();
  const byLine = {}, byCategory = {};
  const t = { amount: 0, deductible: 0, capital: 0, nonDeductible: 0 };
  const assets = [];
  for (const r of results) {
    const amt = Number(r.amountCents), ded = expenseDeductibleCents_(r);
    t.amount += amt;
    const c = (byCategory[r.categoryId] = byCategory[r.categoryId] || { categoryId: Number(r.categoryId), category: r.categoryName,
      deductionType: r.deductionType, scheduleCLine: r.scheduleCLine, amount: 0, deductible: 0, count: 0 });
    c.amount += amt; c.deductible += ded; c.count++;
    if (r.deductionType === "deductible") {
      t.deductible += ded; t.nonDeductible += amt - ded;
      const key = r.scheduleCLine || "27a";
      const l = (byLine[key] = byLine[key] || { line: key, label: SCHEDULE_C_LINES[key] || "Other expenses", amount: 0, deductible: 0 });
      l.amount += amt; l.deductible += ded;
    } else if (r.deductionType === "depreciation") {
      t.capital += amt;
      assets.push({ id: Number(r.id), date: r.expenseDate, description: r.description, vendor: r.vendor || "", category: r.categoryName,
        cost: fromCents(amt), businessUsePct: Number(r.businessUsePct), businessBasis: fromCents(Math.round(amt * Number(r.businessUsePct) / 100)),
        placedInService: r.placedInService || r.expenseDate, method: DEPRECIATION_METHODS[r.depMethod] || "Ask CPA" });
    } else {
      t.nonDeductible += amt;
    }
  }
  const lineOrder = Object.keys(SCHEDULE_C_LINES);
  const money = (o) => ({ ...o, amount: fromCents(o.amount), deductible: fromCents(o.deductible) });
  return {
    totals: { amount: fromCents(t.amount), deductible: fromCents(t.deductible), capital: fromCents(t.capital), nonDeductible: fromCents(t.nonDeductible) },
    byLine: Object.values(byLine).sort((a, b) => lineOrder.indexOf(a.line) - lineOrder.indexOf(b.line)).map(money),
    byCategory: Object.values(byCategory).sort((a, b) => a.category.localeCompare(b.category)).map(money),
    assets,
  };
}

// ---- Accounts & money movements (migrations/0014) ---------------------------
export const ACCOUNT_TYPES = { checking: "Checking", credit_card: "Credit card", venmo: "Venmo", cash: "Cash", stripe: "Stripe", other: "Other" };
export const OTHER_INCOME_TYPES = {
  service: "Services (Schedule C line 1)",
  other: "Other business income (Schedule C line 6)",
  interest: "Interest (Schedule B — not Schedule C)",
};
const METHOD_ACCOUNT_TYPE_ = { card: "stripe", venmo: "venmo", cash: "cash", zelle: "checking", check: "checking", other: "checking" };

// The (first active) account a payment method's money lands in.
export async function accountIdForMethod(db, method) {
  const type = METHOD_ACCOUNT_TYPE_[method] || "checking";
  const r = await db.prepare("SELECT id FROM accounts WHERE type = ? AND active = 1 ORDER BY id LIMIT 1").bind(type).first();
  return r ? Number(r.id) : null;
}
// Where Shippo postage is charged and where Stripe pays out to.
export async function getMoneyDefaults(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='moneyDefaults'").first();
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch (_) {}
  return { postageAccountId: Number(v.postageAccountId) || 2, payoutAccountId: Number(v.payoutAccountId) || 1 };
}
export async function setMoneyDefaults(db, d) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('moneyDefaults', ?)")
    .bind(JSON.stringify({ postageAccountId: Number(d.postageAccountId), payoutAccountId: Number(d.payoutAccountId) })).run();
}

// Every money movement, one row per account side: (src, srcId, accountId,
// date YYYY-MM-DD, cents signed — into the account positive), plus a label.
// Balances sum these; statement reconciliation (Part B) matches against them.
// Kept as separate SELECTs run one by one: D1 caps the number of terms in a
// compound (UNION ALL) SELECT well below the nine sources here.
export const MONEY_MOVE_SOURCES = [
  `SELECT 'payment' AS src, p.id AS srcId, p.accountId AS accountId, substr(p.receivedAt, 1, 10) AS d, p.amountCents AS c,
          p.orderId || ' ' || p.kind || ' (' || p.method || ')' AS label FROM order_payments p WHERE p.voidedAt IS NULL AND p.accountId IS NOT NULL`,
  `SELECT 'fee' AS src, p.id AS srcId, p.accountId AS accountId, substr(p.receivedAt, 1, 10) AS d, -p.feeCents AS c, p.orderId || ' processing fee' AS label
     FROM order_payments p WHERE p.voidedAt IS NULL AND p.accountId IS NOT NULL AND p.feeCents > 0`,
  `SELECT 'expense' AS src, e.id AS srcId, e.accountId AS accountId, e.expenseDate AS d, -e.amountCents AS c, e.description AS label
     FROM expenses e WHERE e.deletedAt IS NULL AND e.accountId IS NOT NULL AND e.paidPersonally = 0`,
  `SELECT 'blanks' AS src, m.id AS srcId, m.accountId AS accountId, substr(m.occurredAt, 1, 10) AS d, -(m.qtyDelta * m.unitCostCents) AS c,
          'Blanks: ' || m.blankName || ' ' || m.size AS label FROM inventory_movements m WHERE m.kind = 'purchase' AND m.accountId IS NOT NULL AND m.paidPersonally = 0 AND m.voidedAt IS NULL`,
  `SELECT 'postage' AS src, l.id AS srcId, l.accountId AS accountId, substr(l.purchasedAt, 1, 10) AS d, -l.amountCents AS c, 'Postage ' || l.orderId AS label
     FROM shipping_labels l WHERE l.voidedAt IS NULL AND l.accountId IS NOT NULL`,
  `SELECT 'income' AS src, i.id AS srcId, i.accountId AS accountId, i.incomeDate AS d, i.amountCents AS c, i.description AS label
     FROM other_income i WHERE i.deletedAt IS NULL`,
  `SELECT 'owner' AS src, o.id AS srcId, o.accountId AS accountId, o.txDate AS d, CASE o.kind WHEN 'contribution' THEN o.amountCents ELSE -o.amountCents END AS c,
          CASE o.kind WHEN 'contribution' THEN 'Owner contribution' ELSE 'Owner draw' END AS label FROM owner_transactions o WHERE o.deletedAt IS NULL`,
  `SELECT 'transfer_out' AS src, t.id AS srcId, t.fromAccountId AS accountId, t.transferDate AS d, -t.amountCents AS c, 'Transfer out' AS label
     FROM account_transfers t WHERE t.deletedAt IS NULL`,
  `SELECT 'transfer_in' AS src, t.id AS srcId, t.toAccountId AS accountId, t.transferDate AS d, t.amountCents AS c, 'Transfer in' AS label
     FROM account_transfers t WHERE t.deletedAt IS NULL`,
];

// Accounts with their balance as of `asOf` (YYYY-MM-DD, inclusive): opening
// balance + every movement dated on/after the opening date. Dollars out.
export async function listAccounts(db, asOf = new Date().toISOString().slice(0, 10)) {
  const { results: accts } = await db.prepare("SELECT * FROM accounts ORDER BY id").all();
  const moved = {}, moves = {};
  const perSource = await Promise.all(MONEY_MOVE_SOURCES.map(sql => db.prepare(`
    SELECT m.accountId, SUM(CASE WHEN m.d >= a.openingDate AND m.d <= ? THEN m.c ELSE 0 END) AS c, count(*) AS n
    FROM (${sql}) m JOIN accounts a ON a.id = m.accountId GROUP BY m.accountId`).bind(asOf).all()));
  for (const { results } of perSource) for (const r of results) {
    moved[r.accountId] = (moved[r.accountId] || 0) + Number(r.c || 0);
    moves[r.accountId] = (moves[r.accountId] || 0) + Number(r.n || 0);
  }
  return accts.map(a => ({ id: Number(a.id), name: a.name, type: a.type, openingBalance: fromCents(a.openingBalanceCents),
    openingDate: a.openingDate, active: !!a.active, csvMapping: a.csvMapping || "", balance: fromCents(Number(a.openingBalanceCents) + (moved[a.id] || 0)), moves: moves[a.id] || 0 }));
}
export async function saveAccount(db, id, { name, type, openingBalance, openingDate, active }) {
  const now = new Date().toISOString();
  if (id) {
    await db.prepare("UPDATE accounts SET name=?, type=?, openingBalanceCents=?, openingDate=?, active=?, updatedAt=? WHERE id=?")
      .bind(String(name).trim(), type, toCents(openingBalance), openingDate, active ? 1 : 0, now, Number(id)).run();
    return Number(id);
  }
  const r = await db.prepare(`INSERT INTO accounts (name, type, openingBalanceCents, openingDate, active, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(String(name).trim(), type, toCents(openingBalance), openingDate, active ? 1 : 0, now, now).first();
  return Number(r.id);
}
export async function getAccount(db, id) {
  const r = await db.prepare("SELECT * FROM accounts WHERE id=?").bind(Number(id)).first();
  return r ? { id: Number(r.id), name: r.name, type: r.type, active: !!r.active, openingDate: r.openingDate, openingBalance: fromCents(r.openingBalanceCents) } : null;
}

// Generic dated entries: other income, owner transactions, transfers.
const MONEY_TABLES_ = {
  income:   { table: "other_income",       date: "incomeDate",   cols: ["description", "type", "accountId", "reference"] },
  owner:    { table: "owner_transactions", date: "txDate",       cols: ["kind", "accountId", "note"] },
  transfer: { table: "account_transfers",  date: "transferDate", cols: ["fromAccountId", "toAccountId", "note", "externalRef"] },
};
function parseMoneyRow_(kind, r) {
  const t = MONEY_TABLES_[kind];
  const out = { id: Number(r.id), date: r[t.date], amount: fromCents(r.amountCents), deletedAt: r.deletedAt || "" };
  for (const c of t.cols) out[c] = /AccountId$|^accountId$/.test(c) ? Number(r[c]) : (r[c] ?? "");
  return out;
}
export async function listMoneyEntries(db, kind, dateFrom, dateTo) {
  const t = MONEY_TABLES_[kind];
  const { results } = await db.prepare(`SELECT * FROM ${t.table} WHERE deletedAt IS NULL AND ${t.date} >= ? AND ${t.date} <= ? ORDER BY ${t.date} DESC, id DESC`)
    .bind(dateFrom, dateTo).all();
  return results.map(r => parseMoneyRow_(kind, r));
}
export async function getMoneyEntry(db, kind, id) {
  const t = MONEY_TABLES_[kind];
  const r = await db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).bind(Number(id)).first();
  return r ? parseMoneyRow_(kind, r) : null;
}
// Fields already validated by the caller (orders.js).
export async function saveMoneyEntry(db, kind, id, x) {
  const t = MONEY_TABLES_[kind], now = new Date().toISOString();
  const cols = [t.date, "amountCents", ...t.cols];
  const vals = [x.date, toCents(x.amount), ...t.cols.map(c => x[c] ?? (/AccountId$|^accountId$/.test(c) ? null : ""))];
  if (id) {
    await db.prepare(`UPDATE ${t.table} SET ${cols.map(c => c + " = ?").join(", ")}, updatedAt = ? WHERE id = ? AND deletedAt IS NULL`)
      .bind(...vals, now, Number(id)).run();
    return Number(id);
  }
  const r = await db.prepare(`INSERT INTO ${t.table} (${cols.join(", ")}, createdAt, updatedAt) VALUES (${cols.map(() => "?").join(", ")}, ?, ?) RETURNING id`)
    .bind(...vals, now, now).first();
  return Number(r.id);
}
export async function deleteMoneyEntry(db, kind, id) {
  const t = MONEY_TABLES_[kind];
  await db.prepare(`UPDATE ${t.table} SET deletedAt = ? WHERE id = ? AND deletedAt IS NULL`).bind(new Date().toISOString(), Number(id)).run();
}
export async function moneyEntryMonth(db, kind, id) {
  const e = await getMoneyEntry(db, kind, id);
  return e ? String(e.date).slice(0, 7) : "";
}

// A Stripe payout (payout.paid webhook): Stripe balance → the payout account
// (a negative payout — Stripe debiting the bank — goes the other way).
// Idempotent on the payout id. Returns true when newly recorded.
export async function recordStripePayout(db, { payoutId, amountCents, arrivalDate }) {
  const stripe = await db.prepare("SELECT id FROM accounts WHERE type = 'stripe' AND active = 1 ORDER BY id LIMIT 1").first();
  const { payoutAccountId } = await getMoneyDefaults(db);
  if (!stripe || !payoutId || !amountCents) return false;
  const out = amountCents > 0;
  const now = new Date().toISOString();
  const r = await db.prepare(`INSERT OR IGNORE INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, note, externalRef, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(arrivalDate, out ? Number(stripe.id) : payoutAccountId, out ? payoutAccountId : Number(stripe.id),
    Math.abs(Math.round(amountCents)), "Stripe payout", payoutId, now, now).run();
  return !!(r.meta && r.meta.changes);
}

// Year-end style summary for a period (YYYY-MM-DD bounds): other income by
// type, owner money in/out (including expenses and blanks paid personally),
// and account balances at the end. Dollars out.
export async function getMoneySummary(db, dateFrom, dateTo) {
  const q = async (sql, ...b) => (await db.prepare(sql).bind(...b).first()) || {};
  const byType = (await db.prepare(`SELECT type, SUM(amountCents) c, count(*) n FROM other_income WHERE deletedAt IS NULL AND incomeDate >= ? AND incomeDate <= ? GROUP BY type`)
    .bind(dateFrom, dateTo).all()).results;
  const own = (await db.prepare(`SELECT kind, SUM(amountCents) c FROM owner_transactions WHERE deletedAt IS NULL AND txDate >= ? AND txDate <= ? GROUP BY kind`)
    .bind(dateFrom, dateTo).all()).results;
  const personalExp = await q(`SELECT COALESCE(SUM(amountCents), 0) c FROM expenses WHERE deletedAt IS NULL AND paidPersonally = 1 AND expenseDate >= ? AND expenseDate <= ?`, dateFrom, dateTo);
  const personalBlanks = await q(`SELECT COALESCE(SUM(qtyDelta * unitCostCents), 0) c FROM inventory_movements WHERE kind = 'purchase' AND paidPersonally = 1 AND voidedAt IS NULL AND substr(occurredAt, 1, 10) >= ? AND substr(occurredAt, 1, 10) <= ?`, dateFrom, dateTo);
  const unassigned = await q(`SELECT
      (SELECT count(*) FROM expenses WHERE deletedAt IS NULL AND accountId IS NULL AND paidPersonally = 0) +
      (SELECT count(*) FROM inventory_movements WHERE kind = 'purchase' AND accountId IS NULL AND paidPersonally = 0 AND voidedAt IS NULL) +
      (SELECT count(*) FROM order_payments WHERE voidedAt IS NULL AND accountId IS NULL) AS n`);
  const cents = (arr, key) => Number((arr.find(r => r.type === key || r.kind === key) || {}).c || 0);
  const contributed = cents(own, "contribution"), personal = Number(personalExp.c) + Number(personalBlanks.c);
  return {
    otherIncome: Object.fromEntries(Object.keys(OTHER_INCOME_TYPES).map(k => [k, fromCents(cents(byType, k))])),
    owner: { contributions: fromCents(contributed), paidPersonally: fromCents(personal), totalIn: fromCents(contributed + personal), draws: fromCents(cents(own, "draw")) },
    unassigned: Number(unassigned.n || 0),
    balances: await listAccounts(db, dateTo),
  };
}

// ---- Statement import & reconciliation (migrations/0015) ---------------------
// Long digit runs (card / account numbers) in statement descriptions are
// masked before storage: "…4412", never the full number.
export function maskStatementDescription(desc) {
  return String(desc || "").replace(/\d[\d -]{6,}\d/g, m => { const d = m.replace(/\D/g, ""); return d.length >= 8 ? "••••" + d.slice(-4) : m; })
    .replace(/\s+/g, " ").trim().slice(0, 200);
}
async function sha256Hex_(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}
// lines: [{date: YYYY-MM-DD, description, amountCents (signed, + = into the
// account)}], already validated. Identical lines on the same day are told
// apart by their order in the file, so re-importing the same (or an
// overlapping) statement inserts nothing new. Returns {inserted, duplicates}.
export async function importStatementLines(db, accountId, lines, batch) {
  const seen = {}, now = new Date().toISOString();
  const stmts = [];
  for (const l of lines) {
    const desc = maskStatementDescription(l.description);
    const key = `${l.date}|${l.amountCents}|${desc.toLowerCase()}`;
    const n = (seen[key] = (seen[key] || 0) + 1);
    const fp = await sha256Hex_(`${key}|${n}`);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO statement_lines (accountId, lineDate, description, amountCents, fingerprint, importBatch, importedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(Number(accountId), l.date, desc, Math.round(l.amountCents), fp, batch || "", now));
  }
  let inserted = 0;
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await db.batch(stmts.slice(i, i + 50));
    for (const r of res) inserted += (r.meta && r.meta.changes) || 0;
  }
  return { inserted, duplicates: lines.length - inserted };
}

// An account's recorded money movements between two dates (YYYY-MM-DD,
// inclusive), each keyed "src:srcId" — the same sources as the balances.
export async function listMoneyMoves(db, accountId, dateFrom, dateTo) {
  const out = [];
  for (const sql of MONEY_MOVE_SOURCES) {
    const { results } = await db.prepare(`SELECT * FROM (${sql}) m WHERE m.accountId = ? AND m.d >= ? AND m.d <= ?`)
      .bind(Number(accountId), dateFrom, dateTo).all();
    for (const r of results) out.push({ key: `${r.src}:${r.srcId}`, src: r.src, srcId: Number(r.srcId), date: r.d, cents: Number(r.c), label: r.label || "" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}
const addDays_ = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const monthBounds = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` };
};

async function matchedKeys_(db, accountId) {
  const { results } = await db.prepare(`SELECT sm.src, sm.srcId, sm.lineId FROM statement_matches sm JOIN statement_lines sl ON sl.id = sm.lineId WHERE sl.accountId = ?`)
    .bind(Number(accountId)).all();
  return new Map(results.map(r => [`${r.src}:${r.srcId}`, Number(r.lineId)]));
}

// Auto-match a month's unmatched statement lines to unmatched recorded
// movements of the same amount within ±5 days (closest date wins). A Stripe
// charge can show on its statement as one net line, so a payment + its fee
// (same payment id) also count as one candidate. Returns how many matched.
export async function autoMatchStatement(db, accountId, month) {
  const { from, to } = monthBounds(month);
  const { results: lines } = await db.prepare(`SELECT sl.* FROM statement_lines sl WHERE sl.accountId = ? AND sl.lineDate >= ? AND sl.lineDate <= ?
      AND sl.ignoredAt IS NULL AND NOT EXISTS (SELECT 1 FROM statement_matches sm WHERE sm.lineId = sl.id) ORDER BY sl.lineDate, sl.id`)
    .bind(Number(accountId), from, to).all();
  if (!lines.length) return 0;
  const taken = await matchedKeys_(db, accountId);
  const moves = (await listMoneyMoves(db, accountId, addDays_(from, -7), addDays_(to, 7))).filter(m => !taken.has(m.key));
  const byKey = new Map(moves.map(m => [m.key, m]));
  const groups = moves.map(m => ({ keys: [m.key], cents: m.cents, date: m.date }));
  for (const m of moves) if (m.src === "payment" && byKey.has(`fee:${m.srcId}`)) {
    groups.push({ keys: [m.key, `fee:${m.srcId}`], cents: m.cents + byKey.get(`fee:${m.srcId}`).cents, date: m.date });
  }
  const used = new Set();
  const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
  const stmts = [], now = new Date().toISOString();
  let matched = 0;
  for (const l of lines) {
    const best = groups.filter(g => g.cents === Number(l.amountCents) && g.keys.every(k => !used.has(k)) && days(g.date, l.lineDate) <= 5)
      .sort((a, b) => days(a.date, l.lineDate) - days(b.date, l.lineDate) || a.keys.length - b.keys.length)[0];
    if (!best) continue;
    for (const k of best.keys) {
      used.add(k);
      const [src, id] = k.split(":");
      stmts.push(db.prepare("INSERT OR IGNORE INTO statement_matches (lineId, src, srcId, matchedAt, auto) VALUES (?, ?, ?, ?, 1)").bind(l.id, src, Number(id), now));
    }
    matched++;
  }
  if (stmts.length) await db.batch(stmts);
  return matched;
}

export async function getStatementLine(db, id) {
  return await db.prepare("SELECT * FROM statement_lines WHERE id = ?").bind(Number(id)).first();
}
// Manual match: the chosen movements must be unmatched, in the line's
// account, and add up to exactly the line's amount.
export async function matchStatementLine(db, lineId, keys) {
  const line = await getStatementLine(db, lineId);
  if (!line) return { error: "Statement line not found" };
  const taken = await matchedKeys_(db, line.accountId);
  const moves = await listMoneyMoves(db, line.accountId, "0000-01-01", "9999-12-31");
  const byKey = new Map(moves.map(m => [m.key, m]));
  let sum = 0;
  for (const k of keys) {
    const m = byKey.get(k);
    if (!m) return { error: "One of the chosen items isn't in this account" };
    if (taken.has(k) && taken.get(k) !== Number(lineId)) return { error: "One of the chosen items is already matched to another line" };
    sum += m.cents;
  }
  if (sum !== Number(line.amountCents)) return { error: `The chosen items add up to ${(sum / 100).toFixed(2)}, not ${(line.amountCents / 100).toFixed(2)}` };
  const now = new Date().toISOString();
  await db.batch([db.prepare("DELETE FROM statement_matches WHERE lineId = ?").bind(Number(lineId)),
    ...keys.map(k => { const [src, id] = k.split(":"); return db.prepare("INSERT INTO statement_matches (lineId, src, srcId, matchedAt, auto) VALUES (?, ?, ?, ?, 0)").bind(Number(lineId), src, Number(id), now); })]);
  return { ok: true };
}
export async function unmatchStatementLine(db, lineId) {
  await db.prepare("DELETE FROM statement_matches WHERE lineId = ?").bind(Number(lineId)).run();
}
export async function setStatementLineIgnored(db, lineId, reason) {
  if (reason === null) await db.prepare("UPDATE statement_lines SET ignoredAt = NULL, ignoreReason = '' WHERE id = ?").bind(Number(lineId)).run();
  else await db.prepare("UPDATE statement_lines SET ignoredAt = ?, ignoreReason = ? WHERE id = ?").bind(new Date().toISOString(), String(reason).slice(0, 200), Number(lineId)).run();
}

// Everything the reconcile screen needs for one account-month. Book balance
// = opening + every recorded movement through month end. When every
// statement line (since the opening date) is matched or ignored, the
// statement's ending balance must equal: book balance − recorded items not
// yet on any statement (uncleared) + ignored statement lines. Dollars out.
export async function getReconciliationData(db, accountId, month) {
  const account = await db.prepare("SELECT * FROM accounts WHERE id = ?").bind(Number(accountId)).first();
  if (!account) return null;
  const { from, to } = monthBounds(month);
  const [allMoves, taken, { results: lines }, { results: matchRows }, rec, ign] = await Promise.all([
    listMoneyMoves(db, accountId, account.openingDate, addDays_(to, 10)),
    matchedKeys_(db, accountId),
    db.prepare("SELECT * FROM statement_lines WHERE accountId = ? AND lineDate >= ? AND lineDate <= ? ORDER BY lineDate, id").bind(Number(accountId), from, to).all(),
    db.prepare("SELECT sm.* FROM statement_matches sm JOIN statement_lines sl ON sl.id = sm.lineId WHERE sl.accountId = ? AND sl.lineDate >= ? AND sl.lineDate <= ?").bind(Number(accountId), from, to).all(),
    db.prepare("SELECT * FROM reconciliations WHERE accountId = ? AND month = ?").bind(Number(accountId), month).first(),
    db.prepare("SELECT COALESCE(SUM(amountCents), 0) c FROM statement_lines WHERE accountId = ? AND ignoredAt IS NOT NULL AND lineDate >= ? AND lineDate <= ?").bind(Number(accountId), account.openingDate, to).first(),
  ]);
  const moveByKey = new Map(allMoves.map(m => [m.key, m]));
  const matchesByLine = {};
  for (const r of matchRows) (matchesByLine[r.lineId] = matchesByLine[r.lineId] || []).push(`${r.src}:${r.srcId}`);
  const outLines = lines.map(l => {
    const keys = matchesByLine[l.id] || [];
    const items = keys.map(k => moveByKey.get(k)).filter(Boolean);
    const broken = keys.length > 0 && items.length !== keys.length;   // a matched item was since voided/deleted
    return { id: Number(l.id), date: l.lineDate, description: l.description, amount: fromCents(l.amountCents),
      status: l.ignoredAt ? "ignored" : broken ? "broken" : items.length ? "matched" : "unmatched",
      ignoreReason: l.ignoreReason || "", matched: items.map(m => ({ key: m.key, date: m.date, label: m.label, amount: fromCents(m.cents) })) };
  });
  const through = allMoves.filter(m => m.date <= to);
  const bookCents = Number(account.openingBalanceCents) + through.reduce((a, m) => a + m.cents, 0);
  const uncleared = through.filter(m => !taken.has(m.key));
  const unclearedCents = uncleared.reduce((a, m) => a + m.cents, 0);
  const expectedStatementCents = bookCents - unclearedCents + Number(ign.c);
  return {
    account: { id: Number(account.id), name: account.name, type: account.type, openingDate: account.openingDate, csvMapping: account.csvMapping || "" },
    month, from, to, lines: outLines,
    unmatchedBook: uncleared.filter(m => m.date >= from).map(m => ({ key: m.key, date: m.date, label: m.label, amount: fromCents(m.cents) })),
    unclearedEarlier: uncleared.filter(m => m.date < from).map(m => ({ key: m.key, date: m.date, label: m.label, amount: fromCents(m.cents) })),
    candidates: allMoves.filter(m => !taken.has(m.key) && m.date >= addDays_(from, -10)).map(m => ({ key: m.key, date: m.date, label: m.label, amount: fromCents(m.cents) })),
    bookBalance: fromCents(bookCents), uncleared: fromCents(unclearedCents), ignored: fromCents(Number(ign.c)),
    expectedStatementBalance: fromCents(expectedStatementCents),
    reconciled: rec ? { statementBalance: fromCents(rec.statementEndingBalanceCents), bookBalance: fromCents(rec.bookBalanceCents), at: rec.reconciledAt, by: rec.reconciledBy } : null,
  };
}
export async function setReconciled(db, accountId, month, statementCents, bookCents, by) {
  await db.prepare(`INSERT OR REPLACE INTO reconciliations (accountId, month, statementEndingBalanceCents, bookBalanceCents, reconciledAt, reconciledBy)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(Number(accountId), month, Math.round(statementCents), Math.round(bookCents), new Date().toISOString(), by || "").run();
}
export async function clearReconciled(db, accountId, month) {
  await db.prepare("DELETE FROM reconciliations WHERE accountId = ? AND month = ?").bind(Number(accountId), month).run();
}
export async function isReconciled(db, accountId, month) {
  return !!(await db.prepare("SELECT 1 x FROM reconciliations WHERE accountId = ? AND month = ?").bind(Number(accountId), month).first());
}
export async function listReconciliations(db) {
  const { results } = await db.prepare(`SELECT r.*, a.name FROM reconciliations r JOIN accounts a ON a.id = r.accountId ORDER BY r.month, a.id`).all();
  return results.map(r => ({ account: r.name, month: r.month, statementBalance: fromCents(r.statementEndingBalanceCents),
    bookBalance: fromCents(r.bookBalanceCents), reconciledAt: r.reconciledAt, by: r.reconciledBy }));
}
export async function saveCsvMapping(db, accountId, mapping) {
  await db.prepare("UPDATE accounts SET csvMapping = ? WHERE id = ?").bind(JSON.stringify(mapping || {}).slice(0, 2000), Number(accountId)).run();
}

// ---- Failed admin sign-ins (reported in the daily roll-up) --------------------
// Counted at /api/admin-session (wrong passphrase / wrong 2FA code) in
// global_settings key "failedAdminLogins": {count, passphrase, code, ips[<=10],
// first, last}. Cleared once a roll-up reporting them is sent.
export async function recordFailedAdminLogin(db, reason, ip) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='failedAdminLogins'").first();
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch (_) {}
  const now = new Date().toISOString();
  v.count = (Number(v.count) || 0) + 1;
  v[reason === "code" ? "code" : "passphrase"] = (Number(v[reason === "code" ? "code" : "passphrase"]) || 0) + 1;
  v.ips = Array.isArray(v.ips) ? v.ips : [];
  if (ip && !v.ips.includes(ip) && v.ips.length < 10) v.ips.push(String(ip).slice(0, 45));
  v.first = v.first || now; v.last = now;
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('failedAdminLogins', ?)").bind(JSON.stringify(v)).run();
}
export async function getFailedAdminLogins(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='failedAdminLogins'").first();
  try { const v = row ? JSON.parse(row.value) : null; return v && v.count > 0 ? v : null; } catch (_) { return null; }
}
export async function clearFailedAdminLogins(db) {
  await db.prepare("DELETE FROM global_settings WHERE key='failedAdminLogins'").run();
}

// ---- System problems for the 6 AM roll-up ---------------------------------------------------
// Failures that would otherwise show up only in the Worker's log: an email that couldn't be sent,
// a Stripe webhook whose update failed (Stripe retries it), a roll-up run that didn't complete.
// Kept like failedAdminLogins — one small global_settings value, no table — and reported in the
// next roll-up (a reason to send one), then cleared.
// {kinds: {<kind>: {count, first, last, samples[<=5]}}}
export const SYSTEM_ISSUE_LABELS = {
  email_failed: "Emails that couldn't be sent at all",
  webhook_failed: "Stripe webhook updates that failed (Stripe retries these)",
  digest_failed: "Daily roll-ups that did not complete (the scheduled run will try again tomorrow)",
};
export async function recordSystemIssue(db, kind, sample) {
  if (!db || typeof db.prepare !== "function") return;
  try {
    const row = await db.prepare("SELECT value FROM global_settings WHERE key='systemIssues'").first();
    let v = {};
    try { v = row ? JSON.parse(row.value) : {}; } catch (_) {}
    v.kinds = v.kinds || {};
    const now = new Date().toISOString();
    const k = (v.kinds[kind] = v.kinds[kind] || { count: 0, first: now, samples: [] });
    k.count++; k.last = now;
    if (sample && k.samples.length < 5) k.samples.push(String(sample).slice(0, 200));
    await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('systemIssues', ?)").bind(JSON.stringify(v)).run();
  } catch (e) { console.error("Could not record system issue", kind, e); }
}
export async function getSystemIssues(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='systemIssues'").first();
  try {
    const v = row ? JSON.parse(row.value) : null;
    const kinds = (v && v.kinds) || {};
    const list = Object.entries(kinds).filter(([, k]) => k && k.count > 0)
      .map(([kind, k]) => ({ kind, label: SYSTEM_ISSUE_LABELS[kind] || kind, count: k.count, first: k.first, last: k.last, samples: k.samples || [] }));
    return list.length ? list : null;
  } catch (_) { return null; }
}
export async function clearSystemIssues(db) {
  await db.prepare("DELETE FROM global_settings WHERE key='systemIssues'").run();
}

// ---- Daily order roll-up (owner digest) -------------------------------------
// Owner notices (Stripe payments/refunds/disputes, design responses) wait in
// owner_notices until the next roll-up lists them (migrations/0011).
export async function addOwnerNotice(db, { kind, orderId, orgId, summary, detail, imageUrls, urgent }) {
  await db.prepare(
    `INSERT INTO owner_notices (kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(kind, orderId || "", orgId || "", String(summary || "").slice(0, 500), String(detail || "").slice(0, 4000),
    JSON.stringify((imageUrls || []).filter(Boolean).slice(0, 10)), urgent ? 1 : 0, new Date().toISOString()).run();
}
export async function getUnsentOwnerNotices(db) {
  const { results } = await db.prepare("SELECT * FROM owner_notices WHERE sentAt IS NULL ORDER BY id LIMIT 500").all();
  return results.map(r => ({ id: Number(r.id), kind: r.kind, orderId: r.orderId, orgId: r.orgId, summary: r.summary,
    detail: r.detail, imageUrls: (() => { try { return JSON.parse(r.imageUrls); } catch (_) { return []; } })(),
    urgent: !!r.urgent, createdAt: r.createdAt }));
}
export async function markOwnerNoticesSent(db, ids) {
  if (!ids.length) return;
  const at = new Date().toISOString();
  await db.batch(ids.map(id => db.prepare("UPDATE owner_notices SET sentAt = ? WHERE id = ? AND sentAt IS NULL").bind(at, id)));
}

// Progress is the newest order already reported, by when it was WRITTEN (orders.insertedAt,
// migrations/0031) — so a backdated order date can't make an order be skipped or sent twice, and
// a VACUUM or table rebuild can't renumber it the way an implicit-rowid cursor could. Stored in global_settings as {"afterInsertedAt": ISO, "afterOrderId": id, "sentAt": ISO}
// (before migrations/0031: {"afterRowid": N, "sentAt": ISO} — see getOrdersForDigest).
export async function getDigestState(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='dailyDigest'").first();
  try { return row ? JSON.parse(row.value) : null; } catch (_) { return null; }
}
export async function setDigestState(db, state) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('dailyDigest', ?)").bind(JSON.stringify(state)).run();
}
// The last time the roll-up RAN, whatever it found — {at, trigger, ok, sent, orders, notices, delivered,
// message}. Kept apart from `dailyDigest` (the cursor, which only moves when an email goes out): a run
// that finds nothing sends nothing, and without this record "no email" couldn't be told from
// "it never ran". Communications shows it.
export async function getDigestRun(db) {
  const row = await db.prepare("SELECT value FROM global_settings WHERE key='dailyDigestRun'").first();
  try { return row ? JSON.parse(row.value) : null; } catch (_) { return null; }
}
export async function setDigestRun(db, run) {
  await db.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('dailyDigestRun', ?)").bind(JSON.stringify(run)).run();
}
// Real orders not yet reported (test and voided orders are skipped), full detail, plus `cursor` —
// the fields to save as the new state once the email has gone out.
//
// "Not yet reported" = written after the cursor {afterInsertedAt, afterOrderId} (migrations/0031:
// orders.insertedAt, set by a trigger on insert). insertedAt, not placedAt: a backdated order (a local
// sale entered later) is still new to the owner. The cursor passes over test/voided orders too, so
// they're never reconsidered. First run (no state): the last 24 hours by placedAt.
// Switch-over: a state saved before 0031 holds {afterRowid}; that one run still uses rowid (so
// nothing is skipped or repeated), then the cursor jumps to the newest order.
// Before 0031 is applied (no insertedAt column), the rowid logic runs and saves {afterRowid}.
export async function getOrdersForDigest(db, state, now = new Date()) {
  const real = (r) => !Number(r.isTest) && !r.voidedAt;
  const load = async (ids) => ids.length
    ? loadOrders_(db, "o.orderId IN (SELECT value FROM json_each(?))", [JSON.stringify(ids)], "o.placedAt ASC")
    : [];
  let newest;
  try {
    newest = await db.prepare("SELECT insertedAt, orderId FROM orders WHERE insertedAt IS NOT NULL ORDER BY insertedAt DESC, orderId DESC LIMIT 1").first();
  } catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    return getOrdersForDigestByRowid_(db, state, now, load, real);
  }
  const atNewest = newest ? { afterInsertedAt: newest.insertedAt, afterOrderId: newest.orderId } : { afterInsertedAt: "", afterOrderId: "" };

  if (state && typeof state.afterInsertedAt === "string") {
    const { results } = await db.prepare(
      `SELECT orderId, insertedAt, isTest, voidedAt FROM orders
        WHERE insertedAt > ? OR (insertedAt = ? AND orderId > ?)
        ORDER BY insertedAt, orderId`).bind(state.afterInsertedAt, state.afterInsertedAt, String(state.afterOrderId || "")).all();
    const last = results[results.length - 1];
    const cursor = last ? { afterInsertedAt: last.insertedAt, afterOrderId: last.orderId }
                        : { afterInsertedAt: state.afterInsertedAt, afterOrderId: String(state.afterOrderId || "") };
    return { orders: await load(results.filter(real).map(r => r.orderId)), cursor };
  }
  if (state && Number.isFinite(Number(state.afterRowid))) {
    const old = await getOrdersForDigestByRowid_(db, state, now, load, real);
    return { orders: old.orders, cursor: atNewest };
  }
  const { results } = await db.prepare("SELECT orderId, isTest, voidedAt FROM orders WHERE placedAt >= ?")
    .bind(new Date(now.getTime() - 24 * 3600 * 1000).toISOString()).all();
  return { orders: await load(results.filter(real).map(r => r.orderId)), cursor: atNewest };
}

// The pre-0031 cursor (implicit rowid): used before the migration, and once for the switch-over.
async function getOrdersForDigestByRowid_(db, state, now, load, real) {
  const maxRow = await db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM orders").first();
  const throughRowid = Number(maxRow.m) || 0;
  const { results } = state && Number.isFinite(Number(state.afterRowid))
    ? await db.prepare("SELECT orderId, isTest, voidedAt FROM orders WHERE rowid > ? AND rowid <= ? ORDER BY rowid")
        .bind(Number(state.afterRowid), throughRowid).all()
    : await db.prepare("SELECT orderId, isTest, voidedAt FROM orders WHERE placedAt >= ? AND rowid <= ? ORDER BY rowid")
        .bind(new Date(now.getTime() - 24 * 3600 * 1000).toISOString(), throughRowid).all();
  return { orders: await load(results.filter(real).map(r => r.orderId)), cursor: { afterRowid: throughRowid } };
}

// Moves a (non-Stripe) ledger entry to another account, e.g. a check that was
// deposited somewhere other than the method's default.
export async function setPaymentAccount(db, id, accountId) {
  await db.prepare("UPDATE order_payments SET accountId = ? WHERE id = ?").bind(Number(accountId), Number(id)).run();
}

// Corrects when a ledger entry's money actually arrived (entries recorded
// late, or imported, carry the date they were typed in). Keeps the order's
// paidAt in step: a paid order is paid as of its latest payment.
export async function setPaymentDate(db, id, receivedAt) {
  const row = await db.prepare("SELECT orderId FROM order_payments WHERE id=?").bind(Number(id)).first();
  if (!row) return null;
  await db.prepare("UPDATE order_payments SET receivedAt = ? WHERE id = ?").bind(receivedAt, Number(id)).run();
  await db.prepare(`UPDATE orders SET paidAt = (SELECT MAX(receivedAt) FROM order_payments
      WHERE orderId = orders.orderId AND kind = 'payment' AND voidedAt IS NULL)
    WHERE orderId = ? AND paid = 1`).bind(row.orderId).run();
  return row.orderId;
}

// Card payments linked to a Stripe PaymentIntent (for syncing their dates).
export async function getStripeLinkedPayments(db) {
  const { results } = await db.prepare(
    `SELECT id, orderId, receivedAt, externalRef, feeCents FROM order_payments
     WHERE method = 'card' AND kind = 'payment' AND voidedAt IS NULL AND externalRef LIKE 'pi_%' ORDER BY receivedAt`
  ).all();
  return results.map(r => ({ id: Number(r.id), orderId: r.orderId, receivedAt: r.receivedAt, externalRef: r.externalRef, feeCents: Number(r.feeCents) }));
}

// Stripe card payments that don't have their processing fee recorded yet
// (for the one-time backfill admin action).
export async function getCardPaymentsMissingFees(db) {
  const { results } = await db.prepare(
    `SELECT p.id, p.orderId, p.amountCents, p.externalRef, p.receivedAt FROM order_payments p
     WHERE p.method = 'card' AND p.kind = 'payment' AND p.feeCents = 0 AND p.voidedAt IS NULL
       AND p.note NOT LIKE 'Local sale%'   -- an in-person card sale has no Checkout Session to look up; its fee comes from the payout (Deposit → Stripe payout)
     ORDER BY p.receivedAt`
  ).all();
  return results.map(r => ({ id: Number(r.id), orderId: r.orderId, amount: fromCents(r.amountCents), externalRef: r.externalRef || "", receivedAt: r.receivedAt }));
}

// Card payments recorded by the Stripe webhook whose fee is still 0 (Stripe often hasn't created the
// charge's balance transaction yet when the webhook fires). Used by the background follow-up and the
// daily safety net in functions/_lib/stripeFees.js.
export async function getRecentCardPaymentsMissingFee(db, sinceIso, limit = 20) {
  const { results } = await db.prepare(
    `SELECT id, externalRef FROM order_payments
     WHERE method = 'card' AND kind = 'payment' AND feeCents = 0 AND voidedAt IS NULL
       AND externalRef LIKE 'pi_%' AND note NOT LIKE 'Local sale%' AND receivedAt >= ?
     ORDER BY receivedAt DESC LIMIT ?`
  ).bind(sinceIso, limit).all();
  return results.map(r => ({ id: Number(r.id), externalRef: r.externalRef }));
}

// Sets the fee on the card payment for a PaymentIntent, only while it is still 0. Returns rows changed.
export async function setCardFeeByRef(db, externalRef, feeCents) {
  const r = await db.prepare(
    "UPDATE order_payments SET feeCents = ? WHERE externalRef = ? AND method = 'card' AND kind = 'payment' AND feeCents = 0"
  ).bind(Math.max(0, Math.round(Number(feeCents) || 0)), externalRef).run();
  return (r.meta && r.meta.changes) || 0;
}

export async function setPaymentFee(db, paymentId, feeCents, externalRef) {
  await db.prepare(
    "UPDATE order_payments SET feeCents = ?, externalRef = CASE WHEN externalRef = '' THEN ? ELSE externalRef END WHERE id = ?"
  ).bind(Math.max(0, Math.round(Number(feeCents) || 0)), externalRef || "", Number(paymentId)).run();
}

// ---- Internal helpers --------------------------------------------------

function parsePayment_(row) {
  return {
    id: Number(row.id),
    orderId: row.orderId,
    amount: fromCents(row.amountCents),          // negative for refunds / lost disputes
    note: row.note || "",
    method: row.method || "other",
    reference: row.reference || "",
    fee: fromCents(row.feeCents),                // kept by the processor (Stripe)
    kind: row.kind || "payment",
    voidedAt: row.voidedAt || "",                // voided entries are excluded from every total
    voidReason: row.voidReason || "",
    receivedAt: row.receivedAt || "",
    fromStripe: /^(pi_|re_|dp_|cs_)/.test(row.externalRef || ""), // real Stripe movement: refund in Stripe, don't void
    accountId: row.accountId == null ? null : Number(row.accountId),
    shipping: fromCents(row.shippingCents || 0),  // refunds: how much of it was shipping (untaxed, 0035)
  };
}

// Per-line-item blank progress for the Orders table (migrations/0039). Counts active (not cancelled)
// lines at each blank stage; blankShippedAt is derived (no order column) and set only when every
// active line has shipped, mirroring how recomputeOrderBlankStatus_ sets the order-level ordered/
// received summaries. blankCounts drives the "N/T" partial-progress labels in the admin cells.
function blankProgress_(items) {
  const active = (items || []).filter(it => !it.cancelDate);
  const total = active.length;
  const ordered = active.filter(it => it.blankOrderedAt).length;
  const shipped = active.filter(it => it.blankShippedAt).length;
  const received = active.filter(it => it.blankReceivedAt).length;
  // The latest ship date across active lines, surfaced only when they've all shipped.
  const allShipped = total > 0 && shipped === total;
  const blankShippedAt = allShipped
    ? active.reduce((m, it) => (it.blankShippedAt > m ? it.blankShippedAt : m), "")
    : "";
  return { blankShippedAt, blankCounts: { ordered, shipped, received, total } };
}

function parseOrder_(row, items, payments, labels) {
  payments = payments || [];
  const live = payments.filter(p => !p.voidedAt);
  // All arithmetic in integer cents, converted to dollars only on the way out.
  // "Received" = actual payments; refunds / lost disputes are tracked apart.
  const receivedCents = live.filter(p => (p.kind || "payment") === "payment").reduce((s, p) => s + toCents(p.amount), 0);
  const refundedCents = -live.filter(p => p.kind === "refund" || p.kind === "dispute").reduce((s, p) => s + toCents(p.amount), 0);
  const feesCents = live.reduce((s, p) => s + toCents(p.fee || 0), 0);
  const discountCents = Number(row.discountCents) || 0;
  const shippingCents = Number(row.shippingCostCents) || 0;
  // Derive from items (same formula as the top-bar grandTotal) — row.subtotal and
  // row.total can be stale when items are cancelled or shipping is added post-placement.
  const activeItems = items.filter(it => !it.cancelDate);
  const activeItemsCents = activeItems.reduce((s, it) => s + toCents(it.lineTotal), 0);
  // Tax included in what's owed for goods: active lines' tax, less the tax
  // portion of any discount. Shipping is not taxed.
  const itemsTaxCents = activeItems.reduce((s, it) => s + toCents(it.tax), 0);
  const taxMode = taxMode_(row.taxMode);
  // parseItem_ doesn't know the order's mode: with tax on top, a line's net is its listed total.
  if (taxMode === "exclusive") for (const it of items) { it.netAmount = it.lineTotal; it.taxIncluded = false; }
  const amounts = orderAmounts({ itemsCents: activeItemsCents, itemsTaxCents, shippingCents, discountCents, discountTaxCents: row.discountTaxCents, taxMode });
  const salesTaxCents = amounts.taxCents, netSalesCents = amounts.netSalesCents, effectiveCents = amounts.owedCents;
  const amountReceived = fromCents(receivedCents);
  const discountAmount = fromCents(discountCents);
  const shippingCost = fromCents(shippingCents);
  const shippingPaidAmount = fromCents(row.shippingPaidCents);
  const activeItemsTotal = fromCents(activeItemsCents);
  const effectiveTotal = fromCents(effectiveCents);
  const balanceDue = fromCents(Math.max(0, effectiveCents - receivedCents));
  return {
    orderId: row.orderId,
    orgId: row.orgId,
    customerName: row.customerName,
    contact: row.contact,
    paymentMethod: row.paymentMethod || "",
    paid: !!row.paid,
    paidAt: row.paidAt || "",
    refundedAt: row.refundedAt || "",
    disputeStatus: row.disputeStatus || "",
    subtotal: fromCents(row.subtotalCents),
    itemsSubtotal: activeItemsTotal,
    shippingCost,
    shippingPaidAmount,
    discountAmount,
    discountNote: row.discountNote || "",
    taxExempt: !!row.taxExempt,
    voidedAt: row.voidedAt || "",
    voidReason: row.voidReason || "",
    isTest: !!row.isTest,
    taxRate: (Number(row.taxRateBps) || 0) / 100,
    taxMode,                              // "inclusive": salesTax is inside the item prices; "exclusive": added on top
    salesTax: fromCents(salesTaxCents),
    netSales: fromCents(netSalesCents),   // goods revenue excluding tax and shipping
    total: fromCents(row.totalCents),
    effectiveTotal,
    amountReceived,
    refundedAmount: fromCents(refundedCents),            // refunds + lost disputes (positive)
    netReceived: fromCents(receivedCents - refundedCents),
    processorFees: fromCents(feesCents),
    labels: labels || [],
    labelCost: fromCents((labels || []).filter(l => !l.voidedAt).reduce((s, l) => s + toCents(l.amount), 0)),
    balanceDue,
    payments,
    shippingMethod: row.shippingMethod || "",
    shippingAddress: row.shippingAddress ? tryParse_(row.shippingAddress, null) : null,
    totalWeightOz: Number(row.totalWeightOz) || 0,
    parcelLength: Number(row.parcelLength) || 0,
    parcelWidth:  Number(row.parcelWidth)  || 0,
    parcelHeight: Number(row.parcelHeight) || 0,
    trackingNumber: row.trackingNumber || "",
    receivedEmailAt: row.receivedEmailAt || "",
    confirmedEmailAt: row.confirmedEmailAt || "",
    blankOrderedAt: row.blankOrderedAt || "",
    blankVendor: row.blankVendor || "",
    blankVendorOrderId: row.blankVendorOrderId || "",
    blankEstDelivery: row.blankEstDelivery || "",
    blankReceivedAt: row.blankReceivedAt || "",
    // Per-line-item progress for the Orders table's blank cells (migrations/0039). The order-level
    // columns above are all-or-nothing summaries; these show partial progress (e.g. "2/5 shipped"),
    // and blankShippedAt has no order column at all, so it's derived here (set only when every
    // active line has shipped).
    ...blankProgress_(items),
    blankCondition: row.blankCondition || "",
    manufacturedAt: row.manufacturedAt || "",
    digitizingCompleteAt: row.digitizingCompleteAt || "",
    designApprovedAt: row.designApprovedAt || "",
    // false only when the loader computed it and no active line has free-form personalization;
    // a loader that didn't select it keeps the default (approval required).
    needsDesignApproval: row.needsDesignApproval == null ? true : !!row.needsDesignApproval,
    needsDigitizing: row.needsDigitizing == null ? true : !!row.needsDigitizing,  // false: every product has a design
    // Typed-in-personalization lines still waiting for their order-specific design upload (0032).
    orderDesignsMissing: Number(row.orderDesignsMissing) || 0,
    qaPackedAt: row.qaPackedAt || "",
    shippedAt: row.shippedAt || "",
    deliveredAt: row.deliveredAt || "",
    completedAt: row.completedAt || "",
    placedAt: row.placedAt || "",
    dueDate: row.dueDate || "",   // optional (migrations/0038); prioritizes the run queues
    items,
  };
}

function parseItem_(row) {
  return {
    id: row.id,
    orderId: row.orderId,
    productId: row.productId || "",
    name: row.name,
    type: row.type,
    size: row.size || "",
    qty: Number(row.qty) || 1,
    unitPrice: fromCents(row.unitPriceCents),
    personalized: !!row.personalized,
    persName: row.persName || "",
    personalizationFee: fromCents(row.personalizationFeeCents),
    lineTotal: fromCents(row.lineTotalCents),
    taxRate: (Number(row.taxRateBps) || 0) / 100,          // percent, e.g. 6
    tax: fromCents(row.taxCents),                           // included in lineTotal — or on top of it (order.taxMode; parseOrder_ fixes netAmount)
    netAmount: fromCents((Number(row.lineTotalCents) || 0) - (Number(row.taxCents) || 0)),
    cogs: fromCentsOrNull(row.cogsCents),                    // blank cost; null = not yet known
    cogsSource: row.cogsSource || "",
    cancelDate: row.cancelDate || "",
    cancelReason: row.cancelReason || "",
    lateCancel: !!row.lateCancel,
    refundDate: row.refundDate || "",
    refundAmount: fromCentsOrNull(row.refundCents),
    blankCondition: row.blankCondition || "",
    blankConditionNote: row.blankConditionNote || "",
    // Per-line-item blank fulfillment (migrations/0039).
    blankOrderedAt: row.blankOrderedAt || "",
    blankShippedAt: row.blankShippedAt || "",
    blankReceivedAt: row.blankReceivedAt || "",
    blankVendor: row.blankVendor || "",
    blankVendorOrderId: row.blankVendorOrderId || "",
    blankEstDelivery: row.blankEstDelivery || "",
    // Configurable line snapshot + transfer-received gate (migrations/0036).
    config: tryParse_(row.configJson, null),
    transferReceivedAt: row.transferReceivedAt || "",
    // sheetRow: the name admin.js knows a line item's id by (item.sheetRow)
    sheetRow: row.id,
  };
}

export async function getReadyToShipByOrg(db, orgId) {
  const { results } = await db.prepare(
    "SELECT productId, size, quantity FROM ready_to_ship WHERE orgId=? ORDER BY productId, size"
  ).bind(orgId).all();
  return results.map(r => ({ productId: r.productId, size: r.size, quantity: Number(r.quantity) || 0 }));
}

export async function upsertReadyToShipQty(db, orgId, productId, size, quantity) {
  const updatedAt = new Date().toISOString();
  await db.prepare(
    `INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(orgId, productId, size) DO UPDATE SET quantity=excluded.quantity, updatedAt=excluded.updatedAt`
  ).bind(orgId, productId, size, Math.max(0, Number(quantity) || 0), updatedAt).run();
}

export async function updateOrderPlacedAt(db, orderId, placedAt) {
  await db.prepare("UPDATE orders SET placedAt = ? WHERE orderId = ?")
    .bind(placedAt, orderId).run();
}

// The optional due date (migrations/0038) — a 'YYYY-MM-DD' string, or null/'' to clear it.
// Prioritizes the Run Order and Run Transfer Sheets queues (soonest first, undated last).
export async function setOrderDueDate(db, orderId, dueDate) {
  const d = dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(dueDate)) ? String(dueDate) : null;
  await db.prepare("UPDATE orders SET dueDate = ? WHERE orderId = ?").bind(d, orderId).run();
  return d;
}

export async function getRevenueData(db, dateFrom, dateTo) {
  const { results } = await withTaxMode_((tm) => db.prepare(`
    SELECT
      o.orderId,
      o.orgId,
      o.discountCents, o.discountTaxCents, o.shippingCostCents, ${tm} AS taxMode,
      COALESCE(SUM(CASE WHEN oi.cancelDate IS NULL THEN oi.lineTotalCents ELSE 0 END), 0) AS itemsCents,
      COALESCE(SUM(CASE WHEN oi.cancelDate IS NULL THEN oi.taxCents ELSE 0 END), 0) AS itemsTaxCents,
      -- Net of refunds and lost disputes (negative rows): a refund — e.g. shipping overcharged then
      -- refunded, after the order's shipping was lowered to match — must not leave "received" above
      -- what the order now costs.
      COALESCE((SELECT SUM(p.amountCents) FROM order_payments p WHERE p.orderId = o.orderId AND p.kind IN ('payment', 'refund', 'dispute') AND p.voidedAt IS NULL), 0) / 100.0 AS received
    FROM orders o
    LEFT JOIN order_items oi ON oi.orderId = o.orderId
    WHERE o.placedAt >= ? AND o.placedAt <= ?
      AND o.isTest = 0 AND o.voidedAt IS NULL
    GROUP BY o.orderId
  `).bind(dateFrom, dateTo).all());
  // Dollars out; effectiveTotal is what the order comes to (orderAmounts), shipping what it charges.
  return results.map(r => {
    const a = orderAmountsOfRow_(r);
    return { orderId: r.orderId, orgId: r.orgId, itemSubtotal: fromCents(r.itemsCents), discountAmount: fromCents(r.discountCents),
      shippingCost: fromCents(a.shippingCents), salesTax: fromCents(a.taxCents), effectiveTotal: fromCents(a.owedCents), received: r.received };
  });
}

// Sales-tax report (accrual, by the month the order was placed). One row per
// (month, exempt?, ship-to state). Excludes test and voided orders. Dollars out.
// taxCollected = active lines' tax - discount tax; netTaxable = goods sold
// excluding tax; shipping is reported separately (not taxed). Each order is read in its own
// tax mode (the listed prices include the tax, or it was added on top), so a period with both
// adds up: gross is always what customers paid for goods, net always excludes the tax.
export async function getSalesTaxReport(db, dateFrom, dateTo) {
  const { results } = await withTaxMode_((tm) => db.prepare(`
    WITH per AS (
      SELECT o.orderId, substr(o.placedAt, 1, 7) AS month, o.taxExempt AS exempt, ${tm} AS mode,
             COALESCE(o.shipState, '') AS state, o.orgId,
             o.discountCents AS disc, o.discountTaxCents AS discTax, o.shippingCostCents AS ship,
             COALESCE(SUM(CASE WHEN i.cancelDate IS NULL THEN i.lineTotalCents END), 0) AS gross,
             COALESCE(SUM(CASE WHEN i.cancelDate IS NULL THEN i.taxCents END), 0) AS tax
      FROM orders o LEFT JOIN order_items i ON i.orderId = o.orderId
      WHERE o.placedAt >= ? AND o.placedAt <= ? AND o.isTest = 0 AND o.voidedAt IS NULL
      GROUP BY o.orderId
    )
    SELECT month, exempt, state,
           COUNT(*) AS orders,
           SUM(gross) AS grossCents,
           SUM(MIN(disc, gross)) AS discountCents,
           SUM(MAX(tax - discTax, 0)) AS taxCents,
           SUM(CASE WHEN mode = 'exclusive' THEN MAX(tax - discTax, 0) ELSE 0 END) AS taxAddedCents,
           SUM(CASE WHEN gross > 0 THEN ship ELSE 0 END) AS shippingCents,
           GROUP_CONCAT(DISTINCT orgId) AS orgs
    FROM per GROUP BY month, exempt, state ORDER BY month, exempt, state
  `).bind(dateFrom, dateTo).all());
  return results.map(r => {
    // Listed prices after the discount, plus the tax that was added on top of them.
    const grossAfterDiscount = Math.max(0, Number(r.grossCents) - Number(r.discountCents)) + (Number(r.taxAddedCents) || 0);
    return {
      month: r.month, exempt: !!r.exempt, state: r.state, orders: Number(r.orders),
      grossSales: fromCents(grossAfterDiscount),              // what customers paid for goods (tax included)
      taxCollected: fromCents(r.taxCents),
      netSales: fromCents(grossAfterDiscount - Number(r.taxCents)), // taxable (or exempt) sales, tax excluded
      shipping: fromCents(r.shippingCents),                   // not taxed
      orgs: String(r.orgs || "").split(",").filter(Boolean),
    };
  });
}

// Month-by-month figures laid out like a state sales & use tax return
// (each period, and the annual return). Sales EXCLUDE tax (backed out of
// tax-inclusive prices; never in tax-exclusive ones — per order): taxable sales + the three
// deductions (exempt-org, out-of-state/interstate, non-taxable services) =
// gross sales. Discounts are shared across an order's lines by amount. Use tax
// = the current rate × untaxed purchases of use-taxable goods (expenses whose
// category is use-taxable and whose vendor didn't charge sales tax). Dollars out.
export async function getSalesTaxReturn(db, dateFrom, dateTo) {
  const settings = await getSalesTaxSettings(db);
  const { results: lines } = await withTaxMode_((tm) => db.prepare(`
    SELECT substr(o.placedAt, 1, 7) AS month, o.orderId, o.taxExempt, o.shipState, o.discountCents, o.discountTaxCents,
           o.shippingCostCents, i.lineTotalCents, i.taxCents, i.taxable, ${tm} AS taxMode
    FROM orders o JOIN order_items i ON i.orderId = o.orderId
    WHERE o.placedAt >= ? AND o.placedAt <= ? AND o.isTest = 0 AND o.voidedAt IS NULL AND i.cancelDate IS NULL
    ORDER BY o.orderId`).bind(dateFrom, dateTo).all());
  const months = {};
  // taxable = taxable sales as listed; taxIncl = the tax that is INSIDE that figure (inclusive orders
  // only), so taxable − taxIncl is taxable sales excluding tax whatever the mix of modes.
  const M = (m) => (months[m] = months[m] || { month: m, taxable: 0, tax: 0, taxIncl: 0, exempt: 0, interstate: 0, nonTaxable: 0,
    shipping: 0, taxRefunded: 0, refunds: 0, useTaxBase: 0, useTax: 0, orders: new Set() });
  const orderGross = byId_();
  for (const l of lines) orderGross[l.orderId] = (orderGross[l.orderId] || 0) + Number(l.lineTotalCents);
  for (const l of lines) {
    const m = M(l.month), incl = taxMode_(l.taxMode) !== "exclusive";
    const gross = orderGross[l.orderId] || 0, line = Number(l.lineTotalCents);
    const discShare = gross > 0 ? Math.round(Math.min(Number(l.discountCents) || 0, gross) * line / gross) : 0;
    const after = line - discShare;
    if (!m.orders.has(l.orderId)) {
      m.orders.add(l.orderId);
      if (gross > 0) m.shipping += Number(l.shippingCostCents) || 0;
      m.tax -= Number(l.discountTaxCents) || 0;   // tax taken off with the discount (once per order)
      if (incl) m.taxIncl -= Number(l.discountTaxCents) || 0;
    }
    if (l.taxExempt) m.exempt += after;
    else if (isOutOfState(l.shipState, settings.jurisdiction)) m.interstate += after;
    else if (!l.taxable) m.nonTaxable += after;
    else { m.taxable += after; m.tax += Number(l.taxCents); if (incl) m.taxIncl += Number(l.taxCents); }
  }
  for (const r of await getSalesTaxRefunds(db, dateFrom, dateTo)) {
    const m = M(r.month); m.taxRefunded += toCents(r.taxRefunded); m.refunds += toCents(r.refunded);
  }
  const { results: untaxed } = await db.prepare(`
    SELECT e.id, e.expenseDate, e.description, e.vendor, e.amountCents, c.name AS category
    FROM expenses e JOIN expense_categories c ON c.id = e.categoryId
    WHERE e.deletedAt IS NULL AND c.useTaxable = 1 AND e.vendorChargedTax = 0 AND e.expenseDate >= ? AND e.expenseDate <= ?
    ORDER BY e.expenseDate`).bind(dateFrom.slice(0, 10), dateTo.slice(0, 10)).all();
  const rate = Number(settings.rateBps) || 0;
  const useTaxItems = untaxed.map(e => {
    const tax = Math.sign(Number(e.amountCents)) * Math.round(Math.abs(Number(e.amountCents)) * rate / 10000);   // a refund reverses it to the cent
    const m = M(String(e.expenseDate).slice(0, 7)); m.useTaxBase += Number(e.amountCents); m.useTax += tax;
    return { id: Number(e.id), date: e.expenseDate, description: e.description, vendor: e.vendor || "", category: e.category,
      amount: fromCents(e.amountCents), useTax: fromCents(tax) };
  });
  const out = (m) => {
    const taxableNet = m.taxable - m.taxIncl;   // taxable sales excluding the tax in them
    const gross = taxableNet + m.exempt + m.interstate + m.nonTaxable;
    return { month: m.month, orders: m.orders.size, grossSales: fromCents(gross), taxableSales: fromCents(taxableNet),
      exemptSales: fromCents(m.exempt), interstateSales: fromCents(m.interstate), nonTaxableSales: fromCents(m.nonTaxable),
      taxCollected: fromCents(m.tax), taxRefunded: fromCents(m.taxRefunded), useTaxablePurchases: fromCents(m.useTaxBase),
      useTax: fromCents(m.useTax), totalDue: fromCents(m.tax - m.taxRefunded + m.useTax), shipping: fromCents(m.shipping) };
  };
  const rows = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));
  const total = rows.reduce((t, m) => { for (const k of ["taxable", "tax", "taxIncl", "exempt", "interstate", "nonTaxable", "shipping", "taxRefunded", "refunds", "useTaxBase", "useTax"]) t[k] += m[k];
    m.orders.forEach(o => t.orders.add(o)); return t; }, { month: "total", taxable: 0, tax: 0, taxIncl: 0, exempt: 0, interstate: 0, nonTaxable: 0, shipping: 0, taxRefunded: 0, refunds: 0, useTaxBase: 0, useTax: 0, orders: new Set() });
  return { months: rows.map(out), total: out(total), useTaxItems, ratePct: rate / 100, jurisdiction: settings.jurisdiction || "" };
}

// How much of a refund (or lost dispute) was shipping (migrations/0035) — between $0 and the whole
// refund. Shipping isn't taxed, so that part carries no sales tax (getSalesTaxRefunds).
export async function setRefundShipping(db, paymentId, shippingAmount) {
  const p = await db.prepare("SELECT id, orderId, amountCents, kind, voidedAt FROM order_payments WHERE id=?").bind(Number(paymentId)).first();
  if (!p) throw new Error("Payment not found");
  if (p.kind !== "refund" && p.kind !== "dispute") throw new Error("Only a refund can have a shipping part");
  if (p.voidedAt) throw new Error("That refund was voided");
  const cents = toCents(shippingAmount);
  if (!Number.isFinite(cents) || cents < 0) throw new Error("The shipping part must be $0 or more");
  if (cents > Math.abs(Number(p.amountCents))) throw new Error(`The shipping part can't be more than the $${fromCents(Math.abs(Number(p.amountCents))).toFixed(2)} refund`);
  await db.prepare("UPDATE order_payments SET shippingCents=? WHERE id=?").bind(cents, Number(paymentId)).run();
  return { orderId: p.orderId, shipping: fromCents(cents) };
}

// Refunds and lost disputes in a period (by the month the money went back),
// with the tax portion backed out at the refunded order's own rate — the
// money going back always includes its tax, whether the tax was inside the
// listed price or added to it. Dollars out.
export async function getSalesTaxRefunds(db, dateFrom, dateTo) {
  const { results } = await withTaxMode_((tm) => db.prepare(`
    SELECT substr(p.receivedAt, 1, 7) AS month, -p.amountCents AS refundCents, COALESCE(p.shippingCents, 0) AS shippingCents,
           o.taxExempt, o.taxRateBps, o.shipState, ${tm} AS taxMode,
           COALESCE((SELECT SUM(lineTotalCents) FROM order_items i WHERE i.orderId = o.orderId AND i.cancelDate IS NULL), 0) AS grossCents,
           COALESCE((SELECT SUM(lineTotalCents) FROM order_items i WHERE i.orderId = o.orderId AND i.cancelDate IS NULL AND i.taxable = 1), 0) AS taxableCents
    FROM order_payments p JOIN orders o ON o.orderId = p.orderId
    WHERE p.kind IN ('refund', 'dispute') AND p.receivedAt >= ? AND p.receivedAt <= ?
      AND p.voidedAt IS NULL AND o.isTest = 0 AND o.voidedAt IS NULL
  `).bind(dateFrom, dateTo).all());
  const { jurisdiction } = await getSalesTaxSettings(db);
  const byMonth = {};
  for (const r of results) {
    const m = (byMonth[r.month] = byMonth[r.month] || { month: r.month, refundCents: 0, taxCents: 0, count: 0 });
    const refund = Number(r.refundCents);
    // Tax only on the taxable share of an in-state, non-exempt order — and never on the refund's
    // shipping part (shipping isn't taxed; migrations/0035).
    const rate = r.taxExempt || isOutOfState(r.shipState, jurisdiction) ? 0 : Number(r.taxRateBps) || 0;
    let gross = Number(r.grossCents), taxable = Number(r.taxableCents);
    // The refund is money the customer paid. With tax on top, the taxable lines' share of that
    // money is their listed total PLUS their tax, so weigh them that way before backing it out.
    if (taxMode_(r.taxMode) === "exclusive") {
      taxable = Math.min(taxable, gross);
      const added = addTaxExclusive(taxable, rate).taxCents;
      gross += added; taxable += added;
    }
    const goods = Math.max(0, refund - Math.min(Math.max(0, Number(r.shippingCents) || 0), Math.max(0, refund)));
    const taxablePart = gross > 0 ? Math.round(goods * Math.min(taxable, gross) / gross) : goods;
    m.refundCents += refund;
    m.taxCents += splitTaxInclusive(taxablePart, rate).taxCents;
    m.count++;
  }
  return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ month: m.month, refunds: m.count, refunded: fromCents(m.refundCents), taxRefunded: fromCents(m.taxCents) }));
}

export async function insertAuditLog(db, { orgId, orderId, action, detail, actor, ip, actorUserId, targetUserId }) {
  const createdAt = new Date().toISOString();
  const detailJson = detail != null ? JSON.stringify(detail) : null;
  // Security entries also say which user did it and to which (migrations/0053).
  if (actorUserId != null || targetUserId != null) {
    await db.prepare(
      "INSERT INTO audit_log (createdAt, orgId, orderId, action, detail, actor, ip, actorUserId, targetUserId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(createdAt, orgId || null, orderId || null, action, detailJson, actor || null, ip || null, actorUserId == null ? null : actorUserId, targetUserId == null ? null : targetUserId).run();
    return;
  }
  try {
    await db.prepare(
      "INSERT INTO audit_log (createdAt, orgId, orderId, action, detail, actor, ip) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(createdAt, orgId || null, orderId || null, action, detailJson, actor || null, ip || null).run();
  } catch (e) {
    // Database not yet migrated (migrations/0004 adds actor/ip): still record
    // the event — with the actor folded into detail — rather than lose it.
    if (!/no such column|has no column named/i.test(String(e && e.message))) throw e;
    await db.prepare(
      "INSERT INTO audit_log (createdAt, orgId, orderId, action, detail) VALUES (?, ?, ?, ?, ?)"
    ).bind(createdAt, orgId || null, orderId || null, action,
      JSON.stringify({ ...(detail || {}), _actor: actor || null, _ip: ip || null })).run();
  }
}

export async function getAuditLog(db, { orgId, orderId, action, dateFrom, dateTo, limit = 20 } = {}) {
  const conditions = [];
  const params = [];
  if (orgId)    { conditions.push("orgId = ?");       params.push(orgId); }
  if (orderId)  { conditions.push("orderId = ?");     params.push(orderId); }
  if (action)   { conditions.push("action LIKE ?");   params.push("%" + action + "%"); }
  if (dateFrom) { conditions.push("createdAt >= ?");  params.push(dateFrom); }
  if (dateTo)   { conditions.push("createdAt <= ?");  params.push(dateTo + "T23:59:59.999Z"); }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const cap = Math.min(Math.max(1, Number(limit) || 20), 200);
  params.push(cap);
  const { results } = await db.prepare(
    `SELECT id, createdAt, orgId, orderId, action, detail, actor, ip, actorUserId, targetUserId FROM audit_log ${where} ORDER BY createdAt DESC LIMIT ?`
  ).bind(...params).all();
  return results.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

function tryParse_(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}
