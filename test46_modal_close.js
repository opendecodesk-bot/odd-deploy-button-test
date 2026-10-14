const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

// Pop-up windows only close from a button (✕ / Cancel / Save…) or Escape —
// a click on the dimmed background outside the box does nothing.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
(async () => {
  const adminJs = read("public/admin.js"), indexHtml = read("public/index.html");
  const backdrop = /(e|ev|event)\.target\s*===?\s*(ov|overlay|dialog|modal|backdrop)\b/;
  console.log("no click-outside-to-close handler in admin.js or index.html:", !backdrop.test(adminJs) && !backdrop.test(indexHtml));

  // Tall windows scroll inside the box, so Cancel / Close can't end up below the screen edge.
  const cssRule = (sel) => (indexHtml.match(new RegExp("\\." + sel + "\\s*\\{([^}]*)\\}")) || [])[1] || "";
  console.log("prompt boxes (.admin-pass-box, storefront .ship-addr-box) have a max height and scroll:",
    ["admin-pass-box", "ship-addr-box"].every(c => /max-height:\s*calc\(100vh/.test(cssRule(c)) && /overflow-y:\s*auto/.test(cssRule(c))));
  console.log("balance-mismatch and label-font windows scroll too:",
    /Payment doesn't cover the full balance/.test(adminJs) && /width:420px;max-width:95vw;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px rgba\(0,0,0,.5\)/.test(adminJs) &&
    /min-width:320px;max-width:95vw;max-height:90vh;overflow-y:auto/.test(adminJs));
  // Orders table: capped at the screen height (horizontal scrollbar always in view), header pinned.
  console.log("orders table is height-capped with a pinned header row:", /class="admin-table-wrap orders-table-wrap"/.test(adminJs) &&
    /max-height:\s*50vh/.test(cssRule("orders-table-wrap")) && /overflow:\s*auto/.test(cssRule("orders-table-wrap")) &&
    /\.orders-table-wrap thead th\{position:sticky; top:0/.test(indexHtml));
  console.log("orders table: Action is the first data column (shop column only prepended in All-shops mode):",
    /const ORDERS_TABLE_HEADERS_ = `<th>Action<\/th><th><input type="checkbox" id="selectAllOrders"/.test(adminJs) &&
    /data-action-td>\$\{adminActionCell\(org, o\)\}/.test(adminJs) &&
    !/<th>Tracking<\/th><th>Action<\/th>/.test(adminJs));
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(indexHtml, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }); } });
  const w = dom.window;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  const { ov } = w.inventoryModal_("Test window", `<p>body</p>`);
  ov.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  console.log("clicking the background leaves the window open:", ov.isConnected);
  ov.querySelector("[data-modal-close]").click();
  console.log("the ✕ button closes it:", !ov.isConnected);
  const m2 = w.inventoryModal_("Esc window", "").ov;
  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" }));
  console.log("Escape still closes it:", !m2.isConnected);

  // Orders → Payments: its ✕ sits inside the white box (not the screen corner) and there's a Close button.
  w.eval(`adminKey = "cookie"; window._ordersCache = { org1: [{ orderId: "ORD-1", orgId: "org1", total: 20, effectiveTotal: 20, amountReceived: 0, balanceDue: 20, payments: [], paymentMethod: "Venmo", items: [] }] }`);
  const open1 = w.showPaymentsModal("org1", "ORD-1");
  for (let i = 0; i < 50 && !w.document.getElementById("pmCloseBottom"); i++) await new Promise(res => setTimeout(res, 10));
  const inner = w.document.querySelector(".pm-inner");
  console.log("Payments window: ✕ positioned inside the box, Close button at the bottom:", !!inner && inner.style.position === "relative" &&
    inner.contains(w.document.getElementById("pmClose")) && inner.lastElementChild.contains(w.document.getElementById("pmCloseBottom")));
  inner.parentElement.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const stillOpen = !!w.document.querySelector(".pm-inner");
  w.document.getElementById("pmCloseBottom").click();
  await open1;
  console.log("…a background click leaves it open; Close closes it:", stillOpen && !w.document.querySelector(".pm-inner"));
})().catch(e => { console.log("test46 crashed:", false); console.error(e); process.exit(1); });
