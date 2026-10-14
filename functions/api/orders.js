/**
 * Order management backed by Cloudflare D1.
 *
 * All data reads and writes go directly to D1 (env.DB). Transactional
 * email is sent by functions/_lib/email.js.
 *
 * Security model:
 *   - Admin actions only work from the admin subdomain
 *   - Order submission only works from org subdomains (or root domain)
 *   - The admin passphrase / session token is validated by requireAdmin()
 *   - Prices are recalculated server-side from D1 (priceItem()), never trusted from client
 */

import { classifyHost, rootDomain } from "../_lib/hostConfig.js";
import { getCatalogData, invalidateCatalogVersionCache } from "../_lib/catalogCache.js";
import { validateOrgFields, validateProductImages, cleanImageUrl, PRODUCT_ID_RE } from "../_lib/catalogValidation.js";
import { requireAdmin, adminActor } from "../_lib/adminAuth.js";
import { checkShippedDeliveries, checkBlankShipments } from "../_lib/deliveryCheck.js";
import { ensureOrgDomain, getOrgDomainStatus } from "../_lib/customDomain.js";
import { setupStatus, setupSummary } from "../_lib/setupStatus.js";
import { rateLimited, rateLimitResponse } from "../_lib/rateLimit.js";
import { jsonResponse, featureOffResponse } from "../_lib/http.js";
import {
  getAllOrgs, getOrgById, createOrg, updateOrg, cleanDeliveryOptions, setOrgDeliveryOptions, defaultDeliveryOptions, cleanShippingAddress, stagePrereqError, getSystemIssues,
  getProductsByOrg, createProduct, updateProduct, setProductVisible,
  getGlobalSettings, setGlobalSettings, getMachineSettings, setMachineSettings,
  getShipFromAddress, setShipFromAddress, getBusinessProfile, setBusinessProfile, getLocaleSettings, setLocaleSettings, FEATURES, getFeatures, setFeatures, resolveTimeZone, setOrdersCompleted, getShippedAwaitingDelivery,
  getBoxPresets, setBoxPresets,
  addShippingPaidAmount, setShippingPaidAmount,
  getAllInventory, createInventoryItem, updateInventoryItem, deleteInventoryItem,
  getAllBlanks, createBlank, updateBlank, deleteBlank, mergeBlanks, getBlanksToOrder, importBlanksCsv, importProductsCsv, IMPORT_MAX_ROWS,
  listThreads, createThread, updateThread, deleteThread, importThreadChart,
  listSpoolSizes, saveSpoolSize, deleteSpoolSize, saveThreadInventory, deleteThreadInventory,
  listNeedleSizes, saveNeedleSize, deleteNeedleSize, listNeedleTypes, saveNeedleType, deleteNeedleType, needleTypeExists,
  listHoops, createHoop, updateHoop, deleteHoop,
  listLocations, saveLocation, deleteLocation,
  listProductGraphicImages, setProductGraphicImage, deleteProductGraphicImage, getProductLocationBaseImages,
  listGraphics, getGraphic, createGraphic, updateGraphic, setProductGraphicColorBlocked, deleteGraphic,
  getTierPrices, setTierPrices, setOrgReorderQr, setOrgReorderQrTransfer,
  listTransfers, createTransfer, updateTransfer, deleteTransfer, receiveTransferSheet, transferSheetShares, SHEET_PCT_TOLERANCE,
  writeOffTransfers, getTransferMovements, voidTransferMovement, restoreTransferMovement, getTransferMovementById, getTransferRestoreBlocker, transferMovementMonth, getTransferValuation, getTransferCogs,
  getTransferQueue, setTransferReceived, getGangSheet, makeTransferLine, setTransfersApplied, lineHasEmbroidery, refreshOrderLinesFromCatalog,
  listDesigns, getDesign, saveDesign, deleteDesign, listDesignVersions, addDesignVersion, updateDesignVersionThreads, setProductDesign,
  listProductDesigns, setProductDesigns, listOrderItemDesigns, addOrderItemDesign, getCatalogIssues,
  getOrderItemFiles, addOrderItemFile, deleteOrderItemFile,
  listMachines, getMachine, saveMachine, deleteMachine, setMachineHoop, setMachineNeedle, setMachineNeedles,
  recordMachineDiscovery, getProductionQueue, getOrdersAwaitingBlanks, getPaidUnrunOrders, markItemPieceManufactured,
  addBlankShipment, updateBlankShipment, deleteBlankShipment, getBlankShipmentsForOrder,
  listAbortReasons, createAbortReason, updateAbortReason, deleteAbortReason,
  listActiveRuns, startProductionRun, startHooping, markHoopingDone, completeProductionRun, getRunStats, RUN_ISSUE_KINDS, abortProductionRun, getRunReportByDesign,
  getBlankLinks, setBlankLink, deleteBlankLink,
  getOrdersByOrg, getOpenOrders, getOrderById, insertOrder,
  settleOrderBalance, getOrderItemById, setOrderEmailTimestamp, setRefundShipping,
  setFulfillmentStage, setTrackingNumbers,
  cancelLineItemWithReason, setLineItemRefund,
  updateOrderItem, addOrderItem, recalcOrderTotals,
  getOrderTotal, getOrderForShipping,
  updateOrderCustomerInfo,
  priceItem, CUSTOM_DESIGN_KINDS, CUSTOM_PLAIN_LOCATION, customFromConfig,
  createDesignVerification,
  getLatestVerificationsByOrg,
  updateOrderShipping,
  addOrderPayment, getOrderPaymentById, setOrderDiscount,
  getReadyToShipByOrg, upsertReadyToShipQty,
  updateOrderPlacedAt, setOrderDueDate,
  insertAuditLog, getAuditLog,
  getRevenueData,
  getSalesTaxSettings, setSalesTaxSettings, setOrgTaxExemption, getSalesTaxReport,
  getSalesTaxRefunds, PAYMENT_METHODS, methodFromPaymentMethod, getCardPaymentsMissingFees, setPaymentFee, getSalesTaxReturn, getTaxedResalePurchases, getStripeLinkedPayments, setPaymentDate,
  getDigestState, getDigestRun, getOrdersForDigest, getUnsentOwnerNotices, getFailedAdminLogins,
  ACCOUNT_TYPES, OTHER_INCOME_TYPES, listAccounts, saveAccount, getAccount, getMoneyDefaults, setMoneyDefaults,
  listMoneyEntries, getMoneyEntry, saveMoneyEntry, deleteMoneyEntry, moneyEntryMonth, getMoneySummary, setPaymentAccount,
  importStatementLines, autoMatchStatement, getStatementLine, matchStatementLine, unmatchStatementLine, setStatementLineIgnored,
  getReconciliationData, setReconciled, clearReconciled, isReconciled, saveCsvMapping, previewExpenseRows, landedCostLines, spreadCents,
  SCHEDULE_C_LINES, DEDUCTION_TYPES, DEPRECIATION_METHODS, listExpenseCategories, getExpenseCategory, findExpenseCategoryByName,
  saveExpenseCategory, deleteExpenseCategory, listExpenses, getExpense, saveExpense, deleteExpense, expenseMonth, getExpenseSummary,
  getRefundedCents, getDepositPayments, linkPaymentsToCashout, cashoutNetCents_,
  receiveBlanks, writeOffBlanks, getBlankMovements, getInventoryValuation, getCogsReport, planBlankCatchUp, applyBlankCatchUp, voidInventoryMovement, getInventoryMovementById, restoreInventoryMovement, getInventoryRestoreBlocker,
  voidOrder, voidPayment, getClosedPeriods, isMonthClosed, closePeriod, reopenPeriod, monthOf,
  orderMonth, itemOrderMonth, paymentMonth, movementMonth, getCashReport, getAccountantExport,
  bumpCatalogVersion,
  lineQty, QTY_MESSAGE, zipStates, SHIPPING_QUOTE_PENDING, byId_,
} from "../_lib/db.js";
import {
  sendOrderReceivedEmail,
  sendPaymentConfirmedEmail, sendCancellationEmail, sendShippedEmail,
  sendDesignVerificationEmail, sendShippingPaymentEmail,
} from "../_lib/email.js";
import { verifyQuote, canonicalItems } from "../_lib/quoteToken.js";
import { selectBox } from "../_lib/boxSize.js";
import { verifyTurnstile } from "../_lib/turnstile.js";

const ORDER_ID_RE = /^[A-Za-z0-9\-]{1,64}$/;
// "Quote pending" is a note for the shop, not a carrier: wherever a shipping method is printed for
// a customer (the shipped email, a shipping payment link) it reads as no method.
const shownMethod_ = (m) => (m === SHIPPING_QUOTE_PENDING ? "" : String(m || ""));
// Carrier rate quotes and labels work from US ZIP codes only (Region → country).
const NO_CARRIER_SHIPPING_MSG = "Carrier shipping (rates by ZIP) is only available when the country in Global settings → Region is US. Use Local pickup or a custom delivery option with a flat fee instead.";

const CATALOG_ADMIN_ACTIONS = new Set([
  "createOrg", "updateOrg", "listOrgsAdmin", "setupOrgDomain", "getOrgDomainStatus",
  "listProducts", "createProduct", "updateProduct", "setProductVisible", "importProducts", "importBlanks", "getBlanksToOrder",
  "getGlobalSettings", "updateGlobalSettings", "getSetupStatus", "getMachineSettings", "updateMachineSettings",
  "getShipFromAddress", "updateShipFromAddress", "getBusinessProfile", "updateBusinessProfile",
  "getLocaleSettings", "updateLocaleSettings", "getFeatures", "updateFeatures",
  "getSalesTaxSettings", "updateSalesTaxSettings",
  "getBoxPresets", "setBoxPresets",
  "getInventory", "createInventoryItem", "updateInventoryItem", "deleteInventoryItem",
  "getBlanks", "createBlank", "updateBlank", "deleteBlank", "mergeBlanks",
  "listThreads", "saveThread", "deleteThread", "importThreadChart",
  "listSpoolSizes", "saveSpoolSize", "deleteSpoolSize", "saveThreadInventory", "deleteThreadInventory",
  "getNeedleSettings", "saveNeedleSize", "deleteNeedleSize", "saveNeedleType", "deleteNeedleType",
  "listHoops", "saveHoop", "deleteHoop",
  "listLocations", "saveLocation", "deleteLocation",
  "listProductGraphicImages", "setProductGraphicImage", "deleteProductGraphicImage",
  "listDesigns", "getDesign", "saveDesign", "deleteDesign", "saveDesignVersion", "updateDesignVersionColors", "setProductDesign",
  "listProductDesigns", "setProductDesigns", "getOrderItemDesigns", "saveOrderItemDesign", "getCatalogIssues",
  "getOrderItemFiles", "saveOrderItemFile", "deleteOrderItemFile",
  "listMachines", "getMachine", "saveMachine", "deleteMachine", "setMachineHoop", "setMachineNeedle",
  "recordMachineDiscovery", "getProductionQueue", "markManufacturedOnMachine",
  "listAbortReasons", "saveAbortReason", "deleteAbortReason",
  "listActiveRuns", "startRun", "completeRun", "getRunStats", "abortRun", "markHoopingDone", "getRunReportByDesign",
  "receiveBlanks", "receiveBlankOrder", "writeOffBlanks", "getBlankMovements", "voidInventoryMovement", "restoreInventoryMovement", "getInventoryReport", "previewBlankCatchUp", "applyBlankCatchUp",
  "getBlankLinks", "setBlankLink", "deleteBlankLink",
  "getReadyToShip", "setReadyToShipQty",
  "listGraphics", "saveGraphic", "deleteGraphic", "setProductGraphicColorBlocked", "getTierPrices", "setTierPrices",
  "listTransfers", "saveTransfer", "deleteTransfer", "receiveTransferSheet", "writeOffTransfers",
  "getTransferMovements", "voidTransferMovement", "restoreTransferMovement",
  "getTransferQueue", "setTransferReceived", "getGangSheet", "makeTransferLine", "setTransfersApplied", "refreshOrderFromCatalog",
]);

// ---- Roles (functions/_lib/adminAuth.js) -------------------------------------------------------
// The LOWEST role that may use each action: staff ("Back office") < manager < admin. Every
// requireAdmin call in this file passes ACTION_ROLE[body.action], and requireAdmin treats anything
// that isn't exactly "staff" or "manager" as admin-only — so an action that is missing from these
// lists is closed to everyone but admins, and the roles test fails until someone decides.
//   admin    Global settings (every write), the audit log
//   manager  shops, domains, publishing, package sizes, the test transaction; the books: money,
//            reconciling, expense categories, closing periods, the accountant's export; and
//            READING Global settings
//   staff    everything else: orders, payments and refunds, shipping, production, inventory,
//            catalog content, equipment lists, expenses, reports, design files — plus the few
//            settings their screens read (package sizes, machine settings, the shop list)
const ADMIN_ONLY_ACTIONS = [
  "updateGlobalSettings", "updateFeatures", "updateBusinessProfile", "updateLocaleSettings", "updateSalesTaxSettings", "updateShipFromAddress",
  "updateMachineSettings", "backfillStripeFees", "getAuditLog",
];
const MANAGER_ACTIONS = [
  "createOrg", "updateOrg", "setupOrgDomain", "getOrgDomainStatus", "publish", "createTestTransaction", "getGlobalSettings", "getFeatures",
  "getBusinessProfile", "getLocaleSettings", "getSalesTaxSettings", "getShipFromAddress", "getSetupStatus", "setBoxPresets", "saveAccount",
  "saveMoneyDefaults", "listMoney", "saveMoneyEntry", "deleteMoneyEntry", "getReconciliation", "importStatement", "autoMatchStatement",
  "matchStatementLine", "unmatchStatementLine", "ignoreStatementLine", "createFromStatementLine", "reconcileMonth", "unreconcileMonth",
  "listCashoutPayments", "saveExpenseCategory", "deleteExpenseCategory", "closePeriod", "reopenPeriod", "getAccountantExport",
];
const STAFF_ACTIONS = [
  "listOrgsAdmin", "listProducts", "createProduct", "updateProduct", "setProductVisible", "importProducts", "importBlanks", "getBlanksToOrder",
  "getMachineSettings", "getBoxPresets", "getInventory", "createInventoryItem", "updateInventoryItem", "deleteInventoryItem", "getBlanks",
  "createBlank", "updateBlank", "deleteBlank", "mergeBlanks", "listThreads", "saveThread", "deleteThread", "importThreadChart", "listSpoolSizes",
  "saveSpoolSize", "deleteSpoolSize", "saveThreadInventory", "deleteThreadInventory", "getNeedleSettings", "saveNeedleSize", "deleteNeedleSize",
  "saveNeedleType", "deleteNeedleType", "listHoops", "saveHoop", "deleteHoop", "listLocations", "saveLocation", "deleteLocation",
  "listProductGraphicImages", "setProductGraphicImage", "deleteProductGraphicImage", "listDesigns", "getDesign", "saveDesign", "deleteDesign",
  "saveDesignVersion", "updateDesignVersionColors", "setProductDesign", "listProductDesigns", "setProductDesigns", "getOrderItemDesigns",
  "saveOrderItemDesign", "getCatalogIssues", "getOrderItemFiles", "saveOrderItemFile", "deleteOrderItemFile", "listMachines", "getMachine",
  "saveMachine", "deleteMachine", "setMachineHoop", "setMachineNeedle", "recordMachineDiscovery", "getProductionQueue", "markManufacturedOnMachine",
  "listAbortReasons", "saveAbortReason", "deleteAbortReason", "listActiveRuns", "startRun", "completeRun", "getRunStats", "abortRun",
  "markHoopingDone", "getRunReportByDesign", "receiveBlanks", "receiveBlankOrder", "writeOffBlanks", "getBlankMovements", "voidInventoryMovement",
  "restoreInventoryMovement", "getInventoryReport", "previewBlankCatchUp", "applyBlankCatchUp", "getBlankLinks", "setBlankLink", "deleteBlankLink",
  "getReadyToShip", "setReadyToShipQty", "listGraphics", "saveGraphic", "deleteGraphic", "setProductGraphicColorBlocked", "getTierPrices",
  "setTierPrices", "listTransfers", "saveTransfer", "deleteTransfer", "receiveTransferSheet", "writeOffTransfers", "getTransferMovements",
  "voidTransferMovement", "restoreTransferMovement", "getTransferQueue", "setTransferReceived", "getGangSheet", "makeTransferLine",
  "setTransfersApplied", "refreshOrderFromCatalog", "listOrgs", "getOrders", "getOrdersAllShops", "getOpenOrders", "getRevenueReport",
  "listAccounts", "setPaymentAccount", "listExpenseCategories", "listExpenses", "getExpenseReport", "saveExpense", "previewExpenseImport",
  "importExpenses", "deleteExpense", "getPendingCommunications", "checkDeliveries", "checkBlankShipments", "setOrderCompleted", "getSalesTaxReport",
  "markPaidManual", "resendEmail", "addPayment", "recordRefund", "setRefundShipping", "setPaymentDate", "deletePayment", "voidPayment",
  "setDiscount", "deleteOrder", "voidOrder", "updateCustomerInfo", "createLocalSale", "setFulfillmentStage", "addBlankShipment",
  "updateBlankShipment", "deleteBlankShipment", "getBlankShipments", "bulkSetFulfillmentStage", "cancelLineItem", "bulkCancelLineItems",
  "setLineItemRefund", "editOrder", "recordTracking", "bulkRecordTracking", "getOrderForShipping", "sendDesignVerification",
  "listDesignVerifications", "setShippingInfo", "setShippingPaidAmount", "createShippingPaymentLink", "updateOrderDate", "setOrderDueDate",
  "bulkSetDueDate", "listClosedPeriods",
];
const ACTION_ROLE = Object.create(null);   // no prototype: "constructor" is not an action
for (const a of STAFF_ACTIONS) ACTION_ROLE[a] = "staff";
for (const a of MANAGER_ACTIONS) ACTION_ROLE[a] = "manager";
for (const a of ADMIN_ONLY_ACTIONS) ACTION_ROLE[a] = "admin";

// ---- Features (Global settings → Features; db.js FEATURES) ---------------------------------------
// Which optional feature an admin action belongs to. An action listed here is refused (403) while
// its feature is switched off — checked in ONE place, right after the host check below, before any
// action runs. An action that isn't listed is always available. A new action for one of these
// areas must be added here; the features test fails for a catalog-admin action that is in neither this
// map nor its own "always on" list.
const FEATURE_ACTIONS = {
  production: [
    "listThreads", "saveThread", "deleteThread", "importThreadChart",
    "listSpoolSizes", "saveSpoolSize", "deleteSpoolSize", "saveThreadInventory", "deleteThreadInventory",
    "getNeedleSettings", "saveNeedleSize", "deleteNeedleSize", "saveNeedleType", "deleteNeedleType",
    "listHoops", "saveHoop", "deleteHoop",
    "listDesigns", "getDesign", "saveDesign", "deleteDesign", "saveDesignVersion", "updateDesignVersionColors",
    "setProductDesign", "listProductDesigns", "setProductDesigns", "getOrderItemDesigns", "saveOrderItemDesign",
    "listMachines", "getMachine", "saveMachine", "deleteMachine", "setMachineHoop", "setMachineNeedle", "recordMachineDiscovery",
    "getMachineSettings", "updateMachineSettings",
    "getProductionQueue", "markManufacturedOnMachine",
    "listAbortReasons", "saveAbortReason", "deleteAbortReason",
    "listActiveRuns", "startRun", "completeRun", "getRunStats", "abortRun", "markHoopingDone", "getRunReportByDesign",
  ],
  bookkeeping: [
    "listClosedPeriods", "closePeriod", "reopenPeriod", "getAccountantExport",
    "getReconciliation", "importStatement", "autoMatchStatement", "matchStatementLine", "unmatchStatementLine",
    "ignoreStatementLine", "createFromStatementLine", "reconcileMonth", "unreconcileMonth", "listCashoutPayments",
    "listAccounts", "saveAccount", "saveMoneyDefaults", "listMoney", "saveMoneyEntry", "deleteMoneyEntry", "setPaymentAccount",
    "listExpenseCategories", "saveExpenseCategory", "deleteExpenseCategory",
    "listExpenses", "saveExpense", "deleteExpense", "getExpenseReport", "previewExpenseImport", "importExpenses",
  ],
  shipping: [
    "getShipFromAddress", "updateShipFromAddress", "getBoxPresets", "setBoxPresets",
    "getOrderForShipping", "checkDeliveries", "checkBlankShipments",
  ],
  designVerification: [
    "sendDesignVerification", "listDesignVerifications",
  ],
};
const ACTION_FEATURE = {};
for (const [feature, actions] of Object.entries(FEATURE_ACTIONS)) for (const a of actions) ACTION_FEATURE[a] = feature;
const featureLabel_ = (key) => (FEATURES.find(f => f.key === key) || { label: key }).label;
const NO_SHIPPING_FEATURE_MSG = "Carrier shipping is turned off (Global settings → Features → Shipping). Use Local pickup or a custom delivery option with a flat fee instead.";

export async function onRequestPost(context) {
  const { request, env } = context;
  // Every audit row records WHO (adminActor: Access email / session label /
  // "passphrase") and from WHERE (client IP).
  const clientIp = request.headers.get("CF-Connecting-IP") || null;
  const auditEntry = (args) => ({ ...args, actor: adminActor(request), ip: clientIp });
  // Routine actions: written in context.waitUntil() so the runtime keeps the
  // D1 write alive after the response is sent. A failure is logged loudly,
  // never silently swallowed.
  const audit = (args) => context.waitUntil(insertAuditLog(env.DB, auditEntry(args))
    .catch((e) => console.error("AUDIT WRITE FAILED:", args.action, args.orderId || "", e)));
  // Destructive / history-rewriting actions: the audit row (with the full
  // before-values) is written FIRST, and the action is refused if it can't
  // be — so nothing irreversible ever happens without a record of it.
  // Closed (filed) months are locked: any action that would change a closed
  // month's numbers is refused until the month is reopened (Reports → Periods).
  const nowMonth = () => monthOf(new Date().toISOString());
  // Optional "date received" (YYYY-MM-DD) on a payment: noon UTC that day, or
  // now if it's today. Null = not given; {error} = invalid.
  const paymentDate = (b) => {
    const d = String(b.date || "").trim();
    if (!d) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d + "T00:00:00Z"))) return { error: "Date must be YYYY-MM-DD" };
    const today = new Date().toISOString().slice(0, 10);
    if (d > today) return { error: "The date can't be in the future" };
    if (d < "2020-01-01") return { error: "That date is too far back" };
    return { receivedAt: d === today ? new Date().toISOString() : d + "T12:00:00.000Z" };
  };
  const periodGuard = async (b) => {
    const months = [];
    const a = b.action;
    if (["addPayment", "recordRefund", "markPaidManual", "createLocalSale", "createTestTransaction"].includes(a)) months.push(nowMonth());
    if (["addPayment", "recordRefund", "setPaymentDate"].includes(a) && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) months.push(String(b.date).slice(0, 7));
    if (a === "setPaymentDate" && b.paymentId) months.push(await paymentMonth(env.DB, b.paymentId));
    if (a === "saveExpense" && b.expense && /^\d{4}-\d{2}-\d{2}$/.test(String(b.expense.date || ""))) months.push(String(b.expense.date).slice(0, 7));
    if (["saveExpense", "deleteExpense"].includes(a) && (b.expenseId || (b.expense && b.expense.id))) months.push(await expenseMonth(env.DB, b.expenseId || b.expense.id));
    if (["saveMoneyEntry", "deleteMoneyEntry"].includes(a) && ["income", "owner", "transfer"].includes(b.kind)) {
      if (b.entry && /^\d{4}-\d{2}-\d{2}$/.test(String(b.entry.date || ""))) months.push(String(b.entry.date).slice(0, 7));
      const id = b.id || (b.entry && b.entry.id);
      if (id) months.push(await moneyEntryMonth(env.DB, b.kind, id));
    }
    if (a === "setPaymentAccount" && b.paymentId) months.push(await paymentMonth(env.DB, b.paymentId));
    if (a === "importExpenses" && Array.isArray(b.rows)) for (const r of b.rows.slice(0, 500)) if (/^\d{4}-\d{2}-\d{2}$/.test(String(r && r.date || ""))) months.push(String(r.date).slice(0, 7));
    if (["receiveBlanks", "receiveBlankOrder"].includes(a) && /^\d{4}-\d{2}-\d{2}$/.test(String(b.receivedAt || ""))) months.push(String(b.receivedAt).slice(0, 7));
    if (a === "writeOffBlanks" && /^\d{4}-\d{2}-\d{2}$/.test(String(b.occurredAt || ""))) months.push(String(b.occurredAt).slice(0, 7));
    if (["receiveTransferSheet", "writeOffTransfers"].includes(a) && /^\d{4}-\d{2}-\d{2}$/.test(String(b.receivedAt || b.occurredAt || ""))) months.push(String(b.receivedAt || b.occurredAt).slice(0, 7));
    if (a === "createFromStatementLine" && b.lineId) { const l = await getStatementLine(env.DB, b.lineId); if (l) months.push(String(l.lineDate).slice(0, 7)); }
    if (["setDiscount", "editOrder", "setShippingInfo", "setShippingPaidAmount", "voidOrder", "deleteOrder", "updateOrderDate"].includes(a) && b.orderId) months.push(await orderMonth(env.DB, String(b.orderId)));
    if (a === "updateOrderDate" && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ""))) months.push(String(b.date).slice(0, 7));
    if (["cancelLineItem", "setLineItemRefund"].includes(a) && b.sheetRow) months.push(await itemOrderMonth(env.DB, b.sheetRow));
    if (a === "bulkCancelLineItems" && Array.isArray(b.sheetRows)) for (const id of b.sheetRows) months.push(await itemOrderMonth(env.DB, id));
    if (["voidPayment", "deletePayment", "setRefundShipping"].includes(a) && b.paymentId) months.push(await paymentMonth(env.DB, b.paymentId));
    if ((a === "voidInventoryMovement" || a === "restoreInventoryMovement") && b.movementId) months.push(await movementMonth(env.DB, b.movementId));
    if ((a === "voidTransferMovement" || a === "restoreTransferMovement") && b.movementId) months.push(await transferMovementMonth(env.DB, b.movementId));
    for (const m of [...new Set(months.filter(Boolean))]) {
      if (await isMonthClosed(env.DB, m)) {
        const label = new Date(m + "-15T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
        return jsonResponse({ status: "error", message: `${label} is closed (already filed). Reopen it under Periods & Export to change it.` }, 409);
      }
    }
    return null;
  };
  // ---- Blank orders: several blank types + R&D / personal parts ------------
  // Shared by Reconcile → Create… (dated/paid from a statement line) and
  // Blanks → Receive order (date and paid-from chosen). Blanks for resale go
  // into inventory (and COGS), an R&D / testing part becomes an expense, a
  // personal part an owner draw. Shipping & other costs are spread over the
  // blank types, R&D and personal by value (spreadCents), and each blank's
  // share over its sizes (landed cost, landedCostLines). Validates only — no
  // writes — so the caller can check the total first.
  const planBlankOrder_ = async (body) => {
    // Several blank types come as groups: [{blankId, lines}] (a single
    // {blankId, lines} still works).
    const rawGroups = Array.isArray(body.groups) ? body.groups.slice(0, 20) : [{ blankId: body.blankId, lines: body.lines }];
    const groups = rawGroups.map(g => ({ blankId: Number(g && g.blankId), given: Array.isArray(g && g.lines) ? g.lines.filter(x => Number(x.qty) > 0) : [] }))
      .filter(g => g.given.length);
    if (groups.some(g => g.given.some(x => !Number.isInteger(Number(x.qty)) || Number(x.qty) > 10000 || !(Number(x.total ?? x.unitCost) >= 0)))) {
      return { error: "Quantities must be whole numbers and costs zero or more" };
    }
    const money = (v) => Number(v || 0);
    const extraCost = money(body.extraCost), rdAmount = money(body.rdAmount), personalAmount = money(body.personalAmount);
    if (!(extraCost >= 0) || extraCost > 100000) return { error: "Shipping & other costs must be zero or more" };
    if (!(rdAmount >= 0) || rdAmount > 100000) return { error: "The R&D / testing amount must be zero or more" };
    if (!(personalAmount >= 0) || personalAmount > 100000) return { error: "The personal amount must be zero or more" };
    if (!groups.length && !rdAmount && !personalAmount) return { error: "Enter a quantity for at least one size" };
    for (const g of groups) {
      const blank = g.blankId ? await env.DB.prepare("SELECT id FROM blanks WHERE id = ?").bind(g.blankId).first() : null;
      if (!blank) return { error: "Choose a blank for every group of sizes" };
    }
    let rdCat = null;
    if (rdAmount) { rdCat = await getExpenseCategory(env.DB, Number(body.rdCategoryId)); if (!rdCat) return { error: "Choose a category for the R&D / testing part" }; }
    groups.forEach(g => { g.sizeCents = g.given.map(x => ({ color: x.color || "", size: x.size, qty: Number(x.qty),
      cents: x.total != null ? Math.round(Number(x.total) * 100) : Number(x.qty) * Math.round(Number(x.unitCost) * 100) }));
      g.cents = g.sizeCents.reduce((a, x) => a + x.cents, 0); g.qty = g.sizeCents.reduce((a, x) => a + x.qty, 0); });
    const blanksCents = groups.reduce((a, g) => a + g.cents, 0), rdCents = Math.round(rdAmount * 100), personalCents = Math.round(personalAmount * 100);
    // If everything is free, shipping goes over the blanks by quantity.
    const weights = blanksCents || rdCents || personalCents ? [...groups.map(g => g.cents), rdCents, personalCents] : [...groups.map(g => g.qty), 0, 0];
    const shares = spreadCents(weights, Math.round(extraCost * 100));
    groups.forEach((g, i) => { g.ship = shares[i]; g.lines = landedCostLines(g.sizeCents, g.ship); });
    const invCents = groups.reduce((a, g) => a + g.lines.reduce((b, x) => b + x.qty * Math.round(x.unitCost * 100), 0), 0);
    const rdTotal = rdCents + shares[groups.length], personalTotal = personalCents + shares[groups.length + 1];
    return { groups, rdCat, invCents, rdTotal, personalTotal, extraCost, mixed: !!(rdAmount || personalAmount),
      totalCents: invCents + rdTotal + personalTotal,
      vendor: String(body.vendor || "").trim().slice(0, 100), vendorRef: String(body.vendorRef || "").trim().slice(0, 100),
      vendorChargedTax: body.vendorChargedTax === true,
      // The vendor's own invoice/receipt (already uploaded via /api/receipt), attached to
      // whatever this order creates — every purchase movement, and the R&D expense if any —
      // so it can be pulled back up at tax time. Optional; blank if none was attached.
      receiptKey: String(body.receiptKey || ""), receiptName: String(body.receiptName || "").slice(0, 200) };
  };
  // Records a planned blank order; returns the money-movement keys it created
  // (for statement matching). Paid with personal funds, the personal part is
  // simply not a business transaction, so nothing is recorded for it.
  const commitBlankOrder_ = async (plan, { date, accountId, paidPersonally, fallbackName, source }) => {
    const { vendor, vendorRef } = plan;
    const what = (vendor || String(fallbackName || "Blank order")).slice(0, 200) + (vendorRef ? ` #${vendorRef}` : "");
    const keys = [], parts = {};
    for (const g of plan.groups) {
      const ids = await receiveBlanks(env.DB, { blankId: g.blankId, lines: g.lines, vendor, vendorRef,
        receivedAt: date + "T12:00:00.000Z", vendorChargedTax: plan.vendorChargedTax, accountId: paidPersonally ? null : accountId, paidPersonally,
        note: g.ship ? `Received (landed cost incl. $${(g.ship / 100).toFixed(2)} shipping & other costs)` : "Received",
        receiptKey: plan.receiptKey, receiptName: plan.receiptName });
      audit({ orgId: null, orderId: null, action: "inventory.received", detail: { blankId: g.blankId, lines: g.lines, extraCost: g.ship / 100, vendor, vendorRef, ...source } });
      ids.forEach(id => keys.push(`blanks:${id}`));
    }
    if (plan.groups.length) parts.inventory = plan.invCents / 100;
    if (plan.rdTotal) {
      const cat = plan.rdCat;
      const id = await saveExpense(env.DB, 0, { date, description: `R&D / testing — ${what}`, categoryId: cat.id, amount: plan.rdTotal / 100, vendor,
        businessUsePct: 100, receiptKey: plan.receiptKey || "", receiptName: plan.receiptName || "", placedInService: cat.deductionType === "depreciation" ? date : null,
        depMethod: cat.deductionType === "depreciation" ? "ask_cpa" : null, vendorChargedTax: true, accountId: paidPersonally ? null : accountId, paidPersonally });
      keys.push(`expense:${id}`); parts.rd = plan.rdTotal / 100;
    }
    if (plan.personalTotal && !paidPersonally) {
      const id = await saveMoneyEntry(env.DB, "owner", 0, { date, amount: plan.personalTotal / 100, kind: "draw", accountId, note: `Personal items — ${what}` });
      keys.push(`owner:${id}`); parts.personal = plan.personalTotal / 100;
    }
    return { keys, parts };
  };
  const auditStrict = async (args) => {
    try { await insertAuditLog(env.DB, auditEntry(args)); return null; }
    catch (e) {
      console.error("AUDIT WRITE FAILED (action refused):", args.action, args.orderId || "", e);
      return jsonResponse({ status: "error", message: "Could not write the audit log, so nothing was changed. Try again." }, 503);
    }
  };

  if (!env.DB) {
    return jsonResponse({ status: "error", message: "Server misconfigured — DB binding not set." }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ status: "error", message: "Invalid JSON" }, 400); }

  let catalogData;
  try { catalogData = await getCatalogData(env); }
  catch { return jsonResponse({ status: "error", message: "Catalog temporarily unavailable" }, 503); }

  const host = classifyHost(new URL(request.url).hostname, catalogData.subdomainMap, env);
  if (host.kind === "unknown") {
    return jsonResponse({ status: "error", message: "Unrecognized host" }, 404);
  }

  // Features: the switches arrive with the cached catalog (no extra read). Anything but an explicit
  // false is on, so a catalog cached before the setting existed changes nothing.
  const featureOn = (key) => (catalogData.features || {})[key] !== false;
  // THE gate: an action of a switched-off feature goes no further. Sign-in is checked first, so
  // someone who isn't an admin learns nothing about which features are on.
  if (ACTION_FEATURE[body.action] && !featureOn(ACTION_FEATURE[body.action])) {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    return featureOffResponse(ACTION_FEATURE[body.action], featureLabel_(ACTION_FEATURE[body.action]));
  }

  // ---- listOrgs — admin org picker -------------------------------------------
  if (body.action === "listOrgs") {
    const denied = await requireAdmin(env, host, body.key, request, "Not available here.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const orgs = await getAllOrgs(env.DB);
    return jsonResponse({ status: "ok", orgs: orgs.map((o) => ({ orgId: o.orgId, name: o.name, subdomain: o.subdomain || "" })) });
  }

  // ---- getOrders -------------------------------------------------------------
  if (body.action === "getOrders") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const org = body.org;
    if (!org) return jsonResponse({ status: "error", message: "Unknown org" }, 404);
    // Optional date window (the Orders page's filter) — see getOrdersByOrg.
    const orders = await getOrdersByOrg(env.DB, org, { from: body.dateFrom, to: body.dateTo });
    return jsonResponse({ status: "ok", orders });
  }

  // ---- getOrdersAllShops — the "All shops" Orders page in ONE request ----
  // Does the per-org reads (orders + design verifications) server-side in one invocation and returns
  // them merged, instead of the page firing 2×N requests. The date window + the rest of the
  // filtering stay client-side.
  if (body.action === "getOrdersAllShops") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const orgs = await getAllOrgs(env.DB);
    const range = { from: body.dateFrom, to: body.dateTo };
    const shops = await Promise.all(orgs.map(async (o) => {
      const [orders, verifications] = await Promise.all([
        getOrdersByOrg(env.DB, o.orgId, range),
        getLatestVerificationsByOrg(env.DB, o.orgId).catch(() => []),
      ]);
      return { orgId: o.orgId, name: o.name || o.orgId, orders, verifications };
    }));
    return jsonResponse({ status: "ok", shops });
  }

  // ---- getOpenOrders — admin home dashboard: every open order across all orgs ----
  if (body.action === "getOpenOrders") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const [orders, orgs] = await Promise.all([getOpenOrders(env.DB), getAllOrgs(env.DB)]);
    const names = Object.fromEntries(orgs.map(o => [o.orgId, o.name]));
    return jsonResponse({ status: "ok", orders: orders.map(o => ({ ...o, orgName: names[o.orgId] || o.orgId })) });
  }

  // ---- getAuditLog — admin fetches the audit log with optional filters --------
  if (body.action === "getAuditLog") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const entries = await getAuditLog(env.DB, {
      orgId:    body.orgId    ? String(body.orgId).trim()    : undefined,
      orderId:  body.orderId  ? String(body.orderId).trim()  : undefined,
      action:   body.filter   ? String(body.filter).trim()   : undefined,
      dateFrom: body.dateFrom ? String(body.dateFrom).trim() : undefined,
      dateTo:   body.dateTo   ? String(body.dateTo).trim()   : undefined,
      limit:    body.limit    ? Number(body.limit)           : 20,
    });
    return jsonResponse({ status: "ok", entries });
  }

  // ---- getRevenueReport — admin revenue breakdown by org for a date range ----
  if (body.action === "getRevenueReport") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;

    const dateFrom = String(body.dateFrom || "").trim();
    const dateTo   = String(body.dateTo   || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return jsonResponse({ status: "error", message: "Invalid date range — expected YYYY-MM-DD" }, 400);
    }

    // Cash basis: money actually received / returned in the period, by the
    // date it moved — what the bank and Stripe statements show.
    if (body.basis === "cash") {
      const [allOrgs, cash] = await Promise.all([
        getAllOrgs(env.DB),
        getCashReport(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z"),
      ]);
      const names = Object.fromEntries(allOrgs.map(o => [o.orgId, o.name]));
      const orgs = cash.orgs.map(o => ({ ...o, name: names[o.orgId] || o.orgId })).sort((a, b) => a.name.localeCompare(b.name));
      const sum = (arr, k) => Math.round(arr.reduce((a, r) => a + r[k] * 100, 0)) / 100;
      const money = await getMoneySummary(env.DB, dateFrom, dateTo);
      return jsonResponse({ status: "ok", basis: "cash", dateFrom, dateTo, orgs, methods: cash.methods, otherIncome: money.otherIncome,
        total: { received: sum(orgs, "received"), refunded: sum(orgs, "refunded"), fees: sum(orgs, "fees"), net: sum(orgs, "net") },
        testCardCharges: cash.testCardCharges, testCardFees: cash.testCardFees });
    }

    const [allOrgs, rows] = await Promise.all([
      getAllOrgs(env.DB),
      getRevenueData(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z"),
    ]);

    // Seed every registered org with zeroes so they always appear
    const byOrg = {};
    for (const o of allOrgs) {
      byOrg[o.orgId] = { orgId: o.orgId, name: o.name, orderCount: 0,
        subtotal: 0, discounts: 0, shipping: 0, effectiveTotal: 0, received: 0, balance: 0 };
    }

    for (const row of rows) {
      const orgId = row.orgId;
      if (!byOrg[orgId]) {
        byOrg[orgId] = { orgId, name: orgId, orderCount: 0,
          subtotal: 0, discounts: 0, shipping: 0, effectiveTotal: 0, received: 0, balance: 0 };
      }
      const entry     = byOrg[orgId];
      const items     = Number(row.itemSubtotal)  || 0;
      const discount  = Number(row.discountAmount) || 0;
      const ship      = Number(row.shippingCost) || 0;       // already 0 when nothing is left on the order
      const effective = Number(row.effectiveTotal) || 0;     // db.js orderAmounts — the one place it's worked out
      const received  = Number(row.received) || 0;
      entry.orderCount++;
      entry.subtotal      += items;
      entry.discounts     += discount;
      entry.shipping      += ship;
      entry.effectiveTotal += effective;
      entry.received      += received;
      entry.balance       += Math.max(0, effective - received);
    }

    const orgs = Object.values(byOrg).sort((a, b) => a.name.localeCompare(b.name));
    const total = orgs.reduce((acc, o) => {
      acc.orderCount    += o.orderCount;
      acc.subtotal      += o.subtotal;
      acc.discounts     += o.discounts;
      acc.shipping      += o.shipping;
      acc.effectiveTotal += o.effectiveTotal;
      acc.received      += o.received;
      acc.balance       += o.balance;
      return acc;
    }, { orderCount: 0, subtotal: 0, discounts: 0, shipping: 0, effectiveTotal: 0, received: 0, balance: 0 });

    return jsonResponse({ status: "ok", orgs, total, dateFrom, dateTo });
  }

  // ---- Closed periods (months already filed) --------------------------------
  if (["listClosedPeriods", "closePeriod", "reopenPeriod"].includes(body.action)) {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (body.action !== "listClosedPeriods") {
      const month = String(body.month || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return jsonResponse({ status: "error", message: "Month must be YYYY-MM" }, 400);
      if (body.action === "closePeriod" && month >= monthOf(new Date().toISOString())) {
        return jsonResponse({ status: "error", message: "Only a month that has ended can be closed" }, 400);
      }
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: body.action === "closePeriod" ? "period.closed" : "period.reopened", detail: { month } });
      if (auditErr) return auditErr;
      if (body.action === "closePeriod") await closePeriod(env.DB, month, adminActor(request));
      else await reopenPeriod(env.DB, month);
    }
    return jsonResponse({ status: "ok", periods: await getClosedPeriods(env.DB) });
  }

  // ---- Statement import & reconciliation (migrations/0015) --------------------
  const RECON_ACTIONS = ["getReconciliation", "importStatement", "autoMatchStatement", "matchStatementLine", "unmatchStatementLine",
    "ignoreStatementLine", "createFromStatementLine", "reconcileMonth", "unreconcileMonth", "listCashoutPayments"];
  if (RECON_ACTIONS.includes(body.action)) {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    const bad = (message) => jsonResponse({ status: "error", message }, 400);
    const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
    const ymd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !isNaN(Date.parse(v + "T00:00:00Z"));
    const recData = async (accountId, month) => jsonResponse({ status: "ok", ...(await getReconciliationData(env.DB, accountId, month)) });
    // Line-level changes are refused once that account-month is signed off.
    const lineGuard = async (lineId) => {
      const l = await getStatementLine(env.DB, lineId);
      if (!l) return { res: jsonResponse({ status: "error", message: "Statement line not found" }, 404) };
      if (await isReconciled(env.DB, l.accountId, String(l.lineDate).slice(0, 7))) return { res: bad("That month is reconciled — reopen it first") };
      return { line: l };
    };

    // Payments (Venmo, cash, check) on orders that haven't reached the bank yet — the choices for
    // Create… → Deposit on a bank-statement line. `accountId` is the statement's account: payments already
    // recorded IN it (checks) are matched to the deposit whole (`direct`); others are moved by a transfer
    // and can be deposited in parts.
    if (body.action === "listCashoutPayments") {
      const lineAcct = Number(body.accountId) || 0;
      const rows = await getDepositPayments(env.DB);
      return jsonResponse({ status: "ok", payments: rows.map(p => ({ id: p.id, orderId: p.orderId, orgId: p.orgId, customerName: p.customerName, method: p.method,
        accountId: p.accountId, accountName: p.accountName, direct: p.accountId === lineAcct,
        whole: p.accountId === lineAcct || p.method === "card",   // can't be deposited in parts: a check, or a Stripe charge (paid out whole)
        receivedAt: p.receivedAt,
        amount: p.amountCents / 100, fee: p.feeCents / 100, net: (p.amountCents - p.feeCents) / 100,
        cashedOut: p.allocatedCents / 100, remaining: p.remainingCents / 100, remainingNet: cashoutNetCents_(p, p.remainingCents) / 100 })) });
    }
    if (body.action === "getReconciliation") {
      if (!MONTH_RE.test(String(body.month || ""))) return bad("Month must be YYYY-MM");
      const acct = await getAccount(env.DB, body.accountId);
      if (!acct) return jsonResponse({ status: "error", message: "Account not found" }, 404);
      return recData(acct.id, body.month);
    }
    if (body.action === "importStatement") {
      const acct = await getAccount(env.DB, body.accountId);
      if (!acct) return jsonResponse({ status: "error", message: "Account not found" }, 404);
      const raw = Array.isArray(body.lines) ? body.lines : [];
      if (!raw.length || raw.length > 2000) return bad("Nothing to import (or more than 2,000 lines)");
      const lines = [];
      for (const l of raw) {
        const cents = Math.round(Number(l.amount) * 100);
        if (!ymd(l.date) || !Number.isFinite(cents) || cents === 0 || Math.abs(cents) > 100000000) return bad(`Couldn't read a line: ${String(l.date)} ${String(l.amount)}`);
        lines.push({ date: l.date, description: String(l.description || ""), amountCents: cents });
      }
      if (body.mapping && typeof body.mapping === "object") await saveCsvMapping(env.DB, acct.id, body.mapping);
      const batch = new Date().toISOString();
      const { inserted, duplicates } = await importStatementLines(env.DB, acct.id, lines, batch);
      let matched = 0;
      for (const m of [...new Set(lines.map(l => l.date.slice(0, 7)))]) {
        if (!(await isReconciled(env.DB, acct.id, m))) matched += await autoMatchStatement(env.DB, acct.id, m);
      }
      audit({ orgId: null, orderId: null, action: "statement.imported", detail: { account: acct.name, lines: lines.length, inserted, duplicates, matched } });
      return jsonResponse({ status: "ok", inserted, duplicates, matched });
    }
    if (body.action === "autoMatchStatement") {
      if (!MONTH_RE.test(String(body.month || ""))) return bad("Month must be YYYY-MM");
      if (await isReconciled(env.DB, body.accountId, body.month)) return bad("That month is reconciled — reopen it first");
      const matched = await autoMatchStatement(env.DB, body.accountId, body.month);
      const res = await getReconciliationData(env.DB, body.accountId, body.month);
      return jsonResponse({ status: "ok", matched, ...res });
    }
    if (["matchStatementLine", "unmatchStatementLine", "ignoreStatementLine"].includes(body.action)) {
      const g = await lineGuard(body.lineId); if (g.res) return g.res;
      if (body.action === "matchStatementLine") {
        const keys = Array.isArray(body.keys) ? body.keys.map(String).filter(k => /^[a-z_]+:\d+$/.test(k)) : [];
        if (!keys.length) return bad("Choose at least one recorded item");
        const r = await matchStatementLine(env.DB, g.line.id, keys);
        if (r.error) return bad(r.error);
      } else if (body.action === "unmatchStatementLine") {
        await unmatchStatementLine(env.DB, g.line.id);
      } else {
        const reason = body.reason === null ? null : String(body.reason || "").trim();
        if (reason !== null && !reason) return bad("Give a reason for ignoring this line");
        await unmatchStatementLine(env.DB, g.line.id);
        await setStatementLineIgnored(env.DB, g.line.id, reason);
      }
      audit({ orgId: null, orderId: null, action: "statement." + body.action.replace("StatementLine", "").toLowerCase(), detail: { lineId: g.line.id, keys: body.keys || null, reason: body.reason ?? null } });
      return recData(g.line.accountId, String(g.line.lineDate).slice(0, 7));
    }
    if (body.action === "createFromStatementLine") {
      const g = await lineGuard(body.lineId); if (g.res) return g.res;
      const l = g.line, amount = Math.abs(Number(l.amountCents)) / 100, into = Number(l.amountCents) > 0;
      // A line that's already matched (e.g. to a Stripe payout the webhook recorded) must be unmatched first — creating
      // a new entry would silently replace that match and leave the old entry counted twice.
      if ((await env.DB.prepare("SELECT count(*) AS n FROM statement_matches WHERE lineId = ?").bind(l.id).first()).n > 0) {
        return bad("This line is already matched to something — click Unmatch first if it's wrong");
      }
      const description = String(body.description || l.description || "").trim().slice(0, 300) || "Statement item";
      let key;
      if (body.kind === "expense") {
        if (into) return bad("Money came in on this line — record it as income, a contribution or a transfer");
        const cat = await getExpenseCategory(env.DB, Number(body.categoryId));
        if (!cat) return bad("Choose a category");
        const id = await saveExpense(env.DB, 0, { date: l.lineDate, description, categoryId: cat.id, amount, vendor: String(body.vendor || "").slice(0, 120),
          businessUsePct: 100, receiptKey: "", receiptName: "", placedInService: cat.deductionType === "depreciation" ? l.lineDate : null,
          depMethod: cat.deductionType === "depreciation" ? "ask_cpa" : null, vendorChargedTax: true, accountId: l.accountId, paidPersonally: false });
        key = `expense:${id}`;
      } else if (body.kind === "income") {
        if (!into) return bad("Money went out on this line — it isn't income");
        if (!OTHER_INCOME_TYPES[body.incomeType]) return bad("Choose an income type");
        const id = await saveMoneyEntry(env.DB, "income", 0, { date: l.lineDate, amount, description, type: body.incomeType, accountId: l.accountId, reference: "" });
        key = `income:${id}`;
      } else if (body.kind === "owner") {
        const id = await saveMoneyEntry(env.DB, "owner", 0, { date: l.lineDate, amount, kind: into ? "contribution" : "draw", accountId: l.accountId, note: description });
        key = `owner:${id}`;
      } else if (body.kind === "transfer") {
        const other = await getAccount(env.DB, body.otherAccountId);
        if (!other || !other.active || other.id === Number(l.accountId)) return bad("Choose the other account");
        const id = await saveMoneyEntry(env.DB, "transfer", 0, { date: l.lineDate, amount, fromAccountId: into ? other.id : Number(l.accountId),
          toAccountId: into ? Number(l.accountId) : other.id, note: description, externalRef: "" });
        key = `${into ? "transfer_in" : "transfer_out"}:${id}`;
      } else if (body.kind === "blanks") {
        // A blank order (see planBlankOrder_), dated on the line, paid from its
        // account, and every entry it records matched to the line.
        if (into) return bad("Money came in on this line — it isn't a blank purchase");
        const plan = await planBlankOrder_(body);
        if (plan.error) return bad(plan.error);
        if (plan.totalCents !== Math.abs(Number(l.amountCents))) {
          return bad(`The ${plan.mixed ? "parts" : "blanks"}${plan.extraCost ? " plus shipping & other costs" : ""} add up to $${(plan.totalCents / 100).toFixed(2)}, but the statement line is $${amount.toFixed(2)}` +
            (plan.extraCost ? "" : " — put any shipping, tax or fees on the order in \"Shipping & other costs\""));
        }
        const { keys, parts } = await commitBlankOrder_(plan, { date: l.lineDate, accountId: Number(l.accountId), paidPersonally: false,
          fallbackName: l.description, source: { fromStatementLine: l.id } });
        const r = await matchStatementLine(env.DB, l.id, keys);
        if (r.error) return bad(r.error);
        audit({ orgId: null, orderId: null, action: "statement.created_entry", detail: { lineId: l.id, kind: "blanks", keys, parts, amount } });
        return recData(l.accountId, String(l.lineDate).slice(0, 7));
      } else if (body.kind === "expense_refund") {
        // Money back for something bought (a returned item, a reversed fee): a NEGATIVE expense in
        // the ORIGINAL category, so it reduces that line of Schedule C rather than showing as income.
        if (!into) return bad("Money went out on this line — a refund is money coming back");
        const orig = body.refundOfId ? await getExpense(env.DB, Number(body.refundOfId)) : null;
        if (body.refundOfId && (!orig || orig.deletedAt || orig.isRefund)) return bad("The purchase this refunds wasn't found");
        const cat = await getExpenseCategory(env.DB, Number(body.categoryId || (orig && orig.categoryId)));
        if (!cat) return bad("Choose the category the original purchase was in");
        if (orig) {
          const already = await getRefundedCents(env.DB, orig.id);
          const origCents = Math.round(orig.amount * 100);
          if (already + Math.round(amount * 100) > origCents) {
            return bad(`That purchase was $${orig.amount.toFixed(2)}${already ? ` and $${(already / 100).toFixed(2)} is already refunded` : ""} — a $${amount.toFixed(2)} refund is more than what's left`);
          }
        }
        const text = /refund|return|credit|revers|rebate/i.test(description) ? description : "Refund: " + description;
        const id = await saveExpense(env.DB, 0, { date: l.lineDate, description: text.slice(0, 300), categoryId: cat.id, amount: -amount,
          vendor: orig ? orig.vendor : String(body.vendor || "").slice(0, 120), businessUsePct: orig ? orig.businessUsePct : 100, receiptKey: "", receiptName: "",
          placedInService: cat.deductionType === "depreciation" ? l.lineDate : null, depMethod: cat.deductionType === "depreciation" ? "ask_cpa" : null,
          vendorChargedTax: orig ? orig.vendorChargedTax : true, accountId: l.accountId, paidPersonally: false, refundOfId: orig ? orig.id : null });
        key = `expense:${id}`;
      } else if (body.kind === "deposit" || body.kind === "venmo_cashout") {
        // A bank deposit mapped to the orders' payments it covers — a Venmo cash-out, cash, checks, or a mix
        // (cash + checks on one slip). Per payment: how much of it THIS deposit covers (`allocations:
        // [{paymentId, amount}]`, dollars; plain `paymentIds` = each payment's whole remaining amount).
        //  - a payment recorded in ANOTHER account (Venmo, Cash on hand) moves by a transfer into this
        //    account, and may be deposited in parts (50% down / 50% at the end);
        //  - a payment already IN this account (checks) is matched to the line whole.
        // If the deposit is less than what's covered (Venmo's fee, cash kept, a deposit fee) the difference
        // is recorded as an expense out of the account it left — never absorbed silently.
        if (!into) return bad("Money went out on this line — a deposit is money coming in");
        const wanted = Array.isArray(body.allocations) ? body.allocations.map(a => ({ id: Number(a && a.paymentId), cents: Math.round(Number(a && a.amount) * 100) }))
          : (Array.isArray(body.paymentIds) ? body.paymentIds.map(id => ({ id: Number(id), cents: null })) : []);
        const seen = new Set();
        const asks = wanted.filter(a => Number.isInteger(a.id) && a.id > 0 && !seen.has(a.id) && seen.add(a.id)).slice(0, 200);
        if (!asks.length) return bad("Tick the payments this deposit covers");
        const pays = await getDepositPayments(env.DB, asks.map(a => a.id));
        if (pays.length !== asks.length) return bad("One or more of those payments isn't available any more (already deposited, matched, voided, or not a Venmo/cash/check payment) — reload and pick again");
        const byId = Object.fromEntries(pays.map(p => [p.id, p]));
        const lineAcct = Number(l.accountId), depositCents = Math.abs(Number(l.amountCents));
        const allocs = [];
        for (const a of asks) {
          const p = byId[a.id], direct = p.accountId === lineAcct, cents = a.cents == null ? p.remainingCents : a.cents;
          if (!Number.isFinite(cents) || cents <= 0) return bad(`Enter how much of ${p.orderId}'s ${p.method} payment this deposit covers`);
          if (direct && cents !== p.amountCents) return bad(`${p.orderId}'s ${p.method} payment is already in this account, so it's matched whole ($${(p.amountCents / 100).toFixed(2)}) — it can't be split`);
          if (p.method === "card" && cents !== p.amountCents) return bad(`${p.orderId}'s card payment is paid out by Stripe whole ($${(p.amountCents / 100).toFixed(2)}) — it can't be split across payouts`);
          if (cents > p.remainingCents) return bad(`${p.orderId}'s ${p.method} payment has only $${(p.remainingCents / 100).toFixed(2)} left to deposit (of $${(p.amountCents / 100).toFixed(2)}), not $${(cents / 100).toFixed(2)}`);
          allocs.push({ p, paymentId: p.id, amountCents: cents, direct });
        }
        // A Stripe payout is its own deposit, and if Stripe's webhook already reported this payout it's recorded
        // automatically — mapping orders on top would count the payout twice.
        const anyCard = allocs.some(a => a.p.method === "card");
        if (anyCard) {
          if (allocs.some(a => a.p.method !== "card")) return bad("A Stripe payout is its own deposit — don't mix card payments with cash, checks or Venmo");
          const dup = await env.DB.prepare(`SELECT t.transferDate FROM account_transfers t WHERE substr(t.externalRef, 1, 3) = 'po_' AND t.deletedAt IS NULL
              AND t.toAccountId = ? AND t.amountCents = ? AND abs(julianday(t.transferDate) - julianday(?)) <= 5
              AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'transfer_in' AND m.srcId = t.id) LIMIT 1`).bind(lineAcct, depositCents, l.lineDate).first();
          if (dup) return bad(`Stripe already reported this $${amount.toFixed(2)} payout (${dup.transferDate}) and it's recorded automatically — use Match… on this line instead; mapping orders too would count it twice`);
        }
        // Transfers: one per source account. Direct payments count at their full amount.
        const groups = new Map();
        let directCents = 0;
        for (const a of allocs) {
          if (a.direct) { directCents += a.amountCents; continue; }
          const g = groups.get(a.p.accountId) || { accountId: a.p.accountId, netCents: 0, allocs: [], hasVenmo: false };
          g.netCents += cashoutNetCents_(a.p, a.amountCents); g.allocs.push(a); g.hasVenmo = g.hasVenmo || a.p.method === "venmo";
          groups.set(a.p.accountId, g);
        }
        const totalCents = directCents + [...groups.values()].reduce((t, g) => t + g.netCents, 0);
        const diffCents = totalCents - depositCents;
        if (diffCents < 0) return bad(`The payments you selected come to $${(totalCents / 100).toFixed(2)} but the deposit is $${amount.toFixed(2)} — tick more`);
        let feeCat = null, feeGroup = null, feeToPayments = null;
        if (diffCents > 0) {
          if (!groups.size) return bad(`Those payments are already in this account, so the deposit has to equal them exactly — they add up to $${(totalCents / 100).toFixed(2)}, the deposit is $${amount.toFixed(2)}`);
          // The difference left the account that was cashed out: Venmo's fee comes out of Venmo; otherwise the biggest source.
          feeGroup = [...groups.values()].sort((x, y) => (y.hasVenmo - x.hasVenmo) || (y.netCents - x.netCents))[0];
          if (feeGroup.netCents - diffCents <= 0) return bad("The difference is larger than what that account is depositing — check the amounts");
          if (anyCard) {
            // Stripe's fee belongs ON the card payments (that's where Sync Stripe fees puts it, and it only fills payments still at $0, so
            // nothing is counted twice). Spread it over the ones without a fee yet; if every one already has a fee the difference is
            // something else (a refund or adjustment netted out of the payout) and is recorded as an expense.
            const zero = feeGroup.allocs.filter(a => a.p.feeCents === 0);
            if (zero.length) {
              const shares = spreadCents(zero.map(a => a.amountCents), diffCents);
              feeToPayments = zero.map((a, i) => ({ paymentId: a.paymentId, cents: shares[i], receivedAt: a.p.receivedAt })).filter(x => x.cents > 0);
              for (const f of feeToPayments) {
                if (await isMonthClosed(env.DB, monthOf(f.receivedAt))) return jsonResponse({ status: "error", message: `A payment received ${String(f.receivedAt).slice(0, 10)} is in a closed month, so its Stripe fee can't be recorded now. Reopen that month under Periods & Export first.` }, 409);
              }
            }
          }
          if (!feeToPayments) {
            feeCat = await getExpenseCategory(env.DB, Number(body.feeCategoryId));
            if (!feeCat) return bad("Choose the category for the difference (fees, cash kept, short deposit)");
          }
        }
        const orderList = [...new Set(allocs.map(a => a.p.orderId))];
        const label = (g) => g.hasVenmo && g.allocs.every(a => a.p.method === "venmo") ? "Venmo cash-out" : g.allocs.every(a => a.p.method === "cash") ? "Cash deposit" : g.allocs.every(a => a.p.method === "card") ? "Stripe payout" : "Deposit";
        const keys = [];
        const transfers = [];
        for (const g of groups.values()) {
          const cents = g.netCents - (g === feeGroup ? diffCents : 0);
          const gOrders = [...new Set(g.allocs.map(a => a.p.orderId))];
          const transferId = await saveMoneyEntry(env.DB, "transfer", 0, { date: l.lineDate, amount: cents / 100, fromAccountId: g.accountId, toAccountId: lineAcct,
            note: (label(g) + " — " + gOrders.join(", ")).slice(0, 300), externalRef: "" });
          await linkPaymentsToCashout(env.DB, g.allocs.map(a => ({ paymentId: a.paymentId, amountCents: a.amountCents })), transferId);
          keys.push(`transfer_in:${transferId}`); transfers.push({ transferId, fromAccountId: g.accountId, cents });
        }
        for (const a of allocs) if (a.direct) keys.push(`payment:${a.paymentId}`);
        let feeExpenseId = null;
        if (feeToPayments) {
          await env.DB.batch(feeToPayments.map(f => env.DB.prepare("UPDATE order_payments SET feeCents = feeCents + ? WHERE id = ? AND feeCents = 0").bind(f.cents, f.paymentId)));
        } else if (feeGroup) {
          const venmoish = feeGroup.hasVenmo;
          feeExpenseId = await saveExpense(env.DB, 0, { date: l.lineDate, categoryId: feeCat.id, amount: diffCents / 100, vendor: venmoish ? "Venmo" : (anyCard ? "Stripe" : ""),
            description: `${venmoish ? "Venmo fees — cash-out" : anyCard ? "Stripe payout difference — payout" : "Deposit shortfall — deposit"} ${l.lineDate} (${orderList.slice(0, 6).join(", ")}${orderList.length > 6 ? ", …" : ""})`.slice(0, 300),
            businessUsePct: 100, receiptKey: "", receiptName: "", placedInService: feeCat.deductionType === "depreciation" ? l.lineDate : null,
            depMethod: feeCat.deductionType === "depreciation" ? "ask_cpa" : null, vendorChargedTax: true, accountId: feeGroup.accountId, paidPersonally: false });
        }
        audit({ orgId: null, orderId: null, action: "payments.deposit_mapped", detail: { lineId: l.id, transfers, directPaymentIds: allocs.filter(a => a.direct).map(a => a.paymentId),
          allocations: allocs.map(a => ({ paymentId: a.paymentId, amountCents: a.amountCents, direct: a.direct })), orders: orderList,
          coveredCents: totalCents, depositCents, differenceCents: diffCents, feeExpenseId,
          stripeFeesRecordedOnPayments: feeToPayments ? feeToPayments.map(f => ({ paymentId: f.paymentId, cents: f.cents })) : undefined } });
        const r = await matchStatementLine(env.DB, l.id, keys);
        if (r.error) return bad(r.error);
        audit({ orgId: null, orderId: null, action: "statement.created_entry", detail: { lineId: l.id, kind: "deposit", keys, amount, orders: orderList } });
        return recData(l.accountId, String(l.lineDate).slice(0, 7));
      } else return bad("Unknown kind");
      const r = await matchStatementLine(env.DB, l.id, [key]);
      if (r.error) return bad(r.error);
      audit({ orgId: null, orderId: null, action: "statement.created_entry", detail: { lineId: l.id, kind: body.kind, key, amount, description } });
      return recData(l.accountId, String(l.lineDate).slice(0, 7));
    }
    if (body.action === "reconcileMonth" || body.action === "unreconcileMonth") {
      if (!MONTH_RE.test(String(body.month || ""))) return bad("Month must be YYYY-MM");
      const acct = await getAccount(env.DB, body.accountId);
      if (!acct) return jsonResponse({ status: "error", message: "Account not found" }, 404);
      if (body.action === "unreconcileMonth") {
        const auditErr = await auditStrict({ orgId: null, orderId: null, action: "statement.reopened", detail: { account: acct.name, month: body.month } });
        if (auditErr) return auditErr;
        await clearReconciled(env.DB, acct.id, body.month);
        return recData(acct.id, body.month);
      }
      const entered = Number(body.statementBalance);
      if (!Number.isFinite(entered)) return bad("Enter the statement's ending balance");
      // Credit card statements show what's owed as a positive balance.
      const statementCents = Math.round((acct.type === "credit_card" ? -entered : entered) * 100);
      const d = await getReconciliationData(env.DB, acct.id, body.month);
      const open = d.lines.filter(x => x.status === "unmatched" || x.status === "broken").length;
      if (open) return bad(`${open} statement line${open === 1 ? " is" : "s are"} still unmatched`);
      const diff = statementCents - Math.round(d.expectedStatementBalance * 100);
      if (diff !== 0) return bad(`The statement balance is off by ${(diff / 100).toFixed(2)} — check for missing lines or entries`);
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: "statement.reconciled", detail: { account: acct.name, month: body.month, statementBalance: entered, bookBalance: d.bookBalance } });
      if (auditErr) return auditErr;
      await setReconciled(env.DB, acct.id, body.month, statementCents, Math.round(d.bookBalance * 100), adminActor(request));
      return recData(acct.id, body.month);
    }
  }

  // ---- Accounts & money (migrations/0014) -------------------------------------
  const MONEY_ACTIONS = ["listAccounts", "saveAccount", "saveMoneyDefaults", "listMoney", "saveMoneyEntry", "deleteMoneyEntry", "setPaymentAccount"];
  if (MONEY_ACTIONS.includes(body.action)) {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    const bad = (message) => jsonResponse({ status: "error", message }, 400);
    const ymd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !isNaN(Date.parse(v + "T00:00:00Z"));
    const activeAccount = async (id) => { const a = id ? await getAccount(env.DB, id) : null; return a && a.active ? a : null; };
    const meta = async () => ({ accountTypes: ACCOUNT_TYPES, otherIncomeTypes: OTHER_INCOME_TYPES, defaults: await getMoneyDefaults(env.DB) });

    if (body.action === "listAccounts") {
      return jsonResponse({ status: "ok", accounts: await listAccounts(env.DB, ymd(body.asOf) ? body.asOf : undefined), ...(await meta()) });
    }
    if (body.action === "saveAccount") {
      const a = body.account || {};
      const id = a.id ? Number(a.id) : 0;
      const name = String(a.name || "").trim().slice(0, 60);
      if (!name) return bad("Account name is required");
      if (!ACCOUNT_TYPES[a.type]) return bad("Unknown account type");
      if (!ymd(a.openingDate)) return bad("Opening date must be YYYY-MM-DD");
      const opening = Number(a.openingBalance || 0);
      if (!Number.isFinite(opening) || Math.abs(opening) > 10000000) return bad("Opening balance must be a number");
      const all = await listAccounts(env.DB);
      if (all.some(x => x.name.toLowerCase() === name.toLowerCase() && x.id !== id)) return bad(`An account named "${name}" already exists`);
      const before = id ? all.find(x => x.id === id) : null;
      if (id && !before) return jsonResponse({ status: "error", message: "Account not found" }, 404);
      const fields = { name, type: a.type, openingBalance: opening, openingDate: a.openingDate, active: a.active !== false };
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: id ? "account.updated" : "account.created", detail: { id, from: before || null, to: fields } });
      if (auditErr) return auditErr;
      await saveAccount(env.DB, id, fields);
      return jsonResponse({ status: "ok", accounts: await listAccounts(env.DB), ...(await meta()) });
    }
    if (body.action === "saveMoneyDefaults") {
      const d = body.defaults || {};
      if (!(await activeAccount(d.postageAccountId)) || !(await activeAccount(d.payoutAccountId))) return bad("Choose active accounts");
      await setMoneyDefaults(env.DB, d);
      audit({ orgId: null, orderId: null, action: "settings.money_defaults_set", detail: d });
      return jsonResponse({ status: "ok", ...(await meta()) });
    }
    if (body.action === "listMoney") {
      const from = String(body.dateFrom || ""), to = String(body.dateTo || "");
      if (!ymd(from) || !ymd(to)) return bad("Invalid date range — expected YYYY-MM-DD");
      const [income, owner, transfers, summary] = await Promise.all([
        listMoneyEntries(env.DB, "income", from, to), listMoneyEntries(env.DB, "owner", from, to),
        listMoneyEntries(env.DB, "transfer", from, to), getMoneySummary(env.DB, from, to)]);
      return jsonResponse({ status: "ok", dateFrom: from, dateTo: to, income, owner, transfers, summary, ...(await meta()) });
    }
    if (body.action === "saveMoneyEntry" || body.action === "deleteMoneyEntry") {
      const kind = body.kind;
      if (!["income", "owner", "transfer"].includes(kind)) return bad("Unknown entry type");
      if (body.action === "deleteMoneyEntry") {
        const e = await getMoneyEntry(env.DB, kind, body.id);
        if (!e || e.deletedAt) return jsonResponse({ status: "error", message: "Not found" }, 404);
        if (e.externalRef) return bad("This Stripe payout was recorded automatically — it can't be deleted here");
        const auditErr = await auditStrict({ orgId: null, orderId: null, action: `money.${kind}_deleted`, detail: e });
        if (auditErr) return auditErr;
        await deleteMoneyEntry(env.DB, kind, e.id);
        return jsonResponse({ status: "ok" });
      }
      const x = body.entry || {};
      const id = x.id ? Number(x.id) : 0;
      if (!ymd(x.date) || x.date > new Date().toISOString().slice(0, 10)) return bad("Enter a date (not in the future)");
      const amount = Number(x.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return bad("Amount must be a positive number");
      const entry = { date: x.date, amount };
      if (kind === "income") {
        entry.description = String(x.description || "").trim().slice(0, 300);
        if (!entry.description) return bad("Description is required");
        if (!OTHER_INCOME_TYPES[x.type]) return bad("Choose an income type");
        entry.type = x.type; entry.reference = String(x.reference || "").trim().slice(0, 100);
        if (!(await activeAccount(x.accountId))) return bad("Choose the account it was paid into");
        entry.accountId = Number(x.accountId);
      } else if (kind === "owner") {
        if (!["contribution", "draw"].includes(x.kind)) return bad("Choose contribution or draw");
        if (!(await activeAccount(x.accountId))) return bad("Choose the account");
        entry.kind = x.kind; entry.accountId = Number(x.accountId); entry.note = String(x.note || "").trim().slice(0, 300);
      } else {
        if (!(await activeAccount(x.fromAccountId)) || !(await activeAccount(x.toAccountId))) return bad("Choose both accounts");
        if (Number(x.fromAccountId) === Number(x.toAccountId)) return bad("From and to must be different accounts");
        entry.fromAccountId = Number(x.fromAccountId); entry.toAccountId = Number(x.toAccountId);
        entry.note = String(x.note || "").trim().slice(0, 300); entry.externalRef = "";
      }
      const before = id ? await getMoneyEntry(env.DB, kind, id) : null;
      if (id && (!before || before.deletedAt)) return jsonResponse({ status: "error", message: "Not found" }, 404);
      if (before && before.externalRef) return bad("This Stripe payout was recorded automatically — it can't be edited here");
      if (id) {
        const auditErr = await auditStrict({ orgId: null, orderId: null, action: `money.${kind}_updated`, detail: { id, from: before, to: entry } });
        if (auditErr) return auditErr;
      }
      const savedId = await saveMoneyEntry(env.DB, kind, id, entry);
      if (!id) audit({ orgId: null, orderId: null, action: `money.${kind}_created`, detail: { id: savedId, ...entry } });
      return jsonResponse({ status: "ok", entry: await getMoneyEntry(env.DB, kind, savedId) });
    }
    if (body.action === "setPaymentAccount") {
      const p = await getOrderPaymentById(env.DB, Number(body.paymentId));
      if (!p || p.voidedAt) return jsonResponse({ status: "error", message: "Payment not found" }, 404);
      if (p.fromStripe) return bad("Stripe payments always land in the Stripe balance");
      const acct = await activeAccount(body.accountId);
      if (!acct) return bad("Choose an active account");
      const auditErr = await auditStrict({ orgId: null, orderId: p.orderId, action: "payment.account_changed", detail: { paymentId: p.id, from: p.accountId, to: acct.id } });
      if (auditErr) return auditErr;
      await setPaymentAccount(env.DB, p.id, acct.id);
      const updated = await getOrderById(env.DB, p.orderId);
      return jsonResponse({ status: "ok", payments: updated ? updated.payments : [] });
    }
  }

  // ---- Expenses (migrations/0012) — Schedule C Part II + Form 4562 facts --------
  const EXPENSE_ACTIONS = ["listExpenseCategories", "saveExpenseCategory", "deleteExpenseCategory",
    "listExpenses", "saveExpense", "deleteExpense", "getExpenseReport", "previewExpenseImport", "importExpenses"];
  if (EXPENSE_ACTIONS.includes(body.action)) {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    const bad = (message) => jsonResponse({ status: "error", message }, 400);
    const ymd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !isNaN(Date.parse(v + "T00:00:00Z"));
    const pct = (v, lo) => Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= 100;
    const meta = { scheduleCLines: SCHEDULE_C_LINES, deductionTypes: DEDUCTION_TYPES, depreciationMethods: DEPRECIATION_METHODS };

    if (body.action === "listExpenseCategories") {
      return jsonResponse({ status: "ok", categories: await listExpenseCategories(env.DB), ...meta });
    }
    if (body.action === "saveExpenseCategory") {
      const c = body.category || {};
      const id = c.id ? Number(c.id) : 0;
      const name = String(c.name || "").trim().slice(0, 80);
      if (!name) return bad("Category name is required");
      if (!DEDUCTION_TYPES.includes(c.deductionType)) return bad("Deduction type must be Depreciation, Deductible or None");
      const line = String(c.scheduleCLine || "");
      if (line && !SCHEDULE_C_LINES[line]) return bad("Unknown Schedule C line");
      const deductiblePct = c.deductionType === "none" ? 0 : (c.deductiblePct === undefined || c.deductiblePct === "" ? 100 : Number(c.deductiblePct));
      if (!pct(deductiblePct, 0)) return bad("Deductible % must be a whole number from 0 to 100");
      const clash = await findExpenseCategoryByName(env.DB, name);
      if (clash && clash !== id) return bad(`A category named "${name}" already exists`);
      const before = id ? await getExpenseCategory(env.DB, id) : null;
      if (id && !before) return jsonResponse({ status: "error", message: "Category not found" }, 404);
      const fields = { name, deductionType: c.deductionType, scheduleCLine: c.deductionType === "depreciation" ? (line || "13") : line, deductiblePct,
        useTaxable: c.useTaxable === true || c.useTaxable === 1 || c.useTaxable === "1" };
      if (id) {
        const auditErr = await auditStrict({ orgId: null, orderId: null, action: "expense_category.updated", detail: { id, from: before, to: fields } });
        if (auditErr) return auditErr;
      }
      const savedId = await saveExpenseCategory(env.DB, id, fields);
      if (!id) audit({ orgId: null, orderId: null, action: "expense_category.created", detail: { id: savedId, ...fields } });
      return jsonResponse({ status: "ok", id: savedId, categories: await listExpenseCategories(env.DB) });
    }
    if (body.action === "deleteExpenseCategory") {
      const id = Number(body.categoryId);
      const cat = id ? await getExpenseCategory(env.DB, id) : null;
      if (!cat) return jsonResponse({ status: "error", message: "Category not found" }, 404);
      if (cat.expenseCount > 0) return bad(`"${cat.name}" is used by ${cat.expenseCount} expense${cat.expenseCount === 1 ? "" : "s"} — move them to another category first`);
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: "expense_category.deleted", detail: cat });
      if (auditErr) return auditErr;
      if (!(await deleteExpenseCategory(env.DB, id))) return bad("That category is in use");
      return jsonResponse({ status: "ok", categories: await listExpenseCategories(env.DB) });
    }
    if (body.action === "listExpenses" || body.action === "getExpenseReport") {
      const from = String(body.dateFrom || ""), to = String(body.dateTo || "");
      if (!ymd(from) || !ymd(to)) return bad("Invalid date range — expected YYYY-MM-DD");
      const [expenses, summary] = await Promise.all([listExpenses(env.DB, from, to), getExpenseSummary(env.DB, from, to)]);
      return jsonResponse({ status: "ok", dateFrom: from, dateTo: to, expenses, summary, ...meta });
    }
    if (body.action === "saveExpense") {
      const x = body.expense || {};
      const id = x.id ? Number(x.id) : 0;
      const today = new Date().toISOString().slice(0, 10);
      if (!ymd(x.date)) return bad("Date must be YYYY-MM-DD");
      if (x.date > today) return bad("The date can't be in the future");
      const description = String(x.description || "").trim().slice(0, 300);
      if (!description) return bad("Description is required");
      const amount = Number(x.amount);   // as typed — always positive; a refund is stored negative
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return bad("Amount must be a positive number");
      const isRefund = x.refund === true;
      let refundOfId = null;
      if (x.refundOfId) {
        if (!isRefund) return bad("Only a refund can be linked to the purchase it refunds");
        const orig = await getExpense(env.DB, Number(x.refundOfId));
        if (!orig || orig.deletedAt || orig.isRefund) return bad("The purchase this refunds wasn't found");
        const already = await getRefundedCents(env.DB, orig.id, id);
        if (already + Math.round(amount * 100) > Math.round(orig.amount * 100)) return bad(`That purchase was $${orig.amount.toFixed(2)}${already ? ` and $${(already / 100).toFixed(2)} is already refunded` : ""} — this refund is more than what's left`);
        refundOfId = orig.id;
      }
      const cat = await getExpenseCategory(env.DB, Number(x.categoryId));
      if (!cat) return bad("Choose a category");
      const businessUsePct = x.businessUsePct === undefined || x.businessUsePct === "" ? 100 : Number(x.businessUsePct);
      if (!pct(businessUsePct, 1)) return bad("Business-use % must be a whole number from 1 to 100");
      const receiptKey = String(x.receiptKey || "");
      if (receiptKey && !/^receipts\/\d{4}\/[a-z0-9]{32}\.(jpg|png|webp|pdf)$/.test(receiptKey)) return bad("Invalid receipt reference");
      let placedInService = null, depMethod = null;
      if (cat.deductionType === "depreciation") {
        placedInService = x.placedInService ? String(x.placedInService) : x.date;
        if (!ymd(placedInService)) return bad("Placed-in-service date must be YYYY-MM-DD");
        depMethod = x.depMethod || "ask_cpa";
        if (!DEPRECIATION_METHODS[depMethod]) return bad("Unknown depreciation method");
      } else if (x.depMethod || x.placedInService) {
        return bad("Placed-in-service date and method only apply to Depreciation categories");
      }
      const paidPersonally = x.paidPersonally === true;
      let accountId = null;
      if (!paidPersonally) {
        const acct = x.accountId ? await getAccount(env.DB, x.accountId) : null;
        if (!acct || !acct.active) return bad("Choose which account paid it (or Personal funds)");
        accountId = acct.id;
      }
      const fields = { date: x.date, description, categoryId: cat.id, amount: isRefund ? -amount : amount, refundOfId, vendor: String(x.vendor || "").trim().slice(0, 120), accountId, paidPersonally,
        businessUsePct, receiptKey, receiptName: receiptKey ? String(x.receiptName || "").slice(0, 200) : "", placedInService, depMethod,
        vendorChargedTax: x.vendorChargedTax !== false };
      const before = id ? await getExpense(env.DB, id) : null;
      if (id && (!before || before.deletedAt)) return jsonResponse({ status: "error", message: "Expense not found" }, 404);
      if (id) {
        const auditErr = await auditStrict({ orgId: null, orderId: null, action: "expense.updated", detail: { id, from: before, to: fields } });
        if (auditErr) return auditErr;
      }
      const savedId = await saveExpense(env.DB, id, fields);
      if (!id) audit({ orgId: null, orderId: null, action: "expense.created", detail: { id: savedId, ...fields, category: cat.name } });
      return jsonResponse({ status: "ok", expense: await getExpense(env.DB, savedId) });
    }
    // ---- CSV import: preview (duplicates + suggested categories), then create ----
    if (body.action === "previewExpenseImport" || body.action === "importExpenses") {
      const raw = Array.isArray(body.rows) ? body.rows : [];
      if (!raw.length || raw.length > 500) return bad("Nothing to import (or more than 500 rows)");
      const today = new Date().toISOString().slice(0, 10);
      const rows = [];
      for (const [i, r] of raw.entries()) {
        const amount = Math.round(Number(r.amount) * 100) / 100;
        if (!ymd(r.date) || r.date > today) return bad(`Row ${i + 1}: date must be YYYY-MM-DD and not in the future`);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return bad(`Row ${i + 1}: amount must be a positive number`);
        rows.push({ date: r.date, description: String(r.description || "").trim().slice(0, 300), vendor: String(r.vendor || "").trim().slice(0, 120),
          amount, amountCents: Math.round(amount * 100), categoryId: Number(r.categoryId) || 0 });
      }
      if (body.action === "previewExpenseImport") return jsonResponse({ status: "ok", rows: await previewExpenseRows(env.DB, rows) });
      const paidPersonally = body.paidPersonally === true;
      let accountId = null;
      if (!paidPersonally) {
        const acct = body.accountId ? await getAccount(env.DB, body.accountId) : null;
        if (!acct || !acct.active) return bad("Choose which account paid them (or Personal funds)");
        accountId = acct.id;
        if (body.mapping && typeof body.mapping === "object") await saveCsvMapping(env.DB, acct.id, body.mapping);
      }
      const cats = new Map((await listExpenseCategories(env.DB)).map(c => [c.id, c]));
      for (const [i, r] of rows.entries()) {
        if (!r.description) return bad(`Row ${i + 1}: description is required`);
        if (!cats.has(r.categoryId)) return bad(`Row ${i + 1}: choose a category`);
      }
      const ids = [];
      for (const r of rows) {
        const cat = cats.get(r.categoryId);
        ids.push(await saveExpense(env.DB, 0, { date: r.date, description: r.description, categoryId: cat.id, amount: r.amount, vendor: r.vendor,
          businessUsePct: 100, receiptKey: "", receiptName: "", placedInService: cat.deductionType === "depreciation" ? r.date : null,
          depMethod: cat.deductionType === "depreciation" ? "ask_cpa" : null, vendorChargedTax: true, accountId, paidPersonally }));
      }
      audit({ orgId: null, orderId: null, action: "expense.imported", detail: { count: ids.length, total: Math.round(rows.reduce((a, r) => a + r.amountCents, 0)) / 100,
        paidFrom: paidPersonally ? "personal" : accountId, ids: ids.slice(0, 100) } });
      return jsonResponse({ status: "ok", imported: ids.length });
    }
    if (body.action === "deleteExpense") {
      const id = Number(body.expenseId);
      const x = id ? await getExpense(env.DB, id) : null;
      if (!x || x.deletedAt) return jsonResponse({ status: "error", message: "Expense not found" }, 404);
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: "expense.deleted", detail: x });
      if (auditErr) return auditErr;
      await deleteExpense(env.DB, id);
      return jsonResponse({ status: "ok" });
    }
  }

  // ---- getPendingCommunications — what the next 6 AM roll-up will contain ----
  // New orders and queued owner notices since the last roll-up email (the
  // same queries /api/daily-digest uses), for the admin Communications page.
  if (body.action === "getPendingCommunications") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const state = await getDigestState(env.DB);
    // Run delivery check first so newly-delivered notices are included below.
    const deliveries = await checkShippedDeliveries(env).catch(() => ({ inTransit: [], delivered: [], pickedUp: [], awaitingPickup: [] }));
    const [{ orders }, notices, orgs, security, issues, awaitingBlanks] = await Promise.all([
      getOrdersForDigest(env.DB, state), getUnsentOwnerNotices(env.DB), getAllOrgs(env.DB), getFailedAdminLogins(env.DB),
      getSystemIssues(env.DB).catch(() => null), getOrdersAwaitingBlanks(env.DB).catch(() => []),
    ]);
    const names = Object.fromEntries(orgs.map(o => [o.orgId, o.name]));
    return jsonResponse({ status: "ok", lastSentAt: (state && state.sentAt) || "", firstRun: !state, security, issues: issues || [],
      lastRun: await getDigestRun(env.DB).catch(() => null),
      awaitingBlanks: (awaitingBlanks || []).map(o => ({ ...o, orgName: names[o.orgId] || o.orgId })),
      orders: orders.map(o => ({ orderId: o.orderId, orgId: o.orgId, orgName: names[o.orgId] || o.orgId, placedAt: o.placedAt,
        customerName: o.customerName, contact: o.contact, paymentMethod: o.paymentMethod, paid: !!o.paid, total: o.total,
        items: (o.items || []).map(it => ({ name: it.name, size: it.size || "", qty: it.qty, personalized: !!it.personalized,
          persName: it.persName || "", cancelled: !!it.cancelDate })) })),
      notices: notices.map(x => ({ ...x, orgName: names[x.orgId] || x.orgId })),
      inTransit: (deliveries.inTransit || []).map(x => ({ ...x, orgName: names[x.orgId] || x.orgId })),
      pickedUp: (deliveries.pickedUp || []).map(x => ({ ...x, orgName: names[x.orgId] || x.orgId })),
      awaitingPickup: (deliveries.awaitingPickup || []).map(x => ({ ...x, orgName: names[x.orgId] || x.orgId })) });
  }

  // ---- checkDeliveries — run the roll-up's delivery check now (Communications page) ----
  // Same check as the 6 AM run: delivered orders are marked delivered and queued for the
  // next roll-up email (and shown on the Communications page).
  if (body.action === "checkDeliveries") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const rl = await rateLimited(env, "check_deliveries", request, 6);
    if (rl.blocked) return rateLimitResponse(rl.retryAfter);
    if (!env.SHIPPO_API_KEY) return jsonResponse({ status: "error", message: "Shippo isn't configured (SHIPPO_API_KEY)." }, 500);
    const r = await checkShippedDeliveries(env);
    audit({ orgId: null, orderId: null, action: "order.delivery_check_run", detail: { checked: r.checked, delivered: r.delivered.map(x => x.orderId),
      shipped: (r.pickedUp || []).map(x => x.orderId), errors: r.errors } });
    return jsonResponse({ status: "ok", ...r });
  }

  // ---- checkBlankShipments — poll the vendor (blank) shipments now (Communications page) ----
  // Same check as the 6 AM run: stores each shipment's latest carrier status + scan history, and a
  // delivered one queues an owner notice. Never auto-marks the blanks received.
  if (body.action === "checkBlankShipments") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const rl = await rateLimited(env, "check_deliveries", request, 6);
    if (rl.blocked) return rateLimitResponse(rl.retryAfter);
    if (!env.SHIPPO_API_KEY) return jsonResponse({ status: "error", message: "Shippo isn't configured (SHIPPO_API_KEY)." }, 500);
    const r = await checkBlankShipments(env);
    audit({ orgId: null, orderId: null, action: "blank.shipment_check_run",
      detail: { checked: r.checked, delivered: r.delivered.map(x => x.shipmentId), errors: r.errors } });
    return jsonResponse({ status: "ok", ...r });
  }

  // ---- setOrderCompleted — close out (or reopen) delivered, paid-in-full orders ----
  // Server re-checks every rule (delivered, paid, not voided, an active item) — the
  // browser's view of an order can be stale.
  if (body.action === "setOrderCompleted") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const ids = Array.isArray(body.orderIds) ? body.orderIds : (body.orderId ? [body.orderId] : []);
    if (!ids.length) return jsonResponse({ status: "error", message: "No orders given" }, 400);
    if (ids.length > 500) return jsonResponse({ status: "error", message: "Too many orders (max 500)" }, 400);
    if (!ids.every((id) => typeof id === "string" && ORDER_ID_RE.test(id))) return jsonResponse({ status: "error", message: "Invalid order ID in list" }, 400);
    const completed = body.completed !== false;
    const r = await setOrdersCompleted(env.DB, ids, completed);
    for (const u of r.updated) audit({ orgId: u.orgId, orderId: u.orderId, action: completed ? "order.completed" : "order.reopened", detail: null });
    return jsonResponse({ status: "ok", updated: r.updated.length, skipped: r.skipped });
  }

  // ---- getAccountantExport — raw rows for the year-end / monthly CSVs ----------
  if (body.action === "getAccountantExport") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const dateFrom = String(body.dateFrom || "").trim(), dateTo = String(body.dateTo || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return jsonResponse({ status: "error", message: "Invalid date range — expected YYYY-MM-DD" }, 400);
    }
    const data = await getAccountantExport(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z");
    audit({ orgId: null, orderId: null, action: "report.accountant_export", detail: { dateFrom, dateTo } });
    return jsonResponse({ status: "ok", dateFrom, dateTo, ...data });
  }

  // ---- getSalesTaxReport — tax collected by month / exempt / ship-to state ----
  if (body.action === "getSalesTaxReport") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const dateFrom = String(body.dateFrom || "").trim();
    const dateTo   = String(body.dateTo   || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return jsonResponse({ status: "error", message: "Invalid date range — expected YYYY-MM-DD" }, 400);
    }
    const [rows, salesTax, refunds, taxReturn] = await Promise.all([
      getSalesTaxReport(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z"),
      getSalesTaxSettings(env.DB),
      getSalesTaxRefunds(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z"),
      getSalesTaxReturn(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z"),
    ]);
    const sum = (k) => Math.round(rows.reduce((a, r) => a + r[k] * 100, 0)) / 100;
    const totals = {
      orders: rows.reduce((a, r) => a + r.orders, 0),
      grossSales: sum("grossSales"), taxCollected: sum("taxCollected"), netSales: sum("netSales"), shipping: sum("shipping"),
      exemptSales: Math.round(rows.filter(r => r.exempt).reduce((a, r) => a + r.netSales * 100, 0)) / 100,
      refunded: Math.round(refunds.reduce((a, r) => a + r.refunded * 100, 0)) / 100,
      taxRefunded: Math.round(refunds.reduce((a, r) => a + r.taxRefunded * 100, 0)) / 100,
    };
    // Tax owed for the period: collected on sales, less tax returned with
    // refunds, plus use tax on untaxed purchases.
    totals.useTax = taxReturn.total.useTax;
    totals.netTaxDue = Math.round((totals.taxCollected - totals.taxRefunded + totals.useTax) * 100) / 100;
    return jsonResponse({ status: "ok", rows, refunds, totals, taxReturn, dateFrom, dateTo,
      ratePercent: salesTax.rateBps / 100, jurisdiction: salesTax.jurisdiction, taxMode: salesTax.taxMode });
  }

  // ---- markPaidManual — admin marks an order paid + emails customer ----------
  if (body.action === "markPaidManual") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    if (!body.org || !body.orderId) return jsonResponse({ status: "error", message: "Missing org or orderId" }, 400);

    // Records the outstanding balance as a ledger payment (the ledger is the
    // source of truth for "paid"), rather than flipping a flag nothing backs up.
    const before = await getOrderById(env.DB, body.orderId);
    if (!before) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    const recorded = await settleOrderBalance(env.DB, body.orderId,
      "Marked paid manually" + (before.paymentMethod ? " (" + before.paymentMethod + ")" : ""));

    const order = await getOrderById(env.DB, body.orderId);
    const paidAt = (order && order.paidAt) || new Date().toISOString();
    if (order && order.contact) {
      const sent = await sendPaymentConfirmedEmail(env, order, paidAt);
      if (sent) await setOrderEmailTimestamp(env.DB, body.orderId, "confirmedEmailAt", new Date().toISOString());
    }
    audit({ orgId: body.org, orderId: body.orderId, action: "order.marked_paid", detail: { paidAt, amountRecorded: recorded } });
    return jsonResponse({ status: "ok" });
  }

  // ---- resendEmail -----------------------------------------------------------
  if (body.action === "resendEmail") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!body.org || !body.orderId) return jsonResponse({ status: "error", message: "Missing org or orderId" }, 400);

    const order = await getOrderById(env.DB, body.orderId);
    if (!order) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    if (!order.contact || !order.contact.includes("@")) {
      return jsonResponse({ status: "error", message: "No valid email address on file for this order" }, 400);
    }

    let resent;
    if (order.paid) {
      const sent = await sendPaymentConfirmedEmail(env, order, order.paidAt || new Date().toISOString());
      if (sent) await setOrderEmailTimestamp(env.DB, body.orderId, "confirmedEmailAt", new Date().toISOString());
      resent = "confirmed";
    } else {
      const sent = await sendOrderReceivedEmail(env, order);
      if (sent) await setOrderEmailTimestamp(env.DB, body.orderId, "receivedEmailAt", new Date().toISOString());
      resent = "received";
    }
    return jsonResponse({ status: "ok", resent });
  }

  // ---- addPayment — record an actual payment received for an order -------------
  if (body.action === "addPayment") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }

    const orderId = String(body.orderId || "").trim();
    if (!orderId || !ORDER_ID_RE.test(orderId)) {
      return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonResponse({ status: "error", message: "Amount must be a positive number" }, 400);
    }
    const note = String(body.note || "").trim().slice(0, 500);
    const before = await getOrderById(env.DB, orderId);
    if (!before) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    const method = body.method ? String(body.method).toLowerCase() : methodFromPaymentMethod(before.paymentMethod);
    if (!PAYMENT_METHODS.includes(method)) {
      return jsonResponse({ status: "error", message: "Payment method must be one of: " + PAYMENT_METHODS.join(", ") }, 400);
    }
    const reference = String(body.reference || "").trim().slice(0, 100);
    const when = paymentDate(body);
    if (when && when.error) return jsonResponse({ status: "error", message: when.error }, 400);
    let accountId;
    if (body.accountId) {
      const acct = await getAccount(env.DB, body.accountId);
      if (!acct || !acct.active) return jsonResponse({ status: "error", message: "Choose an active account" }, 400);
      accountId = acct.id;
    }
    await addOrderPayment(env.DB, orderId, amount, note, "", { method, reference, receivedAt: when ? when.receivedAt : undefined, accountId });

    // Optionally apply a discount for the remaining balance
    if (body.discountRemainder) {
      const order = await getOrderById(env.DB, orderId);
      if (order) {
        // order was re-read AFTER the payment above, so amountReceived already
        // includes it (adding `amount` again would understate the remainder).
        const newReceived = order.amountReceived;
        const remainder = Math.max(0, order.effectiveTotal - newReceived);
        if (remainder > 0.005) {
          await setOrderDiscount(env.DB, orderId, order.discountAmount + remainder,
            (order.discountNote ? order.discountNote + "; " : "") + (body.discountNote || "Balance waived"));
        }
      }
    }

    const updated = await getOrderById(env.DB, orderId);
    audit({ orgId: body.org, orderId, action: "payment.added", detail: { amount, note, method, reference, date: body.date || "" } });
    return jsonResponse({ status: "ok", orderId,
      amountReceived: updated.amountReceived, balanceDue: updated.balanceDue,
      discountAmount: updated.discountAmount, discountNote: updated.discountNote,
      effectiveTotal: updated.effectiveTotal, salesTax: updated.salesTax, payments: updated.payments });
  }

  // ---- recordRefund — money returned outside Stripe (Venmo, check, cash…) ----
  // Card refunds are recorded automatically by the Stripe webhook; recording
  // one here too would count it twice, so card is refused.
  if (body.action === "recordRefund") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    const orderId = String(body.orderId || "").trim();
    if (!orderId || !ORDER_ID_RE.test(orderId)) return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ status: "error", message: "Refund amount must be a positive number" }, 400);
    const method = String(body.method || "").toLowerCase();
    if (method === "card") {
      return jsonResponse({ status: "error", message: "Card refunds are issued in Stripe and recorded automatically — don't record them here." }, 400);
    }
    if (!PAYMENT_METHODS.includes(method)) return jsonResponse({ status: "error", message: "Choose how the refund was paid" }, 400);
    const order = await getOrderById(env.DB, orderId);
    if (!order) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    if (Math.round(amount * 100) > Math.round(order.netReceived * 100)) {
      return jsonResponse({ status: "error", message: `Refund can't exceed the $${order.netReceived.toFixed(2)} kept on this order` }, 400);
    }
    const note = String(body.note || "Refund").trim().slice(0, 500);
    const reference = String(body.reference || "").trim().slice(0, 100);
    // How much of it was shipping (migrations/0035) — untaxed, so no sales tax comes back on that part.
    const shipping = body.shippingAmount == null || body.shippingAmount === "" ? 0 : Number(body.shippingAmount);
    if (!Number.isFinite(shipping) || shipping < 0) return jsonResponse({ status: "error", message: "The shipping part must be $0 or more" }, 400);
    if (Math.round(shipping * 100) > Math.round(amount * 100)) return jsonResponse({ status: "error", message: "The shipping part can't be more than the refund" }, 400);
    const auditErr = await auditStrict({ orgId: order.orgId, orderId, action: "payment.refunded",
      detail: { amount, method, reference, note, shipping } });
    if (auditErr) return auditErr;
    const when = paymentDate(body);
    if (when && when.error) return jsonResponse({ status: "error", message: when.error }, 400);
    let accountId;
    if (body.accountId) {
      const acct = await getAccount(env.DB, body.accountId);
      if (!acct || !acct.active) return jsonResponse({ status: "error", message: "Choose an active account" }, 400);
      accountId = acct.id;
    }
    await addOrderPayment(env.DB, orderId, -amount, note, "", { method, reference, kind: "refund", receivedAt: when ? when.receivedAt : undefined, accountId,
      shippingCents: Math.round(shipping * 100) });
    const updated = await getOrderById(env.DB, orderId);
    return jsonResponse({ status: "ok", orderId, payments: updated.payments, amountReceived: updated.amountReceived,
      refundedAmount: updated.refundedAmount, netReceived: updated.netReceived, balanceDue: updated.balanceDue });
  }

  // Sets how much of an existing refund was shipping (migrations/0035) — e.g. a card refund made in
  // Stripe, which arrives through the webhook as all goods. Audited first; closed months refuse it.
  if (body.action === "setRefundShipping") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    const paymentId = Number(body.paymentId);
    if (!paymentId) return jsonResponse({ status: "error", message: "paymentId required" }, 400);
    const before = await env.DB.prepare("SELECT orderId, amountCents, shippingCents FROM order_payments WHERE id=?").bind(paymentId).first();
    if (!before) return jsonResponse({ status: "error", message: "Payment not found" }, 404);
    const order = await getOrderById(env.DB, before.orderId);
    const auditErr = await auditStrict({ orgId: order ? order.orgId : null, orderId: before.orderId, action: "payment.refund_shipping_set",
      detail: { paymentId, refund: -Number(before.amountCents) / 100, shippingFrom: Number(before.shippingCents || 0) / 100, shippingTo: Number(body.shippingAmount) || 0 } });
    if (auditErr) return auditErr;
    try { await setRefundShipping(env.DB, paymentId, Number(body.shippingAmount) || 0); }
    catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
    const updated = await getOrderById(env.DB, before.orderId);
    return jsonResponse({ status: "ok", orderId: before.orderId, payments: updated.payments, amountReceived: updated.amountReceived,
      refundedAmount: updated.refundedAmount, netReceived: updated.netReceived, balanceDue: updated.balanceDue });
  }

  // ---- backfillStripeFees — one-time: record Stripe's fee on past card payments
  // Finds each order's PaymentIntent (from its Checkout Session), reads the
  // charge's balance transaction, and stores the fee + PaymentIntent id.
  // Idempotent: only touches card payments whose fee is still 0.
  if (body.action === "backfillStripeFees") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!env.STRIPE_SECRET_KEY) return jsonResponse({ status: "error", message: "Stripe not configured" }, 500);
    const stripeGet = async (path) => {
      const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
      return r.json();
    };
    const missing = await getCardPaymentsMissingFees(env.DB);
    // Paid Checkout Sessions per order (metadata.orderId), with the amount
    // each collected. An order can have several (the order, then a separate
    // shipping payment), so a ledger entry is matched on order AND amount.
    const sessionsByOrder = byId_();
    let startingAfter = "";
    for (let page = 0; page < 10 && missing.some(p => !p.externalRef); page++) {
      const list = await stripeGet("checkout/sessions?limit=100" + (startingAfter ? "&starting_after=" + startingAfter : ""));
      for (const cs of (list.data || [])) {
        const oid = cs.metadata && cs.metadata.orderId;
        const pi = typeof cs.payment_intent === "string" ? cs.payment_intent : (cs.payment_intent && cs.payment_intent.id);
        if (oid && pi && cs.payment_status === "paid") (sessionsByOrder[oid] = sessionsByOrder[oid] || []).push({ pi, amount: cs.amount_total });
      }
      if (!list.has_more || !list.data || !list.data.length) break;
      startingAfter = list.data[list.data.length - 1].id;
    }
    // PaymentIntents already linked to a ledger entry can't be claimed again
    // (externalRef is UNIQUE).
    const { results: linked } = await env.DB.prepare("SELECT externalRef FROM order_payments WHERE externalRef LIKE 'pi_%'").all();
    const taken = new Set(linked.map(r => r.externalRef));
    let updated = 0; const notFound = []; const results = [];
    for (const p of missing) {
      try {
        let pi = (p.externalRef && p.externalRef.startsWith("pi_")) ? p.externalRef : "";
        if (!pi) {
          const cents = Math.round(p.amount * 100);
          const match = (sessionsByOrder[p.orderId] || []).find(s => s.amount === cents && !taken.has(s.pi));
          pi = match ? match.pi : "";
        }
        if (!pi) { notFound.push(p.orderId); continue; }
        const intent = await stripeGet("payment_intents/" + encodeURIComponent(pi) + "?expand[]=latest_charge.balance_transaction");
        const bt = intent && intent.latest_charge && intent.latest_charge.balance_transaction;
        if (!bt || typeof bt.fee !== "number") { notFound.push(p.orderId); continue; }
        await setPaymentFee(env.DB, p.id, bt.fee, pi);
        taken.add(pi);
        results.push({ orderId: p.orderId, fee: bt.fee / 100 });
        updated++;
      } catch (e) {
        console.error("backfillStripeFees: payment", p.id, "failed:", e);
        notFound.push(p.orderId);
      }
    }
    // Dates: a Stripe-linked payment is dated when Stripe charged the card
    // (entries imported or recorded late carry the day they were typed in).
    const redated = [];
    for (const p of await getStripeLinkedPayments(env.DB)) {
      try {
        const intent = await stripeGet("payment_intents/" + encodeURIComponent(p.externalRef));
        const created = intent && intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge.created : intent && intent.created;
        if (typeof created !== "number") continue;
        const at = new Date(created * 1000).toISOString();
        if (Math.abs(Date.parse(at) - Date.parse(p.receivedAt)) < 60000) continue;
        if (await isMonthClosed(env.DB, monthOf(p.receivedAt)) || await isMonthClosed(env.DB, monthOf(at))) { notFound.push(p.orderId + " (closed month)"); continue; }
        await setPaymentDate(env.DB, p.id, at);
        redated.push({ orderId: p.orderId, from: p.receivedAt, to: at });
      } catch (e) {
        console.error("Stripe date sync: payment", p.id, "failed:", e);
      }
    }
    audit({ orgId: null, orderId: null, action: "payments.stripe_fees_backfilled", detail: { updated, notFound, results, redated } });
    return jsonResponse({ status: "ok", updated, notFound, results, redated: redated.length });
  }

  // ---- setPaymentDate — correct when a (non-Stripe) entry's money arrived ------
  if (body.action === "setPaymentDate") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    const paymentId = Number(body.paymentId);
    if (!paymentId || !Number.isInteger(paymentId)) return jsonResponse({ status: "error", message: "Invalid payment ID" }, 400);
    const when = paymentDate(body);
    if (!when) return jsonResponse({ status: "error", message: "Missing date" }, 400);
    if (when.error) return jsonResponse({ status: "error", message: when.error }, 400);
    const payment = await getOrderPaymentById(env.DB, paymentId);
    if (!payment) return jsonResponse({ status: "error", message: "Payment not found" }, 404);
    if (payment.voidedAt) return jsonResponse({ status: "error", message: "That entry is voided" }, 400);
    if (payment.fromStripe) {
      return jsonResponse({ status: "error", message: "Stripe payments take their date from Stripe — use Global Settings → Sync Stripe fees & dates." }, 400);
    }
    const auditErr = await auditStrict({ orgId: body.org || null, orderId: payment.orderId, action: "payment.date_changed",
      detail: { paymentId, amount: payment.amount, method: payment.method, from: payment.receivedAt, to: when.receivedAt } });
    if (auditErr) return auditErr;
    await setPaymentDate(env.DB, paymentId, when.receivedAt);
    const updated = await getOrderById(env.DB, payment.orderId);
    return jsonResponse({ status: "ok", payments: updated ? updated.payments : [],
      amountReceived: updated ? updated.amountReceived : null, balanceDue: updated ? updated.balanceDue : null });
  }

  // ---- deletePayment — remove a specific payment record ----------------------
  // Mistaken ledger entries are VOIDED (kept, excluded from totals) — never
  // deleted. "deletePayment" is kept as the action name the admin UI uses.
  if (body.action === "deletePayment" || body.action === "voidPayment") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }

    const paymentId = Number(body.paymentId);
    if (!paymentId || !Number.isInteger(paymentId)) {
      return jsonResponse({ status: "error", message: "Invalid payment ID" }, 400);
    }
    const payment = await getOrderPaymentById(env.DB, paymentId);
    if (!payment) return jsonResponse({ status: "error", message: "Payment not found" }, 404);
    if (payment.voidedAt) return jsonResponse({ status: "error", message: "That entry is already voided" }, 400);
    // A Stripe card payment/refund really happened — undo it in Stripe (a
    // refund), which the webhook records; voiding it here would falsify the books.
    if (payment.method === "card" && payment.externalRef) {
      return jsonResponse({ status: "error", message: "This is a real Stripe transaction — refund it in Stripe instead; the refund will appear here automatically." }, 400);
    }
    const reason = String(body.reason || "Entered by mistake").trim().slice(0, 300);
    const auditErr = await auditStrict({ orgId: body.org, orderId: payment.orderId, action: "payment.voided",
      detail: { paymentId, amount: payment.amount, kind: payment.kind, method: payment.method, reference: payment.reference,
        note: payment.note, receivedAt: payment.receivedAt, reason } });
    if (auditErr) return auditErr;
    await voidPayment(env.DB, paymentId, reason);
    const orderId = payment.orderId;
    const updated = orderId ? await getOrderById(env.DB, orderId) : null;
    return jsonResponse({ status: "ok",
      amountReceived: updated ? updated.amountReceived : null,
      balanceDue: updated ? updated.balanceDue : null,
      payments: updated ? updated.payments : [] });
  }

  // ---- setDiscount — apply or clear a discount on an order -------------------
  if (body.action === "setDiscount") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }

    const orderId = String(body.orderId || "").trim();
    if (!orderId || !ORDER_ID_RE.test(orderId)) {
      return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return jsonResponse({ status: "error", message: "Discount amount must be zero or positive" }, 400);
    }
    const note = String(body.note || "").trim().slice(0, 500);
    const before = await getOrderById(env.DB, orderId);
    if (!before) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    const auditErr = await auditStrict({ orgId: before.orgId, orderId, action: "order.discount_set",
      detail: { from: { amount: before.discountAmount, note: before.discountNote }, to: { amount, note } } });
    if (auditErr) return auditErr;
    await setOrderDiscount(env.DB, orderId, amount, note);
    const updated = await getOrderById(env.DB, orderId);
    return jsonResponse({ status: "ok", orderId,
      discountAmount: updated.discountAmount, discountNote: updated.discountNote,
      effectiveTotal: updated.effectiveTotal, balanceDue: updated.balanceDue });
  }

  // ---- voidOrder / deleteOrder ------------------------------------------------
  // Orders are VOIDED (kept on record, excluded from every report) — never
  // deleted. "deleteOrder" is kept as the action name the admin UI uses.
  if (body.action === "deleteOrder" || body.action === "voidOrder") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }

    const orderId = String(body.orderId || "").trim();
    if (!orderId || !ORDER_ID_RE.test(orderId)) {
      return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);
    }
    const existing = await getOrderById(env.DB, orderId);
    if (!existing) return jsonResponse({ status: "error", message: "Order not found" }, 404);

    if (existing.voidedAt) return jsonResponse({ status: "error", message: "Order is already voided" }, 400);
    // Voiding doesn't return money. If the customer paid, record the refund
    // first (or refund in Stripe) so the books show the money going back.
    if (Math.round(existing.netReceived * 100) > 0) {
      return jsonResponse({ status: "error", message: `$${existing.netReceived.toFixed(2)} was received on this order. If that payment was entered by mistake, open 💰 Payments and click Void on it, then void the order. If the customer really paid, record the refund (or refund it in Stripe) first.` }, 400);
    }
    const orgId = existing.orgId;
    const reason = String(body.reason || "").trim().slice(0, 300) || "Voided by admin";
    const snapshot = { customerName: existing.customerName, contact: existing.contact,
      total: existing.total, subtotal: existing.subtotal, shippingCost: existing.shippingCost,
      discountAmount: existing.discountAmount, paymentMethod: existing.paymentMethod,
      placedAt: existing.placedAt, paid: existing.paid, paidAt: existing.paidAt, reason,
      items: existing.items, payments: existing.payments };
    const auditErr = await auditStrict({ orgId, orderId, action: "order.voided", detail: snapshot });
    if (auditErr) return auditErr;
    await voidOrder(env.DB, orderId, reason);
    return jsonResponse({ status: "ok", orderId, voided: true });
  }

  // ---- updateCustomerInfo — admin edits name/email/phone/address on orders ---
  if (body.action === "updateCustomerInfo") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;

    if (!body.org) return jsonResponse({ status: "error", message: "Missing org" }, 400);
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.filter(id => ORDER_ID_RE.test(id)) : [];
    if (!orderIds.length) return jsonResponse({ status: "error", message: "No valid order IDs" }, 400);

    // Only apply fields that were explicitly supplied (null = clear, undefined = skip).
    const updates = {};
    if (body.customerName !== undefined) updates.customerName = body.customerName === null ? "" : String(body.customerName).slice(0, 200);
    if (body.contact      !== undefined) updates.contact      = body.contact      === null ? "" : String(body.contact).slice(0, 200);
    if (body.phone        !== undefined) updates.phone        = body.phone        === null ? "" : String(body.phone).slice(0, 50);
    if (body.addressLine  !== undefined) updates.addressLine  = body.addressLine  === null ? "" : String(body.addressLine).slice(0, 300);

    if (!Object.keys(updates).length) return jsonResponse({ status: "error", message: "No fields to update" }, 400);

    for (const orderId of orderIds) {
      await updateOrderCustomerInfo(env.DB, orderId, updates);
    }
    audit({ orgId: body.org, orderId: orderIds.length === 1 ? orderIds[0] : null,
      action: "order.customer_updated", detail: { orderIds, fields: Object.keys(updates) } });
    return jsonResponse({ status: "ok", updated: orderIds.length });
  }

  // ---- createLocalSale — admin records an in-person / local sale -------------
  if (body.action === "createLocalSale") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }

    const org = body.org;
    if (!org) return jsonResponse({ status: "error", message: "Missing org" }, 400);
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 20) {
      return jsonResponse({ status: "error", message: "Invalid items" }, 400);
    }

    let pricedItems;
    let subtotal = 0;
    try {
      pricedItems = await Promise.all(
        body.items.map(async (it) => {
          const qty = Math.max(1, Math.min(50, Math.round(Number(it.qty) || 1)));
          // Admin may supply a custom unit price to override the catalog price.
          const rawCustom = it.customUnitPrice !== undefined ? parseFloat(it.customUnitPrice) : NaN;
          const hasCustom = !isNaN(rawCustom) && rawCustom >= 0;
          const isCustomItem = it.productId === "__custom__";
          if (isCustomItem && !hasCustom) {
            throw Object.assign(new Error("Custom items require a unit price."), { userFacing: true });
          }
          if (isCustomItem && !String(it.name || "").trim()) {
            throw Object.assign(new Error("Custom items require a description."), { userFacing: true });
          }
          let unitPrice, personalizationFee, lineConfig;
          if (hasCustom) {
            // For catalog products: validate the product exists but ignore its price.
            // For __custom__ items: no catalog lookup needed.
            if (!isCustomItem) await priceItem(env.DB, org, it.productId, it.size, qty, false);
            unitPrice = rawCustom;
            personalizationFee = 0;
          } else {
            const priced = await priceItem(env.DB, org, it.productId, it.size, qty, !!it.personalized, it.config);
            ({ unitPrice, personalizationFee } = priced);
            lineConfig = priced.config;
          }
          const lineTotal = (unitPrice + personalizationFee) * qty;
          subtotal += lineTotal;
          return {
            productId: it.productId, name: it.name, type: it.type, size: it.size || "",
            qty, unitPrice, personalized: hasCustom ? false : !!it.personalized,
            persName: String(it.persName || "").slice(0, 200),
            personalizationFee, lineTotal,
            ...(lineConfig ? { config: lineConfig } : {}),
            // Custom lines choose their own taxability; catalog lines use the product's.
            ...(isCustomItem ? { taxable: it.taxable !== false } : {}),
          };
        })
      );
    } catch (e) {
      if (!e || !e.userFacing) console.error("Local sale pricing failed:", e);
      return jsonResponse({ status: "error", message: e && e.userFacing ? e.message : "Couldn't price these items — try again." }, 400);
    }

    const orgPrefix = org.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() || "ORD";
    const randHex = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const orderId = orgPrefix + "-" + Date.now().toString(36).toUpperCase() + "-" + randHex;

    const now = new Date().toISOString();
    const providedDate = body.placedAt ? String(body.placedAt).trim() : null;
    const placedAt = (providedDate && /^\d{4}-\d{2}-\d{2}$/.test(providedDate))
      ? new Date(providedDate + "T12:00:00Z").toISOString()
      : now;
    const order = {
      orderId,
      orgId: org,
      customerName: String(body.customerName || "Local Sale").slice(0, 200),
      contact:       String(body.contact       || "").slice(0, 200),
      paymentMethod: String(body.paymentMethod || "").slice(0, 50),
      subtotal, shippingCost: 0, total: subtotal,
      shippingMethod: "", shippingAddress: null, totalWeightOz: 0,
      placedAt,
    };
    if (body.shippingAddress && typeof body.shippingAddress === "object") {
      // Same whitelist + state-vs-ZIP check as storefront orders (the state decides sales tax).
      const ac = cleanShippingAddress(body.shippingAddress, (await getLocaleSettings(env.DB)).country);
      if (ac.error) return jsonResponse({ status: "error", message: ac.error }, 400);
      order.shippingAddress = ac.address;
    }

    await insertOrder(env.DB, order, pricedItems);

    if (body.paid)      await settleOrderBalance(env.DB, orderId,
                          "Local sale" + (order.paymentMethod ? " (" + order.paymentMethod + ")" : ""));
    if (body.delivered) await setFulfillmentStage(env.DB, orderId, "delivered");

    audit({ orgId: org, orderId, action: "order.created_local_sale",
      detail: { customerName: order.customerName, total: subtotal, paid: !!body.paid, items: pricedItems.length } });
    return jsonResponse({ status: "ok", orderId });
  }

  // ---- createTestTransaction -------------------------------------------------
  if (body.action === "createTestTransaction") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    const org = body.org;
    if (!org) return jsonResponse({ status: "error", message: "Missing org" }, 400);
    const amount = Number(body.amount);
    if (!amount || !isFinite(amount) || amount < 0.50 || amount > 500) {
      return jsonResponse({ status: "error", message: "Amount must be between $0.50 and $500" }, 400);
    }

    // The clock alone isn't an id: two test transactions in the same millisecond would collide.
    const orderId = "TEST-" + Date.now().toString(36).toUpperCase() + "-" + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase();
    const now = new Date().toISOString();

    await insertOrder(env.DB, {
      orderId, orgId: org, isTest: true,
      taxMode: "inclusive",   // charge exactly the amount typed, whatever the store's tax mode
      customerName: "Admin Test Transaction",
      contact: "", paymentMethod: "Card",
      subtotal: amount, shippingCost: 0, total: amount,
      shippingMethod: "", shippingAddress: null,
      totalWeightOz: 0, placedAt: now,
    }, [{
      productId: "test", name: "Test Transaction", type: "test", size: "", qty: 1,
      unitPrice: amount, personalized: false, persName: "",
      personalizationFee: 0, lineTotal: amount,
    }]);

    if (!env.STRIPE_SECRET_KEY) {
      return jsonResponse({ status: "error", message: "Stripe not configured." }, 500);
    }
    const origin = new URL(request.url).origin;
    const successUrl = origin + "/?stripe=success&orderId=" + encodeURIComponent(orderId) + "&org=" + encodeURIComponent(org);
    const cancelUrl = origin + "/?stripe=cancel&org=" + encodeURIComponent(org);
    const params = new URLSearchParams({
      "payment_method_types[]": "card", mode: "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
      "line_items[0][price_data][product_data][name]": "Admin Test Transaction",
      "line_items[0][quantity]": "1",
      "metadata[orderId]": orderId, "metadata[orgId]": org,
      "payment_intent_data[metadata][orderId]": orderId,
      "payment_intent_data[metadata][orgId]": org,
      success_url: successUrl, cancel_url: cancelUrl,
    });
    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const session = await stripeRes.json();
    if (!session.url) {
      return jsonResponse({ status: "error", message: "Could not create Stripe session: " + ((session.error && session.error.message) || "unknown") }, 500);
    }
    return jsonResponse({ status: "ok", checkoutUrl: session.url });
  }

  // ---- setFulfillmentStage ---------------------------------------------------
  // The customer's "your order has shipped" email — once, when an order goes from not shipped to
  // shipped (the admin marking it here, or the daily tracking check seeing a carrier scan). Skipped
  // for test/voided orders and for pickups (no ship-to address and no tracking). After the response.
  const sendShippedEmailLater_ = (orderId) => context.waitUntil((async () => {
    if (!featureOn("shipping")) return;   // the shipped email belongs to the Shipping feature
    const o = await getOrderById(env.DB, orderId);
    if (!o || o.isTest || o.voidedAt) return;
    const label = (o.labels || []).filter(l => !l.voidedAt).slice(-1)[0];
    const tracking = String(o.trackingNumber || (label && label.trackingNumber) || "").trim();
    if (!tracking && !o.shippingAddress) return; // a pickup, not a shipment
    await sendShippedEmail(env, o, { carrier: (label && label.carrier) || shownMethod_(o.shippingMethod), tracking, shippedAt: o.shippedAt });
  })().catch((e) => console.error("Shipped email failed for", orderId, e)));

  if (body.action === "setFulfillmentStage") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!body.org || !body.orderId || !body.stage) {
      return jsonResponse({ status: "error", message: "Missing org, orderId, or stage" }, 400);
    }
    if (body.stage === "designApproved" && !featureOn("designVerification")) return featureOffResponse("designVerification", featureLabel_("designVerification"));
    // Stage order is enforced here, not just in the browser (stagePrereqError mirrors FULFILLMENT_STAGES).
    const why = stagePrereqError(await getOrderById(env.DB, String(body.orderId)), body.stage);
    if (why) return jsonResponse({ status: "error", message: `Can't mark ${body.stage}: ${why}.` }, 409);
    // Which line items a per-item blank stage applies to (migrations/0039); absent = all active lines.
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(Number).filter(Boolean) : undefined;
    const extras =
      body.stage === "blankOrdered"
        ? { vendor: body.vendor || "", vendorOrderId: body.vendorOrderId || "", estimatedDelivery: body.estimatedDelivery || "", itemIds }
      : body.stage === "blankShipped"
        ? { shippedAt: body.shippedAt || "", itemIds }
      : body.stage === "blankReceived"
        ? { blankCondition: body.condition || "Good", itemConditions: body.itemConditions || [], itemIds }
      : body.stage === "shipped"
        ? { trackingNumber: body.trackingNumber || "" }
        : {};
    const now = new Date().toISOString();
    const res = await setFulfillmentStage(env.DB, body.orderId, body.stage, extras);
    if (body.stage === "shipped" && res && res.changed) sendShippedEmailLater_(body.orderId);
    audit({ orgId: body.org, orderId: body.orderId, action: "order.fulfillment_stage",
      detail: { stage: body.stage, ...extras } });
    return jsonResponse({ status: "ok", timestamp: now });
  }

  // ---- Blank shipments (migrations/0039): multiple tracking numbers per blank order ----------
  if (body.action === "addBlankShipment") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(Number).filter(Boolean) : [];
    if (!itemIds.length) return jsonResponse({ status: "error", message: "Pick at least one line item" }, 400);
    try {
      const id = await addBlankShipment(env.DB, { carrier: body.carrier, trackingNumber: body.trackingNumber, vendor: body.vendor, shippedAt: body.shippedAt, itemIds });
      audit({ orgId: body.org || null, orderId: body.orderId || null, action: "blank.shipment_added",
        detail: { shipmentId: id, carrier: body.carrier || "", trackingNumber: body.trackingNumber || "", itemIds } });
      return jsonResponse({ status: "ok", shipmentId: id });
    } catch (e) { return jsonResponse({ status: "error", message: e.userFacing ? e.message : "Could not add the shipment" }, e.userFacing ? 400 : 500); }
  }
  if (body.action === "updateBlankShipment") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!body.id) return jsonResponse({ status: "error", message: "id required" }, 400);
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(Number).filter(Boolean) : [];
    if (!itemIds.length) return jsonResponse({ status: "error", message: "Pick at least one line item" }, 400);
    try {
      await updateBlankShipment(env.DB, Number(body.id), { carrier: body.carrier, trackingNumber: body.trackingNumber, shippedAt: body.shippedAt, itemIds });
      audit({ orgId: body.org || null, orderId: body.orderId || null, action: "blank.shipment_updated",
        detail: { shipmentId: Number(body.id), carrier: body.carrier || "", trackingNumber: body.trackingNumber || "", itemIds } });
      return jsonResponse({ status: "ok" });
    } catch (e) { return jsonResponse({ status: "error", message: e.userFacing ? e.message : "Could not update the shipment" }, e.userFacing ? 400 : 500); }
  }
  if (body.action === "deleteBlankShipment") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!body.id) return jsonResponse({ status: "error", message: "id required" }, 400);
    await deleteBlankShipment(env.DB, Number(body.id));
    audit({ orgId: body.org || null, orderId: body.orderId || null, action: "blank.shipment_deleted", detail: { shipmentId: Number(body.id) } });
    return jsonResponse({ status: "ok" });
  }
  if (body.action === "getBlankShipments") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!body.orderId) return jsonResponse({ status: "error", message: "orderId required" }, 400);
    return jsonResponse({ status: "ok", shipments: await getBlankShipmentsForOrder(env.DB, String(body.orderId)) });
  }

  // ---- bulkSetFulfillmentStage -----------------------------------------------
  if (body.action === "bulkSetFulfillmentStage") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!Array.isArray(body.orderIds) || !body.stage) {
      return jsonResponse({ status: "error", message: "Missing orderIds or stage" }, 400);
    }
    if (body.orderIds.length > 500) {
      return jsonResponse({ status: "error", message: "Too many order IDs (max 500)" }, 400);
    }
    if (!body.orderIds.every((id) => typeof id === "string" && ORDER_ID_RE.test(id))) {
      return jsonResponse({ status: "error", message: "Invalid order ID in list" }, 400);
    }
    const VALID_STAGES = new Set(["blankOrdered","blankShipped","blankReceived","manufactured","digitizingComplete","designApproved","qaPacked","shipped","delivered"]);
    if (!VALID_STAGES.has(body.stage)) {
      return jsonResponse({ status: "error", message: "Invalid stage" }, 400);
    }
    if (body.stage === "designApproved" && !featureOn("designVerification")) return featureOffResponse("designVerification", featureLabel_("designVerification"));
    // Optional per-order line-item selection (migrations/0039): body.items = [{orderId, itemId}].
    // Lets one bulk action span orders and pick specific lines for a blank stage.
    const itemsByOrder = byId_();
    if (Array.isArray(body.items)) for (const it of body.items) {
      const oid = String(it.orderId || ""), iid = Number(it.itemId);
      if (oid && iid) (itemsByOrder[oid] = itemsByOrder[oid] || []).push(iid);
    }
    const blankOrderedExtras = body.stage === "blankOrdered" ? {
      vendor:            String(body.vendor || "").slice(0, 100),
      vendorOrderId:     String(body.vendorOrderId || "").slice(0, 100),
      estimatedDelivery: String(body.estimatedDelivery || "").slice(0, 20),
    } : {};
    const blankShippedExtras = body.stage === "blankShipped" ? { shippedAt: String(body.shippedAt || "").slice(0, 30) } : {};
    const blankReceivedExtras = body.stage === "blankReceived" ? {
      blankCondition: ["Good","Other"].includes(String(body.condition || "")) ? String(body.condition) : "Good",
      itemConditions: Array.isArray(body.itemConditions)
        ? body.itemConditions.slice(0, 500).map(ic => ({
            itemId:    Number(ic.sheetRow) || 0,
            condition: ["Good","Other"].includes(String(ic.condition || "")) ? String(ic.condition) : "Good",
            note:      String(ic.note || "").slice(0, 200),
          })).filter(ic => ic.itemId >= 1)
        : [],
    } : {};
    const shippedExtras = body.stage === "shipped" && body.trackingNumber
      ? { trackingNumber: String(body.trackingNumber).slice(0, 100) }
      : {};
    const extras = { ...blankOrderedExtras, ...blankShippedExtras, ...blankReceivedExtras, ...shippedExtras };
    let updated = 0, skipped = 0;
    const errors = [];
    for (const orderId of body.orderIds) {
      try {
        const why = stagePrereqError(await getOrderById(env.DB, orderId), body.stage);
        if (why) { errors.push(`${orderId}: can't mark ${body.stage} — ${why}`); skipped++; continue; }
        const perOrderExtras = itemsByOrder[orderId] ? { ...extras, itemIds: itemsByOrder[orderId] } : extras;
        const res = await setFulfillmentStage(env.DB, orderId, body.stage, perOrderExtras);
        if (body.stage === "shipped" && res && res.changed) sendShippedEmailLater_(orderId);
        updated++;
      } catch (e) {
        errors.push(orderId + ": " + e.message);
        skipped++;
      }
    }
    if (updated > 0) {
      audit({ orgId: body.org || null, orderId: null, action: "order.bulk_fulfillment_stage",
        detail: { stage: body.stage, updated, skipped, orderIds: body.orderIds.slice(0, 50) } });
    }
    return jsonResponse({ status: "ok", updated, skipped, errors });
  }

  // ---- cancelLineItem --------------------------------------------------------
  if (body.action === "cancelLineItem") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    if (!body.org || !body.sheetRow) return jsonResponse({ status: "error", message: "Missing org or sheetRow" }, 400);
    const { lateCancel } = await cancelLineItemWithReason(env.DB, body.sheetRow, body.reason || "");

    const item = await getOrderItemById(env.DB, body.sheetRow);
    let emailSent = false;
    if (item) {
      const order = await getOrderById(env.DB, item.orderId);
      if (order && order.contact) {
        emailSent = await sendCancellationEmail(env, order, [item], body.reason || "", lateCancel);
      }
      audit({ orgId: body.org, orderId: item.orderId, action: "item.cancelled",
        detail: { itemId: body.sheetRow, name: item.name, size: item.size, reason: body.reason || "", lateCancel } });
    }
    return jsonResponse({ status: "ok", lateCancel, emailSent });
  }

  // ---- bulkCancelLineItems ---------------------------------------------------
  if (body.action === "bulkCancelLineItems") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    if (!Array.isArray(body.sheetRows)) return jsonResponse({ status: "error", message: "Missing sheetRows" }, 400);
    const results = [];
    const cancelledByOrder = byId_();
    for (const itemId of body.sheetRows) {
      const { lateCancel } = await cancelLineItemWithReason(env.DB, itemId, body.reason || "");
      const item = await getOrderItemById(env.DB, itemId);
      if (item) {
        if (!cancelledByOrder[item.orderId]) cancelledByOrder[item.orderId] = [];
        cancelledByOrder[item.orderId].push({ ...item, lateCancel });
      }
      results.push({ itemId, lateCancel });
    }
    for (const [orderId, items] of Object.entries(cancelledByOrder)) {
      const order = await getOrderById(env.DB, orderId);
      if (order && order.contact) {
        const anyLate = items.some((it) => it.lateCancel);
        await sendCancellationEmail(env, order, items, body.reason || "", anyLate);
      }
    }
    if (body.sheetRows.length > 0) {
      audit({ orgId: body.org || null, orderId: null, action: "item.bulk_cancelled",
        detail: { count: body.sheetRows.length, reason: body.reason || "", orderIds: Object.keys(cancelledByOrder) } });
    }
    return jsonResponse({ status: "ok", results });
  }

  // ---- setLineItemRefund -----------------------------------------------------
  if (body.action === "setLineItemRefund") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    if (!body.org || !body.sheetRow) return jsonResponse({ status: "error", message: "Missing org or sheetRow" }, 400);
    await setLineItemRefund(env.DB, body.sheetRow, Number(body.refundAmount) || 0);
    const refundItem = await getOrderItemById(env.DB, body.sheetRow);
    audit({ orgId: body.org, orderId: refundItem ? refundItem.orderId : null, action: "item.refund_set",
      detail: { itemId: body.sheetRow, name: refundItem ? refundItem.name : null, refundAmount: Number(body.refundAmount) || 0 } });
    return jsonResponse({ status: "ok" });
  }

  // ---- editOrder — change/add/remove items, optionally request payment --------
  if (body.action === "editOrder") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }

    const orderId = String(body.orderId || "").trim();
    if (!ORDER_ID_RE.test(orderId)) return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);

    const order = await getOrderById(env.DB, orderId);
    if (!order) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    const orgId = order.orgId;

    // Original total for computing price diff
    const originalTotal = order.total;

    // Process removals (cancel + optional refund)
    for (const removal of (Array.isArray(body.removals) ? body.removals : [])) {
      const itemId = Number(removal.itemId);
      if (!itemId) continue;
      await cancelLineItemWithReason(env.DB, itemId, String(removal.reason || "Admin edit").slice(0, 200));
      const refund = Number(removal.refundAmount);
      if (refund > 0) {
        await setLineItemRefund(env.DB, itemId, refund);
      }
    }

    // Process updates (re-price from D1 — for a configurable line the picks are re-validated and
    // the stored snapshot is rebuilt server-side, never trusted from the client).
    for (const upd of (Array.isArray(body.updates) ? body.updates : [])) {
      const itemId = Number(upd.itemId);
      if (!itemId) continue;
      let unitPrice = 0, personalizationFee = 0, lineConfig;
      let pricing = null;
      // The customer's own design stays on the line: rebuilt from the line's saved copy, never
      // from the request (migrations/0054). Adding one from here isn't offered — Files is.
      const saved = (order.items || []).find(i => Number(i.sheetRow) === itemId);
      try {
        pricing = await priceItem(env.DB, orgId, upd.productId, upd.size, Number(upd.qty) || 1, !!upd.personalized, upd.config,
          { custom: saved && saved.productId === upd.productId ? customFromConfig(saved.config) : {} });
      } catch (e) {
        if (e && e.userFacing) return jsonResponse({ status: "error", message: e.message }, 400);
      }
      if (pricing) {
        unitPrice = pricing.unitPrice; personalizationFee = pricing.personalizationFee; lineConfig = pricing.config;
      } else {
        unitPrice = Number(upd.unitPrice) || 0; personalizationFee = Number(upd.personalizationFee) || 0;
      }
      const prod = await env.DB.prepare("SELECT name, type FROM products WHERE orgId=? AND productId=?")
        .bind(orgId, upd.productId).first();
      await updateOrderItem(env.DB, itemId, {
        productId: upd.productId,
        name:  prod ? prod.name  : String(upd.name  || "").slice(0, 200),
        type:  prod ? prod.type  : String(upd.type  || "").slice(0, 80),
        size:  String(upd.size  || "").slice(0, 40),
        qty:   Number(upd.qty)  || 1,
        unitPrice, personalized: !!upd.personalized,
        persName: String(upd.persName || "").slice(0, 200),
        personalizationFee,
        ...(lineConfig ? { config: lineConfig } : {}),
      });
    }

    // Process additions (price from D1)
    const addedIds = [];
    for (const add of (Array.isArray(body.additions) ? body.additions : [])) {
      let unitPrice = 0, personalizationFee = 0, lineConfig;
      let pricing = null;
      try {
        pricing = await priceItem(env.DB, orgId, add.productId, add.size, Number(add.qty) || 1, !!add.personalized, add.config);
      } catch (e) {
        if (e && e.userFacing) return jsonResponse({ status: "error", message: e.message }, 400);
      }
      if (pricing) { unitPrice = pricing.unitPrice; personalizationFee = pricing.personalizationFee; lineConfig = pricing.config; }
      const prod = await env.DB.prepare("SELECT name, type FROM products WHERE orgId=? AND productId=?")
        .bind(orgId, add.productId).first();
      const newId = await addOrderItem(env.DB, orderId, orgId, {
        productId: add.productId,
        name:  prod ? prod.name  : String(add.name  || "").slice(0, 200),
        type:  prod ? prod.type  : String(add.type  || "").slice(0, 80),
        size:  String(add.size  || "").slice(0, 40),
        qty:   Number(add.qty)  || 1,
        unitPrice, personalized: !!add.personalized,
        persName: String(add.persName || "").slice(0, 200),
        personalizationFee,
        ...(lineConfig ? { config: lineConfig } : {}),
      });
      addedIds.push(newId);
    }

    // Recalculate order totals
    const { subtotal, total } = await recalcOrderTotals(env.DB, orderId);
    const priceDiff = Math.round((total - originalTotal) * 100) / 100;

    // Optionally create Stripe payment link + email for extra amount owed
    let paymentUrl = null, emailSent = false;
    if (body.requestPayment && priceDiff > 0) {
      if (!env.STRIPE_SECRET_KEY) {
        return jsonResponse({ status: "error", message: "Stripe not configured" }, 500);
      }
      if (!order.contact || !order.contact.includes("@")) {
        return jsonResponse({ status: "error", message: "No valid email on file — cannot request payment" }, 400);
      }
      const amountCents = Math.round(priceDiff * 100);
      let orgSubdomain = "";
      try { const o = await getOrgById(env.DB, orgId); if (o) orgSubdomain = o.subdomain || ""; } catch (_) {}
      const origin = orgSubdomain ? `https://${orgSubdomain}.${rootDomain(env)}` : new URL(request.url).origin;
      const params = new URLSearchParams({
        "payment_method_types[]": "card",
        "mode": "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(amountCents),
        "line_items[0][price_data][product_data][name]": "Order adjustment — " + orderId,
        "line_items[0][price_data][product_data][description]": "Balance due for order changes",
        "line_items[0][quantity]": "1",
        "metadata[type]": "order_edit_payment",
        "metadata[orderId]": orderId,
        "metadata[orgId]": orgId,
        "customer_email": order.contact,
        "success_url": origin + "/?stripe=success&orderId=" + encodeURIComponent(orderId) + "&org=" + encodeURIComponent(orgId),
        "cancel_url": origin + "/",
      });
      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const session = await stripeRes.json();
      if (!session.url) {
        const msg = (session.error && session.error.message) || "Unknown Stripe error";
        return jsonResponse({ status: "error", message: "Order saved but payment link failed: " + msg }, 500);
      }
      paymentUrl = session.url;
      const emailBody = String(body.emailBody || "").trim().slice(0, 3000) || null;
      emailSent = await sendShippingPaymentEmail(env, {
        customerName: order.customerName,
        customerEmail: order.contact,
        orderId,
        shippingCost: priceDiff,
        shippingMethod: "",
        paymentUrl: session.url,
        customBody: emailBody,
      });
    }

    audit({ orgId, orderId, action: "order.edited",
      detail: { removals: (body.removals || []).length, updates: (body.updates || []).length,
        additions: (body.additions || []).length, priceDiff, paymentRequested: !!body.requestPayment } });
    return jsonResponse({ status: "ok", orderId, subtotal, total, priceDiff, addedIds, paymentUrl, emailSent });
  }

  // ---- recordTracking --------------------------------------------------------
  if (body.action === "recordTracking") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!body.org || !body.orderId) return jsonResponse({ status: "error", message: "Missing org or orderId" }, 400);
    await setTrackingNumbers(env.DB, [body.orderId], body.trackingNumber || "");
    audit({ orgId: body.org, orderId: body.orderId, action: "order.tracking_set",
      detail: { trackingNumber: body.trackingNumber || "" } });
    return jsonResponse({ status: "ok" });
  }

  // ---- bulkRecordTracking ----------------------------------------------------
  if (body.action === "bulkRecordTracking") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!Array.isArray(body.orderIds)) return jsonResponse({ status: "error", message: "Missing orderIds" }, 400);
    if (body.orderIds.length > 500) return jsonResponse({ status: "error", message: "Too many order IDs (max 500)" }, 400);
    if (!body.orderIds.every((id) => typeof id === "string" && ORDER_ID_RE.test(id))) {
      return jsonResponse({ status: "error", message: "Invalid order ID in list" }, 400);
    }
    const results = await setTrackingNumbers(env.DB, body.orderIds, body.trackingNumber || "");
    audit({ orgId: body.org || null, orderId: null, action: "order.bulk_tracking_set",
      detail: { count: body.orderIds.length, trackingNumber: body.trackingNumber || "" } });
    return jsonResponse({ status: "ok", ...results });
  }

  // ---- getOrderForShipping (used by shippo-label.js) -------------------------
  if (body.action === "getOrderForShipping") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!body.orderId) return jsonResponse({ status: "error", message: "Missing orderId" }, 400);
    const row = await getOrderForShipping(env.DB, body.orderId);
    if (!row) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    return jsonResponse({
      status: "ok",
      shippingAddress: row.shippingAddress ? JSON.parse(row.shippingAddress) : null,
      totalWeightOz: Number(row.totalWeightOz) || 0,
    });
  }

  // ---- Catalog admin actions -------------------------------------------------
  if (CATALOG_ADMIN_ACTIONS.has(body.action)) {
    const denied = await requireAdmin(env, host, body.key, request, "Not available here.", ACTION_ROLE[body.action]);
    if (denied) return denied;

    // Sets up the org's subdomain as a custom domain (customDomain.js). Never throws: the
    // result carries {configured:false} when the CF_* env vars aren't set, or {error} on failure.
    const setUpDomain_ = async (orgId, subdomain) => {
      let domain;
      try { domain = await ensureOrgDomain(env, subdomain); }
      catch (e) {
        console.error("Custom domain setup failed for", orgId, e);
        domain = { configured: true, error: e.userFacing ? e.message : "Couldn't reach Cloudflare to set up the domain." };
      }
      if (domain.configured) audit({ orgId, orderId: null, action: domain.error ? "org.domain_setup_failed" : "org.domain_setup",
        detail: { hostname: domain.hostname || null, steps: domain.steps || [], status: domain.status || null, error: domain.error || null } });
      return domain;
    };

    // Catalog/price edits are audited: what changed, from → to. Only the
    // fields that actually differ are recorded, so a price change reads as one line in the Audit Log.
    const PRODUCT_AUDIT_FIELDS = ["name", "sub", "type", "pricingMode", "flatPrice", "sizePricing", "personalizationPrice", "noDesignNeeded",
      "customDesign", "customDesignPrice", "personalizationOptions", "images", "features", "visible", "sortOrder", "weightOz", "taxable"];
    const ORG_AUDIT_FIELDS = ["subdomain", "name", "eyebrow", "accent", "desc", "ready", "shippingEnabled", "deliveryOptions", "enabledPayments",
      "orderDeadline", "closedMessage", "allowOrdersAfterDeadline", "designImageShirt", "designImageCap", "designImageDetail"];
    const diff_ = (before, after, fields) => {
      const changes = {};
      for (const f of fields) {
        const a = before ? before[f] : undefined, b = after ? after[f] : undefined;
        if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[f] = { from: a ?? null, to: b ?? null };
      }
      return changes;
    };
    const productOf_ = async (orgId, productId) => (await getProductsByOrg(env.DB, orgId, false)).find(p => p.productId === productId) || null;

    if (body.action === "listOrgsAdmin") {
      const orgs = await getAllOrgs(env.DB);
      return jsonResponse({ status: "ok", orgs });
    }

    if (body.action === "createOrg") {
      if (!body.orgId || !body.subdomain || !body.name) {
        return jsonResponse({ status: "error", message: "Missing orgId, subdomain, or name" }, 400);
      }
      const orgCheck = validateOrgFields(body, true);
      if (orgCheck.error) return jsonResponse({ status: "error", message: orgCheck.error }, 400);
      Object.assign(body, orgCheck.fields);
      // Delivery / pickup options (migrations/0045): the list decides whether shipping is on.
      let newDelivery = null;
      if (body.deliveryOptions !== undefined) {
        const d = cleanDeliveryOptions(body.deliveryOptions);
        if (d.error) return jsonResponse({ status: "error", message: d.error }, 400);
        newDelivery = d.options;
        body.shippingEnabled = newDelivery.some(o => o.type === "shipping");
      }
      if (body.shippingEnabled && (await getLocaleSettings(env.DB)).country !== "US") return jsonResponse({ status: "error", message: NO_CARRIER_SHIPPING_MSG }, 400);
      if (body.shippingEnabled && !featureOn("shipping")) return jsonResponse({ status: "error", message: NO_SHIPPING_FEATURE_MSG }, 400);
      await createOrg(env.DB, {
        orgId: body.orgId, subdomain: body.subdomain, name: body.name,
        eyebrow: body.eyebrow || "", accent: body.accent || "#2563eb",
        desc: body.desc || "", ready: !!body.ready,
        shippingEnabled: !!body.shippingEnabled,
        enabledPayments: body.enabledPayments || { card: true, venmo: true, zelle: true, check: true },
        orderDeadline: body.orderDeadline || null,
        closedMessage: body.closedMessage || null,
        allowOrdersAfterDeadline: body.allowOrdersAfterDeadline !== false,
        designImageShirt: body.designImageShirtUrl || "",
        designImageCap: body.designImageCapUrl || "",
        designImageDetail: body.designImageDetailUrl || "",
      });
      if (newDelivery) await setOrgDeliveryOptions(env.DB, body.orgId, newDelivery);
      // Tax exemption is only touched when the form sends it (see setOrgTaxExemption).
      if (body.taxExempt !== undefined) {
        const certificate = String(body.taxExemptCertificate || "").trim().slice(0, 100);
        const expires = String(body.taxExemptExpires || "").trim();
        if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
          return jsonResponse({ status: "error", message: "Exemption expiry must be YYYY-MM-DD" }, 400);
        }
        if (body.taxExempt && !certificate) {
          return jsonResponse({ status: "error", message: "A tax-exempt org needs its exemption certificate number" }, 400);
        }
        await setOrgTaxExemption(env.DB, body.orgId, { taxExempt: !!body.taxExempt, certificate, expires });
        audit({ orgId: body.orgId, orderId: null, action: "org.tax_exemption_set",
          detail: { taxExempt: !!body.taxExempt, certificate, expires: expires || null } });
      }
      audit({ orgId: body.orgId, orderId: null, action: "org.created",
        detail: { changes: diff_(null, await getOrgById(env.DB, body.orgId), ORG_AUDIT_FIELDS) } });
      // The org exists either way; a domain failure is reported, not fatal, and can be retried
      // from the org's edit form (setupOrgDomain).
      const domain = await setUpDomain_(body.orgId, body.subdomain);
      return jsonResponse({ status: "ok", domain });
    }

    if (body.action === "setupOrgDomain" || body.action === "getOrgDomainStatus") {
      const org = (await getAllOrgs(env.DB)).find(o => o.orgId === body.orgId);
      if (!org) return jsonResponse({ status: "error", message: "Unknown org" }, 404);
      if (body.action === "setupOrgDomain") return jsonResponse({ status: "ok", domain: await setUpDomain_(org.orgId, org.subdomain) });
      try { return jsonResponse({ status: "ok", domain: await getOrgDomainStatus(env, org.subdomain) }); }
      catch (e) { return jsonResponse({ status: "ok", domain: { configured: true, error: e.userFacing ? e.message : "Couldn't reach Cloudflare." } }); }
    }

    if (body.action === "updateOrg") {
      if (!body.orgId) return jsonResponse({ status: "error", message: "Missing orgId" }, 400);
      const existingOrg = await getOrgById(env.DB, body.orgId);
      if (!existingOrg) return jsonResponse({ status: "error", message: "Unknown org" }, 404);
      // A blank subdomain keeps the current one. An unchanged subdomain isn't re-checked, so an
      // org whose stored subdomain wouldn't pass today's checks can still be edited.
      const subdomainChanged = !!body.subdomain && body.subdomain !== existingOrg.subdomain;
      if (!subdomainChanged) body.subdomain = existingOrg.subdomain;
      const orgCheck = validateOrgFields({ ...body, subdomain: subdomainChanged ? body.subdomain : "" }, false);
      if (orgCheck.error) return jsonResponse({ status: "error", message: orgCheck.error }, 400);
      Object.assign(body, orgCheck.fields);
      // Delivery / pickup options (migrations/0045). The form sends the whole list. A caller that only
      // knows the old "shipping enabled" switch still works: on a shop with a saved list the switch
      // adds or removes the list's shipping entry, so the two can't disagree.
      let newDelivery = null;
      if (body.deliveryOptions !== undefined) {
        const d = cleanDeliveryOptions(body.deliveryOptions);
        if (d.error) return jsonResponse({ status: "error", message: d.error }, 400);
        newDelivery = d.options;
      } else if (existingOrg.deliveryOptionsStored) {
        newDelivery = existingOrg.deliveryOptions.filter(o => o.type !== "shipping");
        if (body.shippingEnabled) newDelivery.push(defaultDeliveryOptions(true)[1]);
        if (!newDelivery.length) newDelivery = defaultDeliveryOptions(false);
      }
      if (newDelivery) body.shippingEnabled = newDelivery.some(o => o.type === "shipping");
      // Only when shipping is being turned ON: a shop that already had it (from before the country
      // changed) can still be edited; the storefront and order placement leave it out anyway.
      if (body.shippingEnabled && !existingOrg.shippingEnabled && (await getLocaleSettings(env.DB)).country !== "US") {
        return jsonResponse({ status: "error", message: NO_CARRIER_SHIPPING_MSG }, 400);
      }
      if (body.shippingEnabled && !existingOrg.shippingEnabled && !featureOn("shipping")) return jsonResponse({ status: "error", message: NO_SHIPPING_FEATURE_MSG }, 400);
      await updateOrg(env.DB, body.orgId, {
        subdomain: body.subdomain,
        name: body.name, eyebrow: body.eyebrow || "", accent: body.accent || "#2563eb",
        desc: body.desc || "", ready: !!body.ready,
        shippingEnabled: !!body.shippingEnabled,
        enabledPayments: body.enabledPayments || { card: true, venmo: true, zelle: true, check: true },
        orderDeadline: body.orderDeadline || null,
        closedMessage: body.closedMessage || null,
        allowOrdersAfterDeadline: body.allowOrdersAfterDeadline !== false,
        designImageShirt: body.designImageShirtUrl || "",
        designImageCap: body.designImageCapUrl || "",
        designImageDetail: body.designImageDetailUrl || "",
      });
      if (newDelivery) await setOrgDeliveryOptions(env.DB, body.orgId, newDelivery);
      { const changes = diff_(existingOrg, await getOrgById(env.DB, body.orgId), ORG_AUDIT_FIELDS);
        if (Object.keys(changes).length) audit({ orgId: body.orgId, orderId: null, action: "org.updated", detail: { changes } }); }
      // Tax exemption is only touched when the form sends it (see setOrgTaxExemption).
      if (body.taxExempt !== undefined) {
        const certificate = String(body.taxExemptCertificate || "").trim().slice(0, 100);
        const expires = String(body.taxExemptExpires || "").trim();
        if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
          return jsonResponse({ status: "error", message: "Exemption expiry must be YYYY-MM-DD" }, 400);
        }
        if (body.taxExempt && !certificate) {
          return jsonResponse({ status: "error", message: "A tax-exempt org needs its exemption certificate number" }, 400);
        }
        await setOrgTaxExemption(env.DB, body.orgId, { taxExempt: !!body.taxExempt, certificate, expires });
        audit({ orgId: body.orgId, orderId: null, action: "org.tax_exemption_set",
          detail: { taxExempt: !!body.taxExempt, certificate, expires: expires || null } });
      }
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "listProducts") {
      const products = await getProductsByOrg(env.DB, body.org, false);
      return jsonResponse({ status: "ok", products });
    }

    // Personalization setup (migrations/0032): every pick-list option must map to one of the shop's
    // designs (each option is its own hooping), and typed-in text stitched as its own hooping needs
    // a hoop. Returns an error message, or "" (and tidies body's fields).
    const checkPersonalization_ = async (body) => {
      if (body.personalizationMode === undefined && body.personalizationOptionDesigns === undefined) return "";
      const options = Array.isArray(body.personalizationOptions) ? body.personalizationOptions.map(o => String(o).trim()).filter(Boolean) : [];
      const map = body.personalizationOptionDesigns && typeof body.personalizationOptionDesigns === "object" ? body.personalizationOptionDesigns : {};
      const orgDesigns = new Set((await listDesigns(env.DB, body.org)).map(d => d.id));
      const clean = {};
      for (const o of options) {
        const id = Number(map[o]);
        if (!id) return `Pick a design for the pick-list option "${o}" — each option is its own hooping.`;
        if (!orgDesigns.has(id)) return `The design for "${o}" doesn't belong to this shop.`;
        clean[o] = id;
      }
      body.personalizationOptionDesigns = clean;
      body.personalizationMode = body.personalizationMode === "separate" ? "separate" : "combined";
      body.personalizationHoopId = body.personalizationHoopId ? Number(body.personalizationHoopId) : null;
      if (body.personalizationMode === "separate" && !options.length && body.personalizationPrice != null && !body.personalizationHoopId)
        return "Pick the hoop for the personalization's own hooping.";
      return "";
    };

    // The customer's own design (migrations/0054): how it's made, and an add-on of $0–$1,000 per
    // piece (blank = free). Only checked — and only saved — when the form sends it.
    const checkCustomDesign_ = (body) => {
      if (body.customDesign === undefined) return "";
      const kind = body.customDesign == null ? "" : String(body.customDesign);
      if (!CUSTOM_DESIGN_KINDS.includes(kind)) return "The customer's own design must be Off, Embroidery or Transfer.";
      // The uploads go to the private file storage; without it the shop page couldn't take one.
      if (kind && !env.DESIGNS) return "The customer's own design needs file storage (the DESIGNS bucket) — see docs/configuration.md.";
      body.customDesign = kind;
      const raw = body.customDesignPrice;
      if (raw == null || raw === "") { body.customDesignPrice = null; return ""; }
      const price = typeof raw === "number" ? raw : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
      if (!Number.isFinite(price) || price < 0 || price > 1000) return "The add-on for the customer's own design must be between $0 and $1,000 (blank = free).";
      body.customDesignPrice = Math.round(price * 100) / 100;
      return "";
    };

    // A configurable product's locations may each carry their own add-on for the customer's design
    // (blank = the product's). The form sends dollars (`customDesignPrice`); it's stored in whole cents
    // on the location (`customDesignPriceCents`, products.locationsJson), $0–$1,000.
    const cleanLocationPrices_ = (body) => {
      if (!Array.isArray(body.locations)) return "";
      for (const loc of body.locations) {
        if (!loc || typeof loc !== "object") continue;
        const dollars = loc.customDesignPrice !== undefined ? loc.customDesignPrice
          : loc.customDesignPriceCents != null ? Number(loc.customDesignPriceCents) / 100 : null;
        delete loc.customDesignPrice; delete loc.customDesignPriceCents;
        if (dollars == null || dollars === "") continue;
        const n = typeof dollars === "number" ? dollars : (typeof dollars === "string" && dollars.trim() !== "" ? Number(dollars) : NaN);
        if (!Number.isFinite(n) || n < 0 || n > 1000) return `The add-on for the customer's own design at ${loc.label || loc.key || "a location"} must be between $0 and $1,000 (blank = the product's).`;
        loc.customDesignPriceCents = Math.round(n * 100);
      }
      return "";
    };

    if (body.action === "createProduct") {
      if (!body.org || !body.productId) return jsonResponse({ status: "error", message: "Missing org or productId" }, 400);
      { const why = cleanLocationPrices_(body); if (why) return jsonResponse({ status: "error", message: why }, 400); }
      { const why = await checkPersonalization_(body); if (why) return jsonResponse({ status: "error", message: why }, 400); }
      { const why = checkCustomDesign_(body); if (why) return jsonResponse({ status: "error", message: why }, 400); }
      if (!PRODUCT_ID_RE.test(String(body.productId))) {
        return jsonResponse({ status: "error", message: "Product ID must be 1-40 lowercase letters, numbers, or hyphens." }, 400);
      }
      const imgCheck = validateProductImages(body.images);
      if (imgCheck.error) return jsonResponse({ status: "error", message: imgCheck.error }, 400);
      body.images = imgCheck.images;
      await createProduct(env.DB, body.org, body);
      audit({ orgId: body.org, orderId: null, action: "product.created",
        detail: { productId: body.productId, changes: diff_(null, await productOf_(body.org, body.productId), PRODUCT_AUDIT_FIELDS) } });
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "updateProduct") {
      if (!body.org || !body.productId) return jsonResponse({ status: "error", message: "Missing org or productId" }, 400);
      { const why = cleanLocationPrices_(body); if (why) return jsonResponse({ status: "error", message: why }, 400); }
      { const why = await checkPersonalization_(body); if (why) return jsonResponse({ status: "error", message: why }, 400); }
      { const why = checkCustomDesign_(body); if (why) return jsonResponse({ status: "error", message: why }, 400); }
      const imgCheck = validateProductImages(body.images);
      if (imgCheck.error) return jsonResponse({ status: "error", message: imgCheck.error }, 400);
      body.images = imgCheck.images;
      const beforeProduct = await productOf_(body.org, body.productId);
      await updateProduct(env.DB, body.org, body);
      const changes = diff_(beforeProduct, await productOf_(body.org, body.productId), PRODUCT_AUDIT_FIELDS);
      if (Object.keys(changes).length) audit({ orgId: body.org, orderId: null, action: "product.updated", detail: { productId: body.productId, changes } });
      return jsonResponse({ status: "ok" });
    }

    // ---- CSV import (Blanks → Import CSV, a shop's Products → Import CSV) ----
    // `dryRun` returns exactly what the import would do, row by row, without writing anything — the
    // preview the admin ticks rows in. The real run takes only the rows that were left ticked.
    if (body.action === "importBlanks" || body.action === "importProducts") {
      const rows = Array.isArray(body.rows) ? body.rows.filter(r => r && typeof r === "object") : [];
      if (!rows.length) return jsonResponse({ status: "error", message: "No rows to import" }, 400);
      if (rows.length > IMPORT_MAX_ROWS) return jsonResponse({ status: "error", message: `Too many rows in one request (${rows.length}) — send up to ${IMPORT_MAX_ROWS} at a time` }, 400);
      const dryRun = !!body.dryRun;
      // A long file arrives in batches: rowOffset keeps the row numbers right, seen = keys already sent.
      const batch = { dryRun, rowOffset: Number(body.rowOffset) || 0, seen: Array.isArray(body.seen) ? body.seen.slice(0, 5000).map(String) : [] };
      if (body.action === "importBlanks") {
        const result = await importBlanksCsv(env.DB, rows, batch);
        if (!dryRun) audit({ orgId: null, orderId: null, action: "blanks.imported",
          detail: { created: result.created, updated: result.updated, skipped: result.skipped,
            styles: result.results.filter(x => x.action !== "skip").map(x => x.style).slice(0, 200) } });
        return jsonResponse({ status: "ok", ...result });
      }
      if (!body.org || !(await getOrgById(env.DB, body.org))) return jsonResponse({ status: "error", message: "Unknown org" }, 404);
      // Graphics to offer at each new location must be this shop's own.
      let graphicIds = Array.isArray(body.graphicIds) ? body.graphicIds.map(Number).filter(Boolean) : [];
      if (graphicIds.length) {
        const own = new Set((await listGraphics(env.DB, body.org)).map(g => g.id));
        if (graphicIds.some(id => !own.has(id))) return jsonResponse({ status: "error", message: "One of those graphics doesn't belong to this shop" }, 400);
      }
      const result = await importProductsCsv(env.DB, body.org, rows, { ...batch, graphicIds });
      if (!dryRun) audit({ orgId: body.org, orderId: null, action: "products.imported",
        detail: { created: result.created, updated: result.updated, skipped: result.skipped, linked: result.linked,
          productIds: result.results.filter(x => x.action !== "skip").map(x => x.productId).slice(0, 200) } });
      return jsonResponse({ status: "ok", ...result });
    }

    if (body.action === "setProductVisible") {
      if (!body.org || !body.productId) return jsonResponse({ status: "error", message: "Missing org or productId" }, 400);
      await setProductVisible(env.DB, body.org, body.productId, !!body.visible);
      audit({ orgId: body.org, orderId: null, action: body.visible ? "product.shown" : "product.hidden", detail: { productId: body.productId } });
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "getGlobalSettings") {
      const settings = await getGlobalSettings(env.DB);
      return jsonResponse({ status: "ok", globalSettings: settings });
    }

    // ---- Setup status: which parts of the install are configured (functions/_lib/setupStatus.js).
    // Says only whether each thing is set — never a key, token or id.
    if (body.action === "getSetupStatus") {
      const safe = async (f, fallback) => { try { return await f(); } catch (e) { return fallback; } };
      const [business, salesTax, locale] = await Promise.all([
        safe(() => getBusinessProfile(env.DB), {}), safe(() => getSalesTaxSettings(env.DB), {}), safe(() => getLocaleSettings(env.DB), {}),
      ]);
      const items = setupStatus(env, { business, salesTax, locale });
      return jsonResponse({ status: "ok", items, summary: setupSummary(items) });
    }

    if (body.action === "updateGlobalSettings") {
      await setGlobalSettings(env.DB, body.globalSettings || {});
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "getMachineSettings") {
      return jsonResponse({ status: "ok", machineSettings: await getMachineSettings(env.DB) });
    }

    if (body.action === "updateMachineSettings") {
      await setMachineSettings(env.DB, body.machineSettings || {});
      audit({ orgId: null, orderId: null, action: "settings.machine_set", detail: body.machineSettings || {} });
      return jsonResponse({ status: "ok", machineSettings: await getMachineSettings(env.DB) });
    }

    // ---- Ship-from address (shipping labels/quotes) — see db.js for why
    // this lives here rather than as a Cloudflare env var ------------------
    if (body.action === "getBusinessProfile") {
      return jsonResponse({ status: "ok", business: await getBusinessProfile(env.DB) });
    }
    if (body.action === "updateBusinessProfile") {
      const before = await getBusinessProfile(env.DB);
      let business;
      try { business = await setBusinessProfile(env.DB, body.business || {}); }
      catch (e) { if (e && e.userFacing) return jsonResponse({ status: "error", message: e.message }, 400); throw e; }
      const changes = {};
      for (const k of Object.keys(business)) if (business[k] !== before[k]) changes[k] = { from: before[k], to: business[k] };
      audit({ orgId: null, orderId: null, action: "settings.business_set", detail: { changes } });
      // The storefront reads the name and payment details from the cached catalog — refresh it.
      try { await bumpCatalogVersion(env.DB); invalidateCatalogVersionCache(); } catch (e) { console.error("catalog version bump failed:", e); }
      return jsonResponse({ status: "ok", business });
    }
    // ---- Region: time zone and country (db.js getLocaleSettings) ----
    if (body.action === "getLocaleSettings") {
      const locale = await getLocaleSettings(env.DB);
      // What's actually in force (saved, else the TIMEZONE variable, else UTC), so the form can say so.
      return jsonResponse({ status: "ok", locale, effectiveTimeZone: await resolveTimeZone(env), envTimeZone: env.TIMEZONE ? String(env.TIMEZONE) : "" });
    }
    if (body.action === "updateLocaleSettings") {
      const before = await getLocaleSettings(env.DB);
      const want = body.locale || {};
      let locale;
      try { locale = await setLocaleSettings(env.DB, { timeZone: want.timeZone, country: want.country }); }
      catch (e) { if (e && e.userFacing) return jsonResponse({ status: "error", message: e.message }, 400); throw e; }
      const changes = {};
      for (const k of Object.keys(locale)) if (locale[k] !== before[k]) changes[k] = { from: before[k], to: locale[k] };
      audit({ orgId: null, orderId: null, action: "settings.locale_set", detail: { changes } });
      // The storefront reads the country (its address form) from the cached catalog — refresh it.
      try { await bumpCatalogVersion(env.DB); invalidateCatalogVersionCache(); } catch (e) { console.error("catalog version bump failed:", e); }
      return jsonResponse({ status: "ok", locale, effectiveTimeZone: await resolveTimeZone(env), envTimeZone: env.TIMEZONE ? String(env.TIMEZONE) : "" });
    }
    // ---- Features: which optional parts of the site are on (db.js FEATURES) ----
    if (body.action === "getFeatures") {
      return jsonResponse({ status: "ok", features: await getFeatures(env.DB), list: FEATURES });
    }
    if (body.action === "updateFeatures") {
      const before = await getFeatures(env.DB);
      const want = body.features && typeof body.features === "object" ? body.features : {};
      for (const k of Object.keys(want)) {
        if (!FEATURES.some(f => f.key === k)) return jsonResponse({ status: "error", message: `"${String(k).slice(0, 40)}" isn't a feature.` }, 400);
        if (typeof want[k] !== "boolean") return jsonResponse({ status: "error", message: "Each feature is either on (true) or off (false)." }, 400);
      }
      const changes = {};
      for (const f of FEATURES) if (typeof want[f.key] === "boolean" && want[f.key] !== before[f.key]) changes[f.key] = { from: before[f.key], to: want[f.key] };
      // Audited FIRST: switching a feature off takes pages and actions away, so there's always a record.
      if (Object.keys(changes).length) {
        const auditErr = await auditStrict({ orgId: null, orderId: null, action: "settings.features_set", detail: { changes } });
        if (auditErr) return auditErr;
      }
      const features = await setFeatures(env.DB, want);
      // Everything reads the switches from the cached catalog — refresh it.
      try { await bumpCatalogVersion(env.DB); invalidateCatalogVersionCache(); } catch (e) { console.error("catalog version bump failed:", e); }
      return jsonResponse({ status: "ok", features, list: FEATURES });
    }
    if (body.action === "getShipFromAddress") {
      const shipFrom = await getShipFromAddress(env.DB, env);
      return jsonResponse({ status: "ok", shipFrom });
    }
    if (body.action === "updateShipFromAddress") {
      const a = body.shipFrom || {};
      // US formats only when the install is in the US (Region); elsewhere both are free text.
      const { country } = await getLocaleSettings(env.DB);
      if (country === "US" && a.zip && !/^\d{5}(-\d{4})?$/.test(String(a.zip).trim())) {
        return jsonResponse({ status: "error", message: "ZIP must be 5 digits (or ZIP+4)" }, 400);
      }
      if (country === "US" && a.state && !/^[A-Za-z]{2}$/.test(String(a.state).trim())) {
        return jsonResponse({ status: "error", message: "State must be a 2-letter code" }, 400);
      }
      if (a.email && !/^\S+@\S+\.\S+$/.test(String(a.email).trim())) {
        return jsonResponse({ status: "error", message: "That doesn't look like a valid email" }, 400);
      }
      const before = await getShipFromAddress(env.DB, env);
      const shipFrom = await setShipFromAddress(env.DB, a, country);
      audit({ orgId: null, orderId: null, action: "settings.ship_from_set", detail: { from: before, to: shipFrom } });
      return jsonResponse({ status: "ok", shipFrom });
    }

    // ---- Sales tax: rate, home state, and whether prices include it (migrations/0007, 0052) ----
    if (body.action === "getSalesTaxSettings") {
      const salesTax = await getSalesTaxSettings(env.DB);
      return jsonResponse({ status: "ok", salesTax: { ...salesTax, ratePercent: salesTax.rateBps / 100 } });
    }
    if (body.action === "updateSalesTaxSettings") {
      const pct = Number(body.ratePercent);
      if (!Number.isFinite(pct) || pct < 0 || pct > 15) {
        return jsonResponse({ status: "error", message: "Tax rate must be between 0% and 15%" }, 400);
      }
      // The home state's 2-letter code; blank = not set (then nothing counts as out of state).
      // Outside the US (Region → country OTHER) it's the home region as free text ("Ontario"),
      // compared with an order's region without regard to case.
      const usFormats = (await getLocaleSettings(env.DB)).country === "US";
      const jurisdiction = usFormats ? String(body.jurisdiction || "").trim().toUpperCase()
        : String(body.jurisdiction || "").trim().replace(/\s+/g, " ").slice(0, 50);
      if (usFormats && jurisdiction && !/^[A-Z]{2}$/.test(jurisdiction)) {
        return jsonResponse({ status: "error", message: "Jurisdiction must be a 2-letter state code" }, 400);
      }
      // Tax inside the listed prices ("inclusive") or added on top ("exclusive"). Left out = unchanged.
      // Like the rate, it applies to new orders only (each order keeps its own).
      const taxMode = body.taxMode == null || body.taxMode === "" ? undefined : String(body.taxMode);
      if (taxMode !== undefined && taxMode !== "inclusive" && taxMode !== "exclusive") {
        return jsonResponse({ status: "error", message: "Tax mode must be \"inclusive\" (prices include tax) or \"exclusive\" (tax added on top)" }, 400);
      }
      const before = await getSalesTaxSettings(env.DB);
      const salesTax = await setSalesTaxSettings(env.DB, { rateBps: Math.round(pct * 100), jurisdiction, taxMode });
      // The storefront shows the rate and adds the tax itself when it's on top, so it must not keep
      // serving a cached catalog with the old rate or mode.
      try { await bumpCatalogVersion(env.DB); invalidateCatalogVersionCache(); } catch (e) { console.error("catalog version bump failed:", e); }
      audit({ orgId: null, orderId: null, action: "settings.sales_tax_set",
        detail: { from: { rateBps: before.rateBps, jurisdiction: before.jurisdiction, taxMode: before.taxMode }, to: { rateBps: salesTax.rateBps, jurisdiction, taxMode: salesTax.taxMode } } });
      return jsonResponse({ status: "ok", salesTax: { ...salesTax, ratePercent: salesTax.rateBps / 100 } });
    }

    if (body.action === "getBoxPresets") {
      const presets = await getBoxPresets(env.DB);
      return jsonResponse({ status: "ok", presets });
    }

    if (body.action === "setBoxPresets") {
      const presets = body.presets;
      if (!Array.isArray(presets)) return jsonResponse({ status: "error", message: "presets must be an array" }, 400);
      await setBoxPresets(env.DB, presets);
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "getInventory") {
      const items = await getAllInventory(env.DB);
      return jsonResponse({ status: "ok", items });
    }

    if (body.action === "createInventoryItem") {
      const result = await createInventoryItem(env.DB, body);
      return jsonResponse({ status: "ok", id: result.id, createdAt: result.createdAt });
    }

    if (body.action === "updateInventoryItem") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      await updateInventoryItem(env.DB, id, body);
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "deleteInventoryItem") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      await deleteInventoryItem(env.DB, id);
      return jsonResponse({ status: "ok" });
    }

    // Inventory → Blanks to Order: what to buy from each supplier for the open orders (read-only).
    if (body.action === "getBlanksToOrder") {
      return jsonResponse({ status: "ok", ...(await getBlanksToOrder(env.DB, { includeUnpaid: !!body.includeUnpaid })) });
    }

    if (body.action === "getBlanks") {
      const blanks = await getAllBlanks(env.DB);
      return jsonResponse({ status: "ok", blanks });
    }

    // A blank's needle type must be one from Threads → Needle settings ("" / null = not set).
    if ((body.action === "createBlank" || body.action === "updateBlank") && body.needleTypeId != null && body.needleTypeId !== "") {
      if (!(await needleTypeExists(env.DB, body.needleTypeId))) {
        return jsonResponse({ status: "error", message: "That needle type no longer exists — pick another" }, 400);
      }
    }

    if (body.action === "createBlank") {
      const result = await createBlank(env.DB, body, Array.isArray(body.sizes) ? body.sizes : []);
      return jsonResponse({ status: "ok", id: result.id, createdAt: result.createdAt });
    }

    if (body.action === "updateBlank") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      await updateBlank(env.DB, id, body, Array.isArray(body.sizes) ? body.sizes : null);
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "deleteBlank") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      await deleteBlank(env.DB, id);
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "listThreads") {
      return jsonResponse({ status: "ok", threads: await listThreads(env.DB) });
    }

    if (body.action === "saveThread") {
      const t = body.thread || {};
      if (!String(t.brand || "").trim() || !String(t.code || "").trim()) {
        return jsonResponse({ status: "error", message: "Brand and code are required" }, 400);
      }
      if (t.colorHex && !/^[0-9a-fA-F]{6}$/.test(t.colorHex)) {
        return jsonResponse({ status: "error", message: "Color must be a 6-digit hex code" }, 400);
      }
      try {
        if (t.id) { await updateThread(env.DB, Number(t.id), t); return jsonResponse({ status: "ok", id: Number(t.id) }); }
        const id = await createThread(env.DB, t);
        return jsonResponse({ status: "ok", id });
      } catch (e) {
        if (String(e.message || "").includes("UNIQUE")) return jsonResponse({ status: "error", message: "A thread with that brand + type + weight + code already exists" }, 400);
        throw e;
      }
    }

    if (body.action === "deleteThread") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      try { await deleteThread(env.DB, id); return jsonResponse({ status: "ok" }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
    }

    if (body.action === "listSpoolSizes") {
      return jsonResponse({ status: "ok", spoolSizes: await listSpoolSizes(env.DB) });
    }

    if (body.action === "saveSpoolSize") {
      const s = body.spoolSize || {};
      if (!String(s.description || "").trim()) return jsonResponse({ status: "error", message: "Description is required" }, 400);
      if (Number(s.meters) < 0 || !Number.isFinite(Number(s.meters))) return jsonResponse({ status: "error", message: "Meters must be a non-negative number" }, 400);
      const id = await saveSpoolSize(env.DB, s);
      return jsonResponse({ status: "ok", id, spoolSizes: await listSpoolSizes(env.DB) });
    }

    if (body.action === "deleteSpoolSize") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      try { await deleteSpoolSize(env.DB, id); return jsonResponse({ status: "ok", spoolSizes: await listSpoolSizes(env.DB) }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
    }

    if (body.action === "saveThreadInventory") {
      const it = body.item || {};
      if (!it.id && !Number(it.threadId)) return jsonResponse({ status: "error", message: "threadId required" }, 400);
      const id = await saveThreadInventory(env.DB, it);
      return jsonResponse({ status: "ok", id, threads: await listThreads(env.DB) });
    }

    if (body.action === "deleteThreadInventory") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      await deleteThreadInventory(env.DB, id);
      return jsonResponse({ status: "ok", threads: await listThreads(env.DB) });
    }

    // Needle settings (migrations/0044): needle size by thread weight + the needle types a blank
    // can pick. Every change answers with both lists, so the window redraws from one response.
    if (["getNeedleSettings", "saveNeedleSize", "deleteNeedleSize", "saveNeedleType", "deleteNeedleType"].includes(body.action)) {
      const settings = async () => ({ needleSizes: await listNeedleSizes(env.DB), needleTypes: await listNeedleTypes(env.DB) });
      try {
        if (body.action === "saveNeedleSize") await saveNeedleSize(env.DB, body.needleSize || {});
        else if (body.action === "deleteNeedleSize") await deleteNeedleSize(env.DB, body.weight);
        else if (body.action === "saveNeedleType") await saveNeedleType(env.DB, body.needleType || {});
        else if (body.action === "deleteNeedleType") {
          if (!Number(body.id)) return jsonResponse({ status: "error", message: "id required" }, 400);
          await deleteNeedleType(env.DB, body.id);
        }
      } catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
      return jsonResponse({ status: "ok", ...(await settings()) });
    }

    if (body.action === "listHoops") {
      return jsonResponse({ status: "ok", hoops: await listHoops(env.DB) });
    }

    if (body.action === "saveHoop") {
      const h = body.hoop || {};
      if (!String(h.name || "").trim()) return jsonResponse({ status: "error", message: "Name is required" }, 400);
      if (h.id) { await updateHoop(env.DB, Number(h.id), h); return jsonResponse({ status: "ok", id: Number(h.id) }); }
      const id = await createHoop(env.DB, h);
      return jsonResponse({ status: "ok", id });
    }

    if (body.action === "deleteHoop") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      try { await deleteHoop(env.DB, id); return jsonResponse({ status: "ok" }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
    }

    // ---- Locations — global garment-location lookup (migrations/0041) ----
    if (body.action === "listLocations") {
      return jsonResponse({ status: "ok", locations: await listLocations(env.DB) });
    }
    if (body.action === "saveLocation") {
      const l = body.location || {};
      if (!String(l.name || "").trim()) return jsonResponse({ status: "error", message: "Name is required" }, 400);
      const id = await saveLocation(env.DB, l);
      return jsonResponse({ status: "ok", id });
    }
    if (body.action === "deleteLocation") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      try { await deleteLocation(env.DB, id); return jsonResponse({ status: "ok" }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
    }

    // ---- Per-location graphic × color mockups for configurable products (migrations/0042) ----
    if (body.action === "listProductGraphicImages") {
      if (!body.org || !body.productId) return jsonResponse({ status: "error", message: "org and productId required" }, 400);
      return jsonResponse({ status: "ok", mockups: await listProductGraphicImages(env.DB, body.org, String(body.productId)),
        baseImages: await getProductLocationBaseImages(env.DB, body.org, String(body.productId)) });
    }
    if (body.action === "setProductGraphicImage") {
      const m = body.mockup || {};
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      try { await setProductGraphicImage(env.DB, { ...m, orgId: body.org }); return jsonResponse({ status: "ok" }); }
      catch (e) { return jsonResponse({ status: "error", message: e.userFacing ? e.message : "Could not save the mockup" }, e.userFacing ? 400 : 500); }
    }
    if (body.action === "deleteProductGraphicImage") {
      const m = body.mockup || {};
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      await deleteProductGraphicImage(env.DB, { ...m, orgId: body.org });
      return jsonResponse({ status: "ok" });
    }

    // ---- Graphics / selectable options + tier prices (migrations/0036) ----
    if (body.action === "listGraphics") {
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      return jsonResponse({ status: "ok", graphics: await listGraphics(env.DB, body.org), ...(await getTierPrices(env.DB, body.org)) });
    }
    if (body.action === "saveGraphic") {
      const g = body.graphic || {};
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      if (!String(g.name || "").trim()) return jsonResponse({ status: "error", message: "Name is required" }, 400);
      for (const u of [g.imageUrl, g.thumbUrl]) if (u && !cleanImageUrl(u)) return jsonResponse({ status: "error", message: "Invalid image URL" }, 400);
      if (g.kind === "embroidery" && !g.designId) return jsonResponse({ status: "error", message: "Pick a design for an embroidery option" }, 400);
      if (g.id) { await updateGraphic(env.DB, Number(g.id), g); audit({ orgId: body.org, orderId: null, action: "graphic.updated", detail: { id: Number(g.id), name: g.name } }); return jsonResponse({ status: "ok", id: Number(g.id) }); }
      const id = await createGraphic(env.DB, body.org, g);
      audit({ orgId: body.org, orderId: null, action: "graphic.created", detail: { id, name: g.name } });
      return jsonResponse({ status: "ok", id });
    }
    if (body.action === "setProductGraphicColorBlocked") {
      if (!body.org || !body.productId || !body.graphicId) return jsonResponse({ status: "error", message: "org, productId and graphicId required" }, 400);
      let list;
      try { list = await setProductGraphicColorBlocked(env.DB, body.org, String(body.productId), Number(body.graphicId), body.color, body.blocked !== false); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not update the product" }, 400); }
      audit({ orgId: body.org, orderId: null, action: body.blocked !== false ? "product.graphic_color_blocked" : "product.graphic_color_allowed",
        detail: { productId: String(body.productId), graphicId: Number(body.graphicId), color: String(body.color || "") } });
      return jsonResponse({ status: "ok", blockedGraphicColors: list });
    }
    if (body.action === "deleteGraphic") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      try { await deleteGraphic(env.DB, id); audit({ orgId: body.org || null, orderId: null, action: "graphic.deleted", detail: { id } }); return jsonResponse({ status: "ok" }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
    }
    if (body.action === "getTierPrices") {
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      return jsonResponse({ status: "ok", ...(await getTierPrices(env.DB, body.org)) });
    }
    if (body.action === "setTierPrices") {
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      // The shop's reorder QR code is a transfer it can use (migrations/0047); "" / null = none.
      let qrTransfer;
      if (body.reorderQrTransferId !== undefined) {
        qrTransfer = body.reorderQrTransferId == null || body.reorderQrTransferId === "" ? null : Number(body.reorderQrTransferId);
        if (qrTransfer != null && !(await listTransfers(env.DB, body.org)).some(t => t.id === qrTransfer)) {
          return jsonResponse({ status: "error", message: "That transfer isn't available to this shop — pick another." }, 400);
        }
      }
      await setTierPrices(env.DB, body.org, body.tiers || {});
      if (qrTransfer !== undefined) await setOrgReorderQrTransfer(env.DB, body.org, qrTransfer);
      else if (body.reorderQrGraphicId !== undefined) await setOrgReorderQr(env.DB, body.org, body.reorderQrGraphicId);   // the old way
      audit({ orgId: body.org, orderId: null, action: "org.tier_prices_set", detail: { tiers: body.tiers || {},
        ...(qrTransfer !== undefined ? { reorderQrTransferId: qrTransfer } : { reorderQrGraphicId: body.reorderQrGraphicId ?? null }) } });
      return jsonResponse({ status: "ok", ...(await getTierPrices(env.DB, body.org)) });
    }

    // ---- Transfer-sheet inventory (migrations/0036) ----
    if (body.action === "listTransfers") {
      return jsonResponse({ status: "ok", transfers: await listTransfers(env.DB, body.org || null) });
    }
    if (body.action === "saveTransfer") {
      const t = body.transfer || {};
      if (!String(t.name || "").trim()) return jsonResponse({ status: "error", message: "Name is required" }, 400);
      if (t.id) { await updateTransfer(env.DB, Number(t.id), t); audit({ orgId: null, orderId: null, action: "transfer.updated", detail: { id: Number(t.id), name: t.name } }); return jsonResponse({ status: "ok", id: Number(t.id) }); }
      const id = await createTransfer(env.DB, t);
      audit({ orgId: null, orderId: null, action: "transfer.created", detail: { id, name: t.name } });
      return jsonResponse({ status: "ok", id });
    }
    if (body.action === "deleteTransfer") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      try { await deleteTransfer(env.DB, id); audit({ orgId: null, orderId: null, action: "transfer.deleted", detail: { id } }); return jsonResponse({ status: "ok" }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
    }
    if (body.action === "receiveTransferSheet") {
      const locked = await periodGuard(body); if (locked) return locked;
      const date = String(body.receivedAt || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z"))) return jsonResponse({ status: "error", message: "Date must be YYYY-MM-DD" }, 400);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return jsonResponse({ status: "error", message: "Add at least one row" }, 400);
      const totalCents = Math.round((Number(body.total) || 0) * 100);
      // The sheet is split three ways, each a percentage of it: rows (become inventory), WRITTEN OFF (an expense)
      // and PERSONAL use (an owner draw). The three must add up to 100% — nothing is spread over the rows by
      // default, and nothing is left unaccounted for. Written off / personal each need a description.
      const counted = rows.filter(r => Number(r.transferId) && Math.floor(Number(r.count) || 0) > 0);
      if (!counted.length) return jsonResponse({ status: "error", message: "Add at least one row with a count" }, 400);
      const pcts = counted.map(r => Math.max(0, Number(r.pctOfSheet) || 0));
      const rowsPct = pcts.reduce((a, x) => a + x, 0);
      const wo = body.writeoff && typeof body.writeoff === "object" ? body.writeoff : {};
      const pe = body.personal && typeof body.personal === "object" ? body.personal : {};
      const woPct = Math.max(0, Number(wo.pct) || 0), pePct = Math.max(0, Number(pe.pct) || 0);
      const woWhat = String(wo.description || "").trim().slice(0, 200), peWhat = String(pe.description || "").trim().slice(0, 200);
      const allPct = rowsPct + woPct + pePct, fmtPct = (x) => (Math.round(x * 100) / 100).toString() + "%";
      if (woPct > 100 || pePct > 100 || allPct > 100 + SHEET_PCT_TOLERANCE) {
        return jsonResponse({ status: "error", message: `The rows${woPct || pePct ? ", written-off and personal parts" : ""} add up to ${fmtPct(allPct)} — more than the whole sheet. Reduce them to 100% in total.` }, 400);
      }
      if (allPct < 100 - SHEET_PCT_TOLERANCE) {
        return jsonResponse({ status: "error", message: `Only ${fmtPct(allPct)} of the sheet is accounted for. The rows, the written-off part and the personal part must add up to 100% — ${fmtPct(100 - allPct)} is left over.` }, 400);
      }
      if ((woPct > 0 || pePct > 0) && !featureOn("bookkeeping")) {
        return jsonResponse({ status: "error", feature: "bookkeeping", message: "A written-off or personal part of the sheet is recorded as an expense or an owner draw, which need Bookkeeping. It is turned off — turn it on under Tools → Global settings → Features, or put the whole sheet into stock." }, 403);
      }
      if (woPct > 0 && !woWhat) return jsonResponse({ status: "error", message: "Describe what was written off (it's kept on the record)." }, 400);
      if (pePct > 0 && !peWhat) return jsonResponse({ status: "error", message: "Describe the personal part (it's kept on the record)." }, 400);
      if ((woPct > 0 || pePct > 0) && !body.paidPersonally && !Number(body.accountId)) {
        return jsonResponse({ status: "error", message: "Choose what the sheet was paid from, so the written-off / personal part can be recorded." }, 400);
      }
      let woCat = null;
      if (woPct > 0) {
        woCat = await getExpenseCategory(env.DB, Number(wo.categoryId));
        if (!woCat) return jsonResponse({ status: "error", message: "Choose an expense category for the written-off part" }, 400);
      }
      const { writeoffCents, personalCents } = transferSheetShares(pcts, woPct, pePct, totalCents);
      const ids = await receiveTransferSheet(env.DB, { rows, totalCents, writeoffPct: woPct, personalPct: pePct,
        vendor: body.vendor, vendorRef: body.vendorRef, receivedAt: date,
        accountId: body.accountId, paidPersonally: !!body.paidPersonally, note: body.note, receiptKey: body.receiptKey, receiptName: body.receiptName });
      const sheet = (String(body.vendor || "").trim() || "Transfer sheet").slice(0, 120) + (body.vendorRef ? ` #${String(body.vendorRef).slice(0, 60)}` : "");
      const accountId = body.paidPersonally ? null : Number(body.accountId);
      let woRecorded = null, peRecorded = null;
      if (woPct > 0) {
        woRecorded = { pct: Math.round(woPct * 100) / 100, amount: writeoffCents / 100, description: woWhat };
        if (writeoffCents > 0) {
          woRecorded.expenseId = await saveExpense(env.DB, 0, { date, description: `Transfer sheet written off — ${woWhat} (${sheet})`, categoryId: woCat.id, amount: writeoffCents / 100,
            vendor: String(body.vendor || "").trim().slice(0, 100), businessUsePct: 100, receiptKey: String(body.receiptKey || ""), receiptName: String(body.receiptName || "").slice(0, 200),
            placedInService: woCat.deductionType === "depreciation" ? date : null, depMethod: woCat.deductionType === "depreciation" ? "ask_cpa" : null,
            vendorChargedTax: true, accountId, paidPersonally: !!body.paidPersonally });
        }
      }
      if (pePct > 0) {
        peRecorded = { pct: Math.round(pePct * 100) / 100, amount: personalCents / 100, description: peWhat };
        if (body.paidPersonally) peRecorded.notRecorded = true; // paid with personal funds: not a business transaction at all
        else if (personalCents > 0) {
          peRecorded.ownerEntryId = await saveMoneyEntry(env.DB, "owner", 0, { date, amount: personalCents / 100, kind: "draw", accountId, note: `Personal items — ${peWhat} (${sheet})` });
        }
      }
      audit({ orgId: null, orderId: null, action: "transfer.received", detail: { rows, total: Number(body.total) || 0, vendorRef: body.vendorRef || "",
        ...(woRecorded ? { writeoff: woRecorded } : {}), ...(peRecorded ? { personal: peRecorded } : {}) } });
      return jsonResponse({ status: "ok", ids, writeoff: woRecorded, personal: peRecorded, transfers: await listTransfers(env.DB, body.org || null) });
    }
    if (body.action === "writeOffTransfers") {
      const locked = await periodGuard(body); if (locked) return locked;
      await writeOffTransfers(env.DB, { transferId: Number(body.transferId), qty: Number(body.qty), note: body.note, occurredAt: body.occurredAt });
      audit({ orgId: null, orderId: null, action: "transfer.writeoff", detail: { transferId: Number(body.transferId), qty: Number(body.qty), note: body.note || "" } });
      return jsonResponse({ status: "ok", transfers: await listTransfers(env.DB, body.org || null) });
    }
    if (body.action === "getTransferMovements") {
      return jsonResponse({ status: "ok", movements: await getTransferMovements(env.DB, Number(body.transferId)) });
    }
    // Void a mistaken transfer movement. Held to the same rules as voiding a blank movement: a closed month
    // refuses it (periodGuard), and the audit row is written FIRST — no record, no change.
    if (body.action === "voidTransferMovement") {
      const locked = await periodGuard(body); if (locked) return locked;
      const movementId = Number(body.movementId);
      if (!movementId || !Number.isInteger(movementId)) return jsonResponse({ status: "error", message: "Invalid movement ID" }, 400);
      const mv = await getTransferMovementById(env.DB, movementId);
      if (!mv) return jsonResponse({ status: "error", message: "Entry not found" }, 404);
      if (mv.voidedAt) return jsonResponse({ status: "error", message: "That entry is already voided" }, 400);
      if (!["purchase", "adjust", "writeoff"].includes(mv.kind)) {
        return jsonResponse({ status: "error", message: "This entry was generated automatically (from an order) and can't be voided here — fix the order instead." }, 400);
      }
      const reason = String(body.reason || "Entered by mistake").trim().slice(0, 300);
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: "transfer.movement_voided",
        detail: { movementId, reason, transferName: mv.transferName, occurredAt: mv.occurredAt, unitCost: mv.unitCost, vendor: mv.vendor, vendorRef: mv.vendorRef,
          before: { transferId: mv.transferId, qtyDelta: mv.qtyDelta, kind: mv.kind } } });
      if (auditErr) return auditErr;
      const row = await voidTransferMovement(env.DB, movementId, reason);
      if (!row) return jsonResponse({ status: "error", message: "That entry was just changed — reload the history and try again." }, 409);
      return jsonResponse({ status: "ok" });
    }

    // Undo a transfer void. Same safeguards as restoring a blank movement: closed months refuse it, the
    // audit row is written first, and restoring a write-off can't take stock below zero.
    if (body.action === "restoreTransferMovement") {
      const locked = await periodGuard(body); if (locked) return locked;
      const movementId = Number(body.movementId);
      if (!movementId || !Number.isInteger(movementId)) return jsonResponse({ status: "error", message: "Invalid movement ID" }, 400);
      const mv = await getTransferMovementById(env.DB, movementId);
      if (!mv) return jsonResponse({ status: "error", message: "Entry not found" }, 404);
      const blocker = await getTransferRestoreBlocker(env.DB, mv);
      if (blocker) return jsonResponse({ status: "error", message: blocker }, mv.voidedAt ? 409 : 400);
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: "transfer.movement_restored",
        detail: { movementId, transferId: mv.transferId, transferName: mv.transferName, qtyDelta: mv.qtyDelta, unitCost: mv.unitCost, kind: mv.kind,
          vendor: mv.vendor, vendorRef: mv.vendorRef, occurredAt: mv.occurredAt, wasVoidedAt: mv.voidedAt, wasVoidReason: mv.voidReason } });
      if (auditErr) return auditErr;
      const restored = await restoreTransferMovement(env.DB, movementId);
      if (!restored) return jsonResponse({ status: "error", message: "That entry was just changed — reload the history and try again." }, 409);
      return jsonResponse({ status: "ok", movements: await getTransferMovements(env.DB, mv.transferId), transfers: await listTransfers(env.DB, body.org || null) });
    }

    // ---- Run Transfer Sheets + gang sheet (migrations/0036) ----
    if (body.action === "getTransferQueue") {
      return jsonResponse({ status: "ok", ...(await getTransferQueue(env.DB)), paidUnrun: await getPaidUnrunOrders(env.DB) });
    }
    if (body.action === "getGangSheet") {
      return jsonResponse({ status: "ok", rows: await getGangSheet(env.DB) });
    }
    if (body.action === "setTransferReceived") {
      if (!body.itemId) return jsonResponse({ status: "error", message: "itemId required" }, 400);
      await setTransferReceived(env.DB, Number(body.itemId), body.received !== false);
      audit({ orgId: body.org || null, orderId: body.orderId || null, action: body.received !== false ? "order.transfer_received" : "order.transfer_unreceived", detail: { itemId: Number(body.itemId) } });
      return jsonResponse({ status: "ok" });
    }
    // Run Transfer Sheets → "Mark transfers applied" on a line that is also embroidered (and its undo).
    if (body.action === "setTransfersApplied") {
      if (!body.orderId || !body.itemId) return jsonResponse({ status: "error", message: "orderId and itemId required" }, 400);
      try { await setTransfersApplied(env.DB, body.orderId, Number(body.itemId), body.applied !== false); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not update the line" }, 400); }
      audit({ orgId: body.org || null, orderId: body.orderId, action: body.applied !== false ? "order.transfers_applied" : "order.transfers_unapplied", detail: { itemId: Number(body.itemId) } });
      return jsonResponse({ status: "ok", applied: body.applied !== false });
    }
    // Bring an open order's lines up to date with the catalog (graphics fixed after it was placed,
    // a reorder QR turned on). `preview` only reports what would change.
    if (body.action === "refreshOrderFromCatalog") {
      if (!body.orderId) return jsonResponse({ status: "error", message: "orderId required" }, 400);
      let res;
      try { res = await refreshOrderLinesFromCatalog(env.DB, String(body.orderId), !body.preview); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not update the order" }, 400); }
      if (!body.preview && res.lines.length) audit({ orgId: body.org || null, orderId: String(body.orderId), action: "order.lines_refreshed", detail: { lines: res.lines } });
      return jsonResponse({ status: "ok", lines: res.lines, applied: !body.preview });
    }
    if (body.action === "makeTransferLine") {
      if (!body.orderId || !body.itemId) return jsonResponse({ status: "error", message: "orderId and itemId required" }, 400);
      let res;
      // A line that's also embroidered isn't MADE from here — Run Order makes it when its embroidery is
      // finished. From here only its transfers are marked applied (migrations/0048).
      if (await lineHasEmbroidery(env.DB, Number(body.itemId))) {
        try { await setTransfersApplied(env.DB, body.orderId, Number(body.itemId), true); }
        catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not mark the transfers applied" }, 400); }
        audit({ orgId: body.org || null, orderId: body.orderId, action: "order.transfers_applied", detail: { itemId: Number(body.itemId) } });
        return jsonResponse({ status: "ok", applied: true, orderComplete: false });
      }
      try { res = await makeTransferLine(env.DB, body.orderId, Number(body.itemId)); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not mark made" }, 400); }
      audit({ orgId: body.org || null, orderId: body.orderId, action: "order.transfer_made", detail: { itemId: Number(body.itemId), orderComplete: !!res.orderComplete } });
      return jsonResponse({ status: "ok", orderComplete: !!res.orderComplete });
    }

    if (body.action === "listDesigns") {
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      return jsonResponse({ status: "ok", designs: await listDesigns(env.DB, body.org) });
    }

    if (body.action === "getDesign") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      const design = await getDesign(env.DB, id);
      if (!design) return jsonResponse({ status: "error", message: "Design not found" }, 404);
      const versions = await listDesignVersions(env.DB, id);
      return jsonResponse({ status: "ok", design, versions });
    }

    if (body.action === "saveDesign") {
      const d = body.design || {};
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      if (!String(d.name || "").trim()) return jsonResponse({ status: "error", message: "Name is required" }, 400);
      const before = d.id ? await getDesign(env.DB, d.id) : null;
      let id;
      try { id = await saveDesign(env.DB, body.org, d); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
      // Making a design global (every shop) or shop-only again is worth a trail (migrations/0033).
      const after = await getDesign(env.DB, id);
      if (after && after.isGlobal !== (before ? before.isGlobal : false))
        audit({ orgId: body.org, orderId: null, action: after.isGlobal ? "design.made_global" : "design.made_shop_only",
          detail: { designId: id, name: after.name, homeOrgId: after.orgId } });
      return jsonResponse({ status: "ok", id });
    }

    if (body.action === "deleteDesign") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      try { await deleteDesign(env.DB, id); return jsonResponse({ status: "ok" }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
    }

    if (body.action === "setProductDesign") {
      if (!body.org || !body.productId) return jsonResponse({ status: "error", message: "Missing org or productId" }, 400);
      await setProductDesign(env.DB, body.org, body.productId, body.designId || null);
      return jsonResponse({ status: "ok" });
    }

    // What's missing in the catalog (⚠ markers on Manage catalog / Products / Designs).
    if (body.action === "getCatalogIssues") {
      return jsonResponse({ status: "ok", issues: await getCatalogIssues(env.DB, body.org || null) });
    }

    // A product's designs in run order, one MAIN (migrations/0032).
    if (body.action === "listProductDesigns") {
      if (!body.org || !body.productId) return jsonResponse({ status: "error", message: "Missing org or productId" }, 400);
      return jsonResponse({ status: "ok", designs: await listProductDesigns(env.DB, body.org, body.productId) });
    }
    if (body.action === "setProductDesigns") {
      if (!body.org || !body.productId) return jsonResponse({ status: "error", message: "Missing org or productId" }, 400);
      const before = await listProductDesigns(env.DB, body.org, body.productId);
      try { await setProductDesigns(env.DB, body.org, body.productId, body.designs); }
      catch (e) { return jsonResponse({ status: "error", message: e.message }, 400); }
      const after = await listProductDesigns(env.DB, body.org, body.productId);
      audit({ orgId: body.org, orderId: null, action: "product.designs_set", detail: { productId: body.productId,
        from: before.map(d => ({ designId: d.designId, placement: d.placement, isMain: d.isMain })),
        to: after.map(d => ({ designId: d.designId, placement: d.placement, isMain: d.isMain })) } });
      return jsonResponse({ status: "ok", designs: after });
    }

    // The order-specific design for a typed-in-personalization line (migrations/0032).
    if (body.action === "getOrderItemDesigns") {
      const itemId = Number(body.itemId);
      if (!itemId) return jsonResponse({ status: "error", message: "itemId required" }, 400);
      return jsonResponse({ status: "ok", designs: await listOrderItemDesigns(env.DB, itemId) });
    }
    if (body.action === "saveOrderItemDesign") {
      const itemId = Number(body.itemId);
      if (!itemId) return jsonResponse({ status: "error", message: "itemId required" }, 400);
      if (!/^order-files\/\d+\/[a-z0-9]{1,32}\.[a-z0-9]{1,10}$/.test(String(body.machineFileKey || ""))) return jsonResponse({ status: "error", message: "Machine file required" }, 400);
      if (body.designFileKey && !/^order-files\/\d+\/[a-z0-9]{1,32}\.[a-z0-9]{1,10}$/.test(String(body.designFileKey))) return jsonResponse({ status: "error", message: "Invalid design file" }, 400);
      const item = await getOrderItemById(env.DB, itemId);
      if (!item) return jsonResponse({ status: "error", message: "Line item not found" }, 404);
      // Which location of the line it's for (migrations/0055): one carrying the customer's own stitched
      // design, or '' for the line's one design (a typed-in name).
      const location = body.location == null ? "" : String(body.location);
      if (location && !((item.config && item.config.locations) || []).some(l => l && l.custom && l.kind === "embroidery" && String(l.location) === location))
        return jsonResponse({ status: "error", message: "That location doesn't have the customer's design on this item." }, 400);
      const id = await addOrderItemDesign(env.DB, itemId, { ...body, location });
      audit({ orgId: body.org || null, orderId: item.orderId || null, action: "order.item_design_uploaded",
        detail: { itemId, ...(location ? { location } : {}), machineFileName: body.machineFileName || "", threads: (body.threadColors || []).length } });
      return jsonResponse({ status: "ok", id });
    }

    // Records a design file already uploaded to R2 via /api/design (fileKey/fileName/fileExt),
    // plus this version's thread-color map and notes. The upload and the DB write are two
    // separate requests, same split as receipt.js's callers.
    if (body.action === "saveDesignVersion") {
      const designId = Number(body.designId);
      if (!designId) return jsonResponse({ status: "error", message: "designId required" }, 400);
      if (!String(body.designFileKey || "").trim()) return jsonResponse({ status: "error", message: "Design file required" }, 400);
      if (!String(body.machineFileKey || "").trim()) return jsonResponse({ status: "error", message: "Machine file required" }, 400);
      const id = await addDesignVersion(env.DB, designId, body);
      return jsonResponse({ status: "ok", id });
    }

    if (body.action === "updateDesignVersionColors") {
      const versionId = Number(body.versionId);
      if (!versionId) return jsonResponse({ status: "error", message: "versionId required" }, 400);
      await updateDesignVersionThreads(env.DB, versionId, Array.isArray(body.threadColors) ? body.threadColors : []);
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "getOrderItemFiles") {
      const itemId = Number(body.itemId);
      if (!itemId) return jsonResponse({ status: "error", message: "itemId required" }, 400);
      return jsonResponse({ status: "ok", files: await getOrderItemFiles(env.DB, itemId) });
    }

    if (body.action === "saveOrderItemFile") {
      const itemId = Number(body.itemId);
      if (!itemId) return jsonResponse({ status: "error", message: "itemId required" }, 400);
      if (!String(body.fileKey || "").trim()) return jsonResponse({ status: "error", message: "fileKey required" }, 400);
      // A file added here is the shop's; only placing an order records a customer's (migrations/0054).
      const id = await addOrderItemFile(env.DB, itemId, { ...body, uploadedBy: "admin" });
      return jsonResponse({ status: "ok", id });
    }

    if (body.action === "deleteOrderItemFile") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      // The customer's own design is what the line is made from (its copy of its options names it), so it stays.
      const f = await env.DB.prepare("SELECT uploadedBy FROM order_item_files WHERE id=?").bind(id).first();
      if (f && f.uploadedBy === "customer") return jsonResponse({ status: "error", message: "The customer's own design can't be deleted — it's what this item is made from." }, 409);
      await deleteOrderItemFile(env.DB, id);
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "listMachines") {
      return jsonResponse({ status: "ok", machines: await listMachines(env.DB) });
    }

    if (body.action === "getMachine") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      const machine = await getMachine(env.DB, id);
      if (!machine) return jsonResponse({ status: "error", message: "Machine not found" }, 404);
      return jsonResponse({ status: "ok", machine });
    }

    if (body.action === "saveMachine") {
      const m = body.machine || {};
      if (!String(m.name || "").trim()) return jsonResponse({ status: "error", message: "Name is required" }, 400);
      if (!m.needleCount || Number(m.needleCount) <= 0) return jsonResponse({ status: "error", message: "Needle count must be a positive number" }, 400);
      const id = await saveMachine(env.DB, m);
      return jsonResponse({ status: "ok", id });
    }

    if (body.action === "deleteMachine") {
      const id = Number(body.id);
      if (!id) return jsonResponse({ status: "error", message: "id required" }, 400);
      await deleteMachine(env.DB, id);
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "setMachineHoop") {
      const machineId = Number(body.machineId);
      if (!machineId) return jsonResponse({ status: "error", message: "machineId required" }, 400);
      await setMachineHoop(env.DB, machineId, body.hoopId ?? null);
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "setMachineNeedle") {
      const machineId = Number(body.machineId), needle = Number(body.needle);
      if (!machineId || !needle) return jsonResponse({ status: "error", message: "machineId and needle required" }, 400);
      await setMachineNeedle(env.DB, machineId, needle, body.threadId ?? null);
      return jsonResponse({ status: "ok" });
    }

    // The scanner (local agent's UDP discovery) reports what MACs are present at what IPs; this
    // matches them against stored machines by MAC and refreshes each one's IP + verifiedAt. Called
    // both from the Scan screen and from the auto-rediscovery that runs before a list/upload when a
    // machine's verifiedAt is stale. Returns the full, updated machine list so the client can act
    // on the fresh IPs immediately.
    if (body.action === "recordMachineDiscovery") {
      await recordMachineDiscovery(env.DB, body.discovered || []);
      return jsonResponse({ status: "ok", machines: await listMachines(env.DB) });
    }

    if (body.action === "getProductionQueue") {
      return jsonResponse({ status: "ok", queue: await getProductionQueue(env.DB), waitingOnBlanks: await getOrdersAwaitingBlanks(env.DB), paidUnrun: await getPaidUnrunOrders(env.DB),
        needleSizes: await listNeedleSizes(env.DB) });
    }

    // Marks ONE physical piece of a line item manufactured (per-piece, so a qty>1 line can be run
    // across machines and finished independently) — consumes one blank and bumps the line's
    // manufacturedQty; the order-level manufacturedAt is stamped only once every active line is
    // fully made (markItemPieceManufactured). If a machine was agreed on, its mounted hoop is
    // brought up to date with what was just run. The needle LOADOUT is deliberately NOT written:
    // a design's threadColors is a colour SEQUENCE, not a map of which physical needle holds which
    // colour, so the operator maintains the loadout on the Machines screen and readiness matches
    // colours to whatever needles actually carry them.
    if (body.action === "markManufacturedOnMachine") {
      if (!body.org || !body.orderId || !body.itemId) return jsonResponse({ status: "error", message: "Missing org, orderId or itemId" }, 400);
      let res;
      try { res = await markItemPieceManufactured(env.DB, body.orderId, Number(body.itemId)); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not mark manufactured" }, 400); }
      audit({ orgId: body.org, orderId: body.orderId, action: "order.piece_manufactured",
        detail: { itemId: Number(body.itemId), orderComplete: !!res.orderComplete } });
      const machineId = Number(body.machineId) || 0;
      if (machineId && body.hoopId !== undefined) {
        await setMachineHoop(env.DB, machineId, body.hoopId);
        audit({ orgId: body.org, orderId: body.orderId, action: "machine.run_update",
          detail: { machineId, hoopId: body.hoopId ?? null } });
      }
      return jsonResponse({ status: "ok", orderComplete: !!res.orderComplete });
    }

    // ---- Run tracking (migrations/0030) -----------------------------------
    if (body.action === "listAbortReasons") {
      return jsonResponse({ status: "ok", reasons: await listAbortReasons(env.DB) });
    }
    if (body.action === "saveAbortReason") {
      const r = body.reason || {};
      if (!String(r.label || "").trim()) return jsonResponse({ status: "error", message: "Label is required" }, 400);
      if (r.id) await updateAbortReason(env.DB, r.id, r); else await createAbortReason(env.DB, r);
      audit({ orgId: null, orderId: null, action: "abort_reason." + (r.id ? "updated" : "created"), detail: { label: r.label } });
      return jsonResponse({ status: "ok", reasons: await listAbortReasons(env.DB) });
    }
    if (body.action === "deleteAbortReason") {
      await deleteAbortReason(env.DB, body.id);
      audit({ orgId: null, orderId: null, action: "abort_reason.deleted", detail: { id: Number(body.id) } });
      return jsonResponse({ status: "ok", reasons: await listAbortReasons(env.DB) });
    }
    if (body.action === "listActiveRuns") {
      return jsonResponse({ status: "ok", activeRuns: await listActiveRuns(env.DB) });
    }
    if (body.action === "startRun") {
      if (!body.org || !body.orderId || !body.itemId) return jsonResponse({ status: "error", message: "Missing org, orderId or itemId" }, 400);
      let started;
      try { started = await startHooping(env.DB, { orgId: body.org, orderId: body.orderId, itemId: Number(body.itemId), machineId: body.machineId,
        pieceNo: body.pieceNo, stepNo: body.stepNo, hoopId: body.hoopId }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not start the job" }, 400); }
      const runId = typeof started === "number" ? started : started.runId;
      audit({ orgId: body.org, orderId: body.orderId, action: "run.started", detail: { runId, itemId: Number(body.itemId), machineId: body.machineId ?? null,
        pieceNo: started.pieceNo ?? null, stepNo: started.stepNo ?? null } });
      return jsonResponse({ status: "ok", runId, pieceNo: started.pieceNo ?? null, stepNo: started.stepNo ?? null });
    }
    // What the finish prompt shows first: this run's start, and the design's usual time on this machine.
    if (body.action === "getRunStats") {
      if (!body.runId) return jsonResponse({ status: "error", message: "Missing runId" }, 400);
      try { return jsonResponse({ status: "ok", stats: await getRunStats(env.DB, Number(body.runId)), issueKinds: RUN_ISSUE_KINDS }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Run not found" }, 404); }
    }
    if (body.action === "completeRun") {
      if (!body.runId) return jsonResponse({ status: "error", message: "Missing runId" }, 400);
      let res;
      // issues / issueNote / finishedAt come from the finish prompt (migrations/0046); all optional.
      try { res = await completeProductionRun(env.DB, Number(body.runId), { issues: body.issues, issueNote: body.issueNote, finishedAt: body.finishedAt }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not finish the job" }, 400); }
      audit({ orgId: body.org || null, orderId: body.orderId || null, action: "run.completed", detail: { runId: Number(body.runId),
        pieceNo: res.pieceNo ?? null, stepNo: res.stepNo ?? null, pieceComplete: !!res.pieceComplete, orderComplete: !!res.orderComplete,
        ...(Object.keys(res.issues || {}).length ? { issues: res.issues } : {}), ...(res.issueNote ? { issueNote: res.issueNote } : {}) } });
      return jsonResponse({ status: "ok", orderComplete: !!res.orderComplete, pieceComplete: !!res.pieceComplete,
        pieceNo: res.pieceNo ?? null, nextStepNo: res.nextStepNo ?? null });
    }
    // "Mark done (no timing)" for one hooping of one piece (pieceNo omitted = a new piece).
    if (body.action === "markHoopingDone") {
      if (!body.org || !body.orderId || !body.itemId) return jsonResponse({ status: "error", message: "Missing org, orderId or itemId" }, 400);
      let res;
      try { res = await markHoopingDone(env.DB, { orgId: body.org, orderId: body.orderId, itemId: Number(body.itemId), machineId: body.machineId,
        pieceNo: body.pieceNo, stepNo: body.stepNo, hoopId: body.hoopId }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not mark it done" }, 400); }
      audit({ orgId: body.org, orderId: body.orderId, action: "run.hooping_marked_done", detail: { itemId: Number(body.itemId),
        pieceNo: res.pieceNo, stepNo: res.stepNo, pieceComplete: !!res.pieceComplete, orderComplete: !!res.orderComplete, machineId: body.machineId ?? null } });
      return jsonResponse({ status: "ok", orderComplete: !!res.orderComplete, pieceComplete: !!res.pieceComplete, pieceNo: res.pieceNo, nextStepNo: res.nextStepNo ?? null });
    }
    if (body.action === "abortRun") {
      if (!body.runId) return jsonResponse({ status: "error", message: "Missing runId" }, 400);
      try { await abortProductionRun(env.DB, Number(body.runId), { abortReasonId: body.abortReasonId, abortNote: body.abortNote }); }
      catch (e) { return jsonResponse({ status: "error", message: e.message || "Could not abort the job" }, 400); }
      audit({ orgId: body.org || null, orderId: body.orderId || null, action: "run.aborted", detail: { runId: Number(body.runId), abortReasonId: body.abortReasonId ?? null, abortNote: body.abortNote || "" } });
      return jsonResponse({ status: "ok" });
    }
    if (body.action === "getRunReportByDesign") {
      return jsonResponse({ status: "ok", report: await getRunReportByDesign(env.DB, { from: body.from, to: body.to }) });
    }

    if (body.action === "importThreadChart") {
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
      if (!rows.length) return jsonResponse({ status: "error", message: "No rows to import" }, 400);
      for (const r of rows) {
        if (r.colorHex && !/^[0-9a-fA-F]{6}$/.test(r.colorHex)) return jsonResponse({ status: "error", message: `Invalid color for ${r.brand || "?"} ${r.code || "?"}` }, 400);
      }
      const result = await importThreadChart(env.DB, rows);
      audit({ orgId: null, orderId: null, action: "threads.imported", detail: { count: rows.length, created: result.created, updated: result.updated } });
      return jsonResponse({ status: "ok", ...result, threads: await listThreads(env.DB) });
    }

    // ---- Inventory movements & COGS (migrations/0009) ----------------------
    if (body.action === "receiveBlanks" || body.action === "receiveBlankOrder") {
      const locked = await periodGuard(body); if (locked) return locked;
    }
    if (body.action === "receiveBlankOrder") {
      // Blanks → Receive order: several blank types + R&D / personal parts in
      // one go — the same flow as Reconcile → Create… → Blank purchase.
      const bad = (message) => jsonResponse({ status: "error", message }, 400);
      const date = String(body.receivedAt || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + "T00:00:00Z"))) return bad("Date must be YYYY-MM-DD");
      if (date > new Date().toISOString().slice(0, 10)) return bad("The date can't be in the future");
      const paidPersonally = body.paidPersonally === true;
      // Without Bookkeeping there are no accounts to pay from, and the R&D / personal parts (an
      // expense and an owner draw) can't be recorded: the order is received as stock only.
      const books = featureOn("bookkeeping");
      if (!books && (Number(body.rdAmount) > 0 || Number(body.personalAmount) > 0)) {
        return jsonResponse({ status: "error", feature: "bookkeeping", message: "The R&D / testing and personal parts are recorded as an expense and an owner draw, which need Bookkeeping. It is turned off — turn it on under Tools → Global settings → Features, or receive only the blanks." }, 403);
      }
      let accountId = null;
      if (!paidPersonally && (books || body.accountId)) {
        const acct = body.accountId ? await getAccount(env.DB, body.accountId) : null;
        if (!acct || !acct.active) return bad("Choose what it was paid from");
        accountId = acct.id;
      }
      if (body.receiptKey && !/^receipts\/\d{4}\/[a-z0-9]{32}\.(jpg|png|webp|pdf)$/.test(String(body.receiptKey))) {
        return bad("Invalid receipt reference");
      }
      const plan = await planBlankOrder_(body);
      if (plan.error) return bad(plan.error);
      if (!plan.groups.length && !plan.rdTotal && !(plan.personalTotal && !paidPersonally)) return bad("Nothing to record — enter blanks or an R&D part");
      if (body.orderTotal != null && body.orderTotal !== "" && Math.round(Number(body.orderTotal) * 100) !== plan.totalCents) {
        return bad(`The parts add up to $${(plan.totalCents / 100).toFixed(2)}, but the order total is $${Number(body.orderTotal).toFixed(2)}`);
      }
      const { keys, parts } = await commitBlankOrder_(plan, { date, accountId, paidPersonally, fallbackName: "Blank order", source: { blankOrder: true } });
      audit({ orgId: null, orderId: null, action: "inventory.order_received", detail: { date, accountId, paidPersonally, keys, parts, total: plan.totalCents / 100 } });
      return jsonResponse({ status: "ok", parts, total: plan.totalCents / 100, blanks: await getAllBlanks(env.DB) });
    }
    if (body.action === "receiveBlanks") {
      const blankId = Number(body.blankId);
      const lines = Array.isArray(body.lines) ? body.lines.filter(l => Number(l.qty) > 0) : [];
      if (!blankId || !lines.length) return jsonResponse({ status: "error", message: "Enter a quantity for at least one size" }, 400);
      if (lines.some(l => !(Number(l.unitCost) >= 0) || !Number.isInteger(Number(l.qty)) || Number(l.qty) > 10000)) {
        return jsonResponse({ status: "error", message: "Quantities must be whole numbers and costs zero or more" }, 400);
      }
      const receivedAt = body.receivedAt && /^\d{4}-\d{2}-\d{2}$/.test(body.receivedAt) ? body.receivedAt + "T12:00:00.000Z" : undefined;
      const vendor = String(body.vendor || "").trim(), vendorRef = String(body.vendorRef || "").trim();
      const vendorChargedTax = body.vendorChargedTax === true;
      const paidPersonally = body.paidPersonally === true;
      let accountId = null;
      if (!paidPersonally && body.accountId) {
        const acct = await getAccount(env.DB, body.accountId);
        if (!acct || !acct.active) return jsonResponse({ status: "error", message: "Choose an active account" }, 400);
        accountId = acct.id;
      }
      // Shipping & other costs are added to the blanks' cost (landed cost),
      // spread over the sizes by value.
      const extraCost = Number(body.extraCost || 0);
      if (!(extraCost >= 0) || extraCost > 100000) return jsonResponse({ status: "error", message: "Shipping & other costs must be zero or more" }, 400);
      const landed = extraCost > 0
        ? landedCostLines(lines.map(l => ({ color: l.color || "", size: l.size, qty: Number(l.qty), cents: Number(l.qty) * Math.round(Number(l.unitCost) * 100) })), Math.round(extraCost * 100))
        : lines;
      await receiveBlanks(env.DB, { blankId, lines: landed, vendor, vendorRef, receivedAt, vendorChargedTax, accountId, paidPersonally,
        note: extraCost ? `Received (landed cost incl. $${extraCost.toFixed(2)} shipping & other costs)` : "Received" });
      audit({ orgId: null, orderId: null, action: "inventory.received", detail: { blankId, lines, extraCost, vendor, vendorRef, receivedAt: receivedAt || null, vendorChargedTax } });
      return jsonResponse({ status: "ok", blanks: await getAllBlanks(env.DB) });
    }
    if (body.action === "writeOffBlanks") {
      const locked = await periodGuard(body); if (locked) return locked;
      const blankId = Number(body.blankId), qty = Number(body.qty), size = String(body.size || "");
      if (!blankId || !Number.isInteger(qty) || qty <= 0) return jsonResponse({ status: "error", message: "Enter how many to write off" }, 400);
      // Omitted color falls back to the blank's legacy scalar color (single-color blanks).
      const color = body.color != null ? String(body.color)
        : ((await env.DB.prepare("SELECT color FROM blanks WHERE id=?").bind(blankId).first()) || {}).color || "";
      const sizeRow = await env.DB.prepare("SELECT quantity FROM blank_sizes WHERE blankId=? AND color=? AND size=?").bind(blankId, color, size).first();
      if (!sizeRow) return jsonResponse({ status: "error", message: "Choose a size on file for this blank" }, 400);
      if (qty > sizeRow.quantity) return jsonResponse({ status: "error", message: `Only ${sizeRow.quantity} on hand in that size` }, 400);
      let occurredAt;
      if (body.occurredAt) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.occurredAt)) return jsonResponse({ status: "error", message: "Date must be YYYY-MM-DD" }, 400);
        if (body.occurredAt > new Date().toISOString().slice(0, 10)) return jsonResponse({ status: "error", message: "The date can't be in the future" }, 400);
        occurredAt = body.occurredAt + "T12:00:00.000Z";
      }
      const note = String(body.note || "Write-off").trim().slice(0, 300);
      await writeOffBlanks(env.DB, { blankId, color, size, qty, note, occurredAt });
      audit({ orgId: null, orderId: null, action: "inventory.written_off", detail: { blankId, color, size, qty, note, occurredAt: occurredAt || null } });
      return jsonResponse({ status: "ok", blanks: await getAllBlanks(env.DB) });
    }
    if (body.action === "getBlankMovements") {
      return jsonResponse({ status: "ok", movements: await getBlankMovements(env.DB, Number(body.blankId)) });
    }
    if (body.action === "voidInventoryMovement") {
      const locked = await periodGuard(body); if (locked) return locked;
      const movementId = Number(body.movementId);
      if (!movementId || !Number.isInteger(movementId)) return jsonResponse({ status: "error", message: "Invalid movement ID" }, 400);
      const mv = await getInventoryMovementById(env.DB, movementId);
      if (!mv) return jsonResponse({ status: "error", message: "Entry not found" }, 404);
      if (mv.voidedAt) return jsonResponse({ status: "error", message: "That entry is already voided" }, 400);
      if (!["purchase", "adjust", "writeoff"].includes(mv.kind)) {
        return jsonResponse({ status: "error", message: "This entry was generated automatically (from an order) and can't be voided here — fix the order instead." }, 400);
      }
      const reason = String(body.reason || "Entered by mistake").trim().slice(0, 300);
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: "inventory.movement_voided",
        detail: { movementId, blankId: mv.blankId, blankName: mv.blankName, size: mv.size, qtyDelta: mv.qtyDelta, unitCost: mv.unitCost,
          kind: mv.kind, vendor: mv.vendor, vendorRef: mv.vendorRef, occurredAt: mv.occurredAt, reason } });
      if (auditErr) return auditErr;
      await voidInventoryMovement(env.DB, movementId, reason);
      return jsonResponse({ status: "ok", movements: await getBlankMovements(env.DB, mv.blankId), blanks: await getAllBlanks(env.DB) });
    }
    // Undo a void: the entry counts again. Same guards as voiding (closed months, audit written first).
    if (body.action === "restoreInventoryMovement") {
      const locked = await periodGuard(body); if (locked) return locked;
      const movementId = Number(body.movementId);
      if (!movementId || !Number.isInteger(movementId)) return jsonResponse({ status: "error", message: "Invalid movement ID" }, 400);
      const mv = await getInventoryMovementById(env.DB, movementId);
      if (!mv) return jsonResponse({ status: "error", message: "Entry not found" }, 404);
      const blocker = await getInventoryRestoreBlocker(env.DB, mv);
      if (blocker) return jsonResponse({ status: "error", message: blocker }, mv.voidedAt ? 409 : 400);
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: "inventory.movement_restored",
        detail: { movementId, blankId: mv.blankId, blankName: mv.blankName, size: mv.size, qtyDelta: mv.qtyDelta, unitCost: mv.unitCost,
          kind: mv.kind, vendor: mv.vendor, vendorRef: mv.vendorRef, occurredAt: mv.occurredAt, wasVoidedAt: mv.voidedAt, wasVoidReason: mv.voidReason } });
      if (auditErr) return auditErr;
      const restored = await restoreInventoryMovement(env.DB, movementId);
      if (!restored) return jsonResponse({ status: "error", message: "That entry was just changed — reload the history and try again." }, 409);
      return jsonResponse({ status: "ok", movements: await getBlankMovements(env.DB, mv.blankId), blanks: await getAllBlanks(env.DB) });
    }
    if (body.action === "previewBlankCatchUp") {
      const plan = await planBlankCatchUp(env.DB);
      const closed = new Set();
      for (const l of plan.lines) { const m = String(l.useDate).slice(0, 7); if (!closed.has(m) && await isMonthClosed(env.DB, m)) closed.add(m); }
      return jsonResponse({ status: "ok", lines: plan.lines.map(l => ({ ...l, unitCost: l.unitCostCents / 100, cost: l.costCents / 100, oldCost: l.oldCostCents == null ? null : l.oldCostCents / 100,
        locked: closed.has(String(l.useDate).slice(0, 7)) })),
        totalUnits: plan.totalUnits, total: plan.totalCents / 100, replacedEstimate: plan.replacedEstimateCents / 100, shortLines: plan.shortLines });
    }
    if (body.action === "applyBlankCatchUp") {
      const ids = Array.isArray(body.itemIds) ? body.itemIds.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 1000) : [];
      if (!ids.length) return jsonResponse({ status: "error", message: "Tick at least one order line" }, 400);
      const plan = await planBlankCatchUp(env.DB);
      const chosen = plan.lines.filter(l => ids.includes(l.itemId));
      if (!chosen.length) return jsonResponse({ status: "error", message: "Nothing to apply — those lines were already done or no longer qualify" }, 400);
      for (const m of [...new Set(chosen.map(l => String(l.useDate).slice(0, 7)))]) {
        if (await isMonthClosed(env.DB, m)) {
          const label = new Date(m + "-15T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
          return jsonResponse({ status: "error", message: `${label} is closed (already filed). Reopen it under Periods & Export, or untick those lines.` }, 409);
        }
      }
      const auditErr = await auditStrict({ orgId: null, orderId: null, action: "inventory.catch_up",
        detail: { lines: chosen.map(l => ({ itemId: l.itemId, orderId: l.orderId, blankId: l.blankId, blankSize: l.blankSize, qty: l.qty, unitCostCents: l.unitCostCents, oldCostCents: l.oldCostCents, useDate: l.useDate })) } });
      if (auditErr) return auditErr;
      const r = await applyBlankCatchUp(env.DB, chosen.map(l => l.itemId));
      return jsonResponse({ status: "ok", applied: r.applied.length, totalUnits: r.totalUnits, total: r.totalCents / 100, blanks: await getAllBlanks(env.DB) });
    }
    if (body.action === "getInventoryReport") {
      const dateFrom = String(body.dateFrom || ""), dateTo = String(body.dateTo || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        return jsonResponse({ status: "error", message: "Invalid date range — expected YYYY-MM-DD" }, 400);
      }
      // Beginning inventory = end of the day before dateFrom; ending = end of dateTo.
      const dayBefore = new Date(Date.parse(dateFrom + "T00:00:00.000Z") - 1).toISOString();
      const [beginning, ending, cogs, taxedResale, tBeginning, tEnding, tCogs] = await Promise.all([
        getInventoryValuation(env.DB, dayBefore),
        getInventoryValuation(env.DB, dateTo + "T23:59:59.999Z"),
        getCogsReport(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z"),
        getTaxedResalePurchases(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z"),
        getTransferValuation(env.DB, dayBefore),
        getTransferValuation(env.DB, dateTo + "T23:59:59.999Z"),
        getTransferCogs(env.DB, dateFrom + "T00:00:00.000Z", dateTo + "T23:59:59.999Z"),
      ]);
      const sum = (k) => Math.round(cogs.rows.reduce((a, r) => a + r[k] * 100, 0)) / 100;
      const tsum = (k) => Math.round(tCogs.reduce((a, r) => a + r[k] * 100, 0)) / 100;
      // Transfer-sheet inventory is a parallel section (migrations/0036), same beginning/purchases −
      // COGS − write-offs = ending shape as blanks.
      const transfers = { beginning: tBeginning, ending: tEnding, cogs: tCogs,
        totals: { cogs: tsum("cogs"), purchases: tsum("purchases"), writeoffs: tsum("writeoffs") } };
      return jsonResponse({ status: "ok", dateFrom, dateTo, beginning, ending, cogs, taxedResale, transfers,
        totals: { cogs: sum("cogs"), estimatedPart: sum("estimatedPart"), purchases: sum("purchases"), writeoffs: sum("writeoffs") } });
    }

    if (body.action === "getBlankLinks") {
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      const links = await getBlankLinks(env.DB, body.org);
      return jsonResponse({ status: "ok", links });
    }

    if (body.action === "setBlankLink") {
      const { org, productId, productColor, productSize, blankId, blankColor, blankSize } = body;
      if (!org || !productId || !blankId) return jsonResponse({ status: "error", message: "org, productId, blankId required" }, 400);
      await setBlankLink(env.DB, org, productId, String(productColor || ""), productSize || "", Number(blankId), String(blankColor || ""), blankSize || "");
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "deleteBlankLink") {
      const { org, productId, productColor, productSize } = body;
      if (!org || !productId) return jsonResponse({ status: "error", message: "org, productId required" }, 400);
      await deleteBlankLink(env.DB, org, productId, String(productColor || ""), productSize || "");
      return jsonResponse({ status: "ok" });
    }

    if (body.action === "mergeBlanks") {
      const targetId = Number(body.targetId);
      const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.map(Number).filter(Boolean) : [];
      if (!targetId || !sourceIds.length) return jsonResponse({ status: "error", message: "Pick a target blank and at least one to merge in" }, 400);
      const before = await getAllBlanks(env.DB);
      const names = before.filter(b => sourceIds.includes(b.id)).map(b => b.name || b.brand);
      const result = await mergeBlanks(env.DB, { targetId, sourceIds });
      audit({ orgId: null, orderId: null, action: "inventory.blanks_merged", detail: { targetId, sourceIds, mergedNames: names } });
      return jsonResponse({ status: "ok", ...result, blanks: await getAllBlanks(env.DB) });
    }

    if (body.action === "getReadyToShip") {
      if (!body.org) return jsonResponse({ status: "error", message: "org required" }, 400);
      const stock = await getReadyToShipByOrg(env.DB, body.org);
      return jsonResponse({ status: "ok", stock });
    }

    if (body.action === "setReadyToShipQty") {
      const { org, productId, size, quantity } = body;
      if (!org || !productId) return jsonResponse({ status: "error", message: "org, productId required" }, 400);
      if (quantity == null || Number(quantity) < 0) return jsonResponse({ status: "error", message: "quantity must be >= 0" }, 400);
      await upsertReadyToShipQty(env.DB, org, productId, size ?? "", quantity);
      return jsonResponse({ status: "ok" });
    }
  }

  // ---- publish — bump the catalog version to invalidate the edge cache -------
  if (body.action === "publish") {
    const denied = await requireAdmin(env, host, body.key, request, "Not available here.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const next = await bumpCatalogVersion(env.DB);
    invalidateCatalogVersionCache();
    return jsonResponse({ status: "ok", version: next });
  }

  // ---- sendDesignVerification — batch email design proofs to customers ---------
  if (body.action === "sendDesignVerification") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;

    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.filter(id => ORDER_ID_RE.test(id)) : [];
    if (!orderIds.length) return jsonResponse({ status: "error", message: "No valid order IDs provided" }, 400);

    const message = String(body.message || "").trim().slice(0, 5000);
    if (!message) return jsonResponse({ status: "error", message: "Message is required" }, 400);

    const imageUrls = Array.isArray(body.imageUrls)
      ? body.imageUrls.filter(u => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, 5)
      : [];

    let sent = 0, skipped = 0;
    const skippedReasons = [];

    for (const orderId of orderIds) {
      const order = await getOrderById(env.DB, orderId);
      if (!order) { skipped++; skippedReasons.push(orderId + ": not found"); continue; }
      if (!order.contact || !order.contact.includes("@")) {
        skipped++; skippedReasons.push(orderId + ": no email"); continue;
      }
      // The customer approves what will be stitched — so not before the typed-in names are digitized
      // and uploaded (migrations/0032), or an approval could land with nothing behind it.
      if (order.orderDesignsMissing > 0) {
        skipped++; skippedReasons.push(orderId + ": order design not uploaded yet"); continue;
      }

      let orgSubdomain = "";
      try {
        const org = await getOrgById(env.DB, order.orgId);
        if (org) orgSubdomain = org.subdomain;
      } catch (_) {}

      const token = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2))
        .replace(/[^a-z0-9]/gi, "").slice(0, 32).toLowerCase();

      const baseUrl = orgSubdomain
        ? `https://${orgSubdomain}.${rootDomain(env)}`
        : `https://${new URL(request.url).hostname}`;
      const verifyUrl = `${baseUrl}/?verify=${token}`;

      await createDesignVerification(env.DB, {
        token,
        orgId: order.orgId,
        orderId,
        customerEmail: order.contact,
        customerName: order.customerName,
        message,
        imagesJson: JSON.stringify(imageUrls),
        sentAt: new Date().toISOString(),
      });

      const emailSent = await sendDesignVerificationEmail(env, {
        customerName: order.customerName,
        customerEmail: order.contact,
        orderId,
        orgName: order.orgId,
        message,
        imageUrls,
        verifyUrl,
      });

      if (emailSent) sent++; else { skipped++; skippedReasons.push(orderId + ": email failed"); }
    }

    return jsonResponse({ status: "ok", sent, skipped, skippedReasons });
  }

  // ---- listDesignVerifications — latest verification per order for an org -----
  if (body.action === "listDesignVerifications") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
    const orgId = String(body.org || "").trim();
    if (!orgId) return jsonResponse({ status: "error", message: "org required" }, 400);
    const rows = await getLatestVerificationsByOrg(env.DB, orgId);
    return jsonResponse({ status: "ok", verifications: rows });
  }

  // ---- setShippingInfo — admin adds/updates address + weight on an order ------
  if (body.action === "setShippingInfo") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);

    const orderId = String(body.orderId || "").trim();
    if (!ORDER_ID_RE.test(orderId)) return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);

    const addr = body.shippingAddress;
    if (!addr || typeof addr !== "object") return jsonResponse({ status: "error", message: "shippingAddress required" }, 400);

    // Whitelist + state-vs-ZIP check (the state decides sales tax; see cleanShippingAddress).
    // Outside the US (Region → country OTHER) the postal code and region are free text and the
    // address isn't stamped "US".
    const usFormats = (await getLocaleSettings(env.DB)).country === "US";
    const ac = cleanShippingAddress(usFormats ? { ...addr, country: addr.country || "US" } : addr, usFormats ? "US" : "OTHER");
    if (ac.error) return jsonResponse({ status: "error", message: ac.error }, 400);
    const sanitizedAddr = ac.address || {};
    if (!sanitizedAddr.line1 || !sanitizedAddr.city || !sanitizedAddr.zip) {
      return jsonResponse({ status: "error", message: usFormats ? "Address requires line1, city, and zip" : "Address requires line1, city, and postal code" }, 400);
    }

    const totalWeightOz = Math.max(0, Number(body.totalWeightOz) || 0);
    const shippingCost = Math.max(0, Number(body.shippingCost) || 0);
    // Saving this form is the shop setting the order's shipping (at any amount, $0 included), so the
    // "Quote pending" note a quote-to-follow order was placed with never survives it.
    const shippingMethod = shownMethod_(String(body.shippingMethod || "").slice(0, 100));
    const parcelLength = Math.max(0, Number(body.parcelLength) || 0);
    const parcelWidth  = Math.max(0, Number(body.parcelWidth)  || 0);
    const parcelHeight = Math.max(0, Number(body.parcelHeight) || 0);

    await updateOrderShipping(env.DB, orderId, { shippingAddress: sanitizedAddr, totalWeightOz, shippingCost, shippingMethod, parcelLength, parcelWidth, parcelHeight });
    audit({ orgId: body.org || null, orderId, action: "order.shipping_set",
      detail: { shippingCost, shippingMethod, city: sanitizedAddr.city, state: sanitizedAddr.state } });
    return jsonResponse({ status: "ok", orderId, shippingAddress: sanitizedAddr, totalWeightOz, shippingCost, shippingMethod, parcelLength, parcelWidth, parcelHeight });
  }

  // ---- setShippingPaidAmount — admin manually corrects paid amount on an order -
  if (body.action === "setShippingPaidAmount") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }
    if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
    const orderId = String(body.orderId || "").trim();
    if (!ORDER_ID_RE.test(orderId)) return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);
    const amount = Math.max(0, Number(body.amount) || 0);
    await setShippingPaidAmount(env.DB, orderId, amount);
    return jsonResponse({ status: "ok", orderId, shippingPaidAmount: amount });
  }

  // ---- createShippingPaymentLink — Stripe session + email for shipping cost ---
  if (body.action === "createShippingPaymentLink") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
    if (!env.STRIPE_SECRET_KEY) return jsonResponse({ status: "error", message: "Stripe not configured" }, 500);

    const orderId = String(body.orderId || "").trim();
    if (!ORDER_ID_RE.test(orderId)) return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);

    const order = await getOrderById(env.DB, orderId);
    if (!order) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    if (!order.contact || !order.contact.includes("@")) {
      return jsonResponse({ status: "error", message: "No valid email address on file for this order" }, 400);
    }
    // Prefer the client-supplied cost (avoids D1 cross-request read inconsistency when
    // setShippingInfo and createShippingPaymentLink are two back-to-back requests).
    const clientCost = body.shippingCost != null ? Math.max(0, Number(body.shippingCost) || 0) : null;
    const shippingCost = (clientCost != null && clientCost > 0) ? clientCost : order.shippingCost;
    if (!shippingCost || shippingCost <= 0) {
      return jsonResponse({ status: "error", message: "No shipping cost set — save a shipping rate first" }, 400);
    }

    // Charge only the unpaid balance; reject if already fully paid.
    const alreadyPaid = Number(order.shippingPaidAmount) || 0;
    const owingAmount = Math.round((shippingCost - alreadyPaid) * 100) / 100;
    if (owingAmount <= 0) {
      return jsonResponse({ status: "error", message: "Shipping is already fully paid" }, 400);
    }

    // Build the success URL on the org's own subdomain
    let orgSubdomain = "";
    try {
      const org = await getOrgById(env.DB, order.orgId);
      if (org) orgSubdomain = org.subdomain || "";
    } catch (_) {}

    const origin = orgSubdomain
      ? `https://${orgSubdomain}.${rootDomain(env)}`
      : new URL(request.url).origin;
    const successUrl = origin + "/?stripe=success&orderId=" + encodeURIComponent(orderId) + "&org=" + encodeURIComponent(order.orgId);
    const cancelUrl  = origin + "/";

    const amountCents = Math.round(owingAmount * 100);
    const method = shownMethod_(order.shippingMethod) ? ` (${shownMethod_(order.shippingMethod)})` : "";
    const balanceNote = alreadyPaid > 0 ? ` — balance due ($${alreadyPaid.toFixed(2)} already paid)` : "";
    const params = {
      "payment_method_types[]": "card",
      "mode": "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(amountCents),
      "line_items[0][price_data][product_data][name]": "Shipping" + method,
      "line_items[0][price_data][product_data][description]": "Shipping for order " + orderId + balanceNote,
      "line_items[0][quantity]": "1",
      // Include orderId + orgId so the webhook can record the payment via resolveOrderRef.
      "metadata[type]": "shipping_payment",
      "metadata[orderId]": orderId,
      "metadata[orgId]": order.orgId,
      // Also on the PaymentIntent (copied to the Charge), so refund and
      // dispute events for this payment can be traced back to the order.
      "payment_intent_data[metadata][type]": "shipping_payment",
      "payment_intent_data[metadata][orderId]": orderId,
      "payment_intent_data[metadata][orgId]": order.orgId,
      "success_url": successUrl,
      "cancel_url": cancelUrl,
    };
    if (order.contact && order.contact.includes("@")) {
      params["customer_email"] = order.contact;
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });

    const session = await stripeRes.json();
    if (!session.url) {
      const msg = (session.error && session.error.message) ? session.error.message : "Unknown Stripe error";
      console.error("Stripe shipping session failed:", msg);
      return jsonResponse({ status: "error", message: "Could not create payment session: " + msg }, 500);
    }

    const customBody = String(body.emailBody || "").trim().slice(0, 3000) || null;
    const emailSent = await sendShippingPaymentEmail(env, {
      customerName: order.customerName,
      customerEmail: order.contact,
      orderId,
      shippingCost: owingAmount,
      shippingMethod: shownMethod_(order.shippingMethod),
      paymentUrl: session.url,
      customBody,
    });

    return jsonResponse({ status: "ok", url: session.url, emailSent });
  }

  // ---- updateOrderDate — admin edits the placedAt date on an order -------------
  if (body.action === "updateOrderDate") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    { const locked = await periodGuard(body); if (locked) return locked; }

    const orderId = String(body.orderId || "").trim();
    if (!ORDER_ID_RE.test(orderId)) return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);

    const dateStr = String(body.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return jsonResponse({ status: "error", message: "Invalid date — expected YYYY-MM-DD" }, 400);
    }
    const parsed = new Date(dateStr + "T12:00:00Z");
    if (isNaN(parsed.getTime())) {
      return jsonResponse({ status: "error", message: "Invalid date" }, 400);
    }
    const placedAt = parsed.toISOString();
    const prevOrder = await getOrderById(env.DB, orderId);
    if (!prevOrder) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    const auditErr = await auditStrict({ orgId: prevOrder.orgId, orderId, action: "order.date_changed",
      detail: { from: prevOrder.placedAt, to: placedAt } });
    if (auditErr) return auditErr;
    await updateOrderPlacedAt(env.DB, orderId, placedAt);
    return jsonResponse({ status: "ok", orderId, placedAt });
  }

  // ---- setOrderDueDate — admin sets/clears the optional due date ---------------
  if (body.action === "setOrderDueDate") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const orderId = String(body.orderId || "").trim();
    if (!ORDER_ID_RE.test(orderId)) return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);
    const raw = body.dueDate == null ? "" : String(body.dueDate).trim();
    if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return jsonResponse({ status: "error", message: "Invalid date — expected YYYY-MM-DD" }, 400);
    const prev = await getOrderById(env.DB, orderId);
    if (!prev) return jsonResponse({ status: "error", message: "Order not found" }, 404);
    const dueDate = await setOrderDueDate(env.DB, orderId, raw || null);
    audit({ orgId: prev.orgId, orderId, action: "order.due_date_set", detail: { from: prev.dueDate || "", to: dueDate || "" } });
    return jsonResponse({ status: "ok", orderId, dueDate: dueDate || "" });
  }

  // ---- bulkSetDueDate — set/clear the due date on several orders at once -------
  if (body.action === "bulkSetDueDate") {
    const denied = await requireAdmin(env, host, body.key, request, "Admin access is only available from the admin subdomain.", ACTION_ROLE[body.action]);
    if (denied) return denied;
    const raw = body.dueDate == null ? "" : String(body.dueDate).trim();
    if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return jsonResponse({ status: "error", message: "Invalid date — expected YYYY-MM-DD" }, 400);
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.map(String).filter(id => ORDER_ID_RE.test(id)) : [];
    if (!orderIds.length) return jsonResponse({ status: "error", message: "No valid orders selected" }, 400);
    let updated = 0;
    for (const orderId of orderIds) {
      const prev = await getOrderById(env.DB, orderId);
      if (!prev) continue;
      const dueDate = await setOrderDueDate(env.DB, orderId, raw || null);
      audit({ orgId: prev.orgId, orderId, action: "order.due_date_set", detail: { from: prev.dueDate || "", to: dueDate || "" } });
      updated++;
    }
    return jsonResponse({ status: "ok", updated, dueDate: raw });
  }

  // ---- Order submission -------------------------------------------------------
  if (host.kind === "admin") {
    return jsonResponse({ status: "error", message: "Not available here." }, 403);
  }
  if (body.action) {
    return jsonResponse({ status: "error", message: "Unknown action" }, 400);
  }
  // Storefront switched off: no customer orders. (Orders the admin enters — local sale, test
  // transaction — are named actions handled above and never reach this point.)
  if (!featureOn("storefront")) return jsonResponse({ status: "error", feature: "storefront", message: "Online ordering isn't available here." }, 403);
  if (host.kind === "locked") {
    body.orgId = host.orgId;
  }

  const orderRl = await rateLimited(env, "order_submit", request, 20);
  if (orderRl.blocked) return rateLimitResponse(orderRl.retryAfter);

  const bot = await verifyTurnstile(env, body.turnstileToken, request);
  if (!bot.ok) return jsonResponse({ status: "error", message: bot.message }, 403);

  // NOTE: shippingCost, shippingMethod, subtotal, total and placedAt from the
  // client are deliberately NOT read — shipping comes only from a signed
  // quote (see quoteToken.js) and placedAt is always server time, so an
  // order can't be underpriced or backdated by editing the request.
  const { orderId, orgId, customerName, contact, paymentMethod, items, shippingAddress, shippingQuoteToken } = body;
  // "TEST-" is reserved for admin test transactions (excluded from sales).
  // …and so is any name every object answers to ("constructor", "toString"): the id is used as a
  // key in the admin's own lists as well as here.
  if (typeof orderId !== "string" || !ORDER_ID_RE.test(orderId) || /^TEST-/i.test(orderId) || orderId in Object.prototype) {
    return jsonResponse({ status: "error", message: "Invalid order ID" }, 400);
  }
  if (typeof orgId !== "string" || !orgId) {
    return jsonResponse({ status: "error", message: "Unknown org" }, 400);
  }
  if (typeof customerName !== "string" || !customerName.trim() || customerName.length > 200) {
    return jsonResponse({ status: "error", message: "Name required" }, 400);
  }
  if (typeof contact !== "string" || contact.length > 254) {
    return jsonResponse({ status: "error", message: "Valid email address required" }, 400);
  }

  // Org must exist, be open for orders, and not past a hard deadline —
  // enforced here, not just in the browser.
  const orgRow = await getOrgById(env.DB, orgId);
  if (!orgRow || !orgRow.ready) {
    return jsonResponse({ status: "error", message: "This shop is not currently accepting orders." }, 403);
  }
  if (orgRow.orderDeadline && orgRow.allowOrdersAfterDeadline === false) {
    // End of the deadline day at UTC-12 — the latest "end of day" anywhere,
    // so the server never closes earlier than the customer's own clock does.
    const closesAt = Date.parse(String(orgRow.orderDeadline).slice(0, 10) + "T23:59:59-12:00");
    if (Number.isFinite(closesAt) && Date.now() > closesAt) {
      return jsonResponse({ status: "error", message: orgRow.closedMessage || "Ordering for this shop has closed." }, 403);
    }
  }
  if (!contact || !contact.includes("@") || !contact.includes(".")) {
    return jsonResponse({ status: "error", message: "Valid email address required" }, 400);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
    return jsonResponse({ status: "error", message: "Invalid items" }, 400);
  }
  // Each line's quantity is read once, by the same rule the rate quote used (lineQty in db.js):
  // what is priced, what the signed quote covers and what ships are one number. A quantity that
  // isn't a whole number from 1 to 50 is refused, never rounded or capped into one.
  if (items.some((it) => !it || typeof it !== "object" || Array.isArray(it) || lineQty(it.qty) === null)) {
    return jsonResponse({ status: "error", message: QTY_MESSAGE }, 400);
  }
  // …and its product is named by a string, as the catalog has it. (A number such as 101 would be
  // the same product to the database and a different key to a lookup — one reading there too.)
  if (items.some((it) => typeof it.productId !== "string" || !it.productId)) {
    return jsonResponse({ status: "error", message: "Invalid items" }, 400);
  }

  // The customer's own designs (migrations/0054): each upload named in the cart must be one made on
  // this shop, for this line's product, in the last 24 hours. The same upload may be on several lines
  // (the same art in M and L). Looked up here, priced by priceItem, recorded on the order by insertOrder.
  let customByLine;
  try { customByLine = await customDesignsForCart_(env.DB, orgId, items); }
  catch (e) {
    if (!e || !e.userFacing) console.error("Looking up the customer's designs failed:", e);
    return jsonResponse({ status: "error", message: e && e.userFacing ? e.message : "We couldn't find your uploaded design — please upload it again." }, 400);
  }

  // Server-side pricing
  let pricedItems;
  let subtotal = 0;
  try {
    pricedItems = await Promise.all(
      items.map(async (it, n) => {
        const qty = lineQty(it.qty);
        const priced = await priceItem(
          env.DB, orgId, it.productId, it.size, qty, !!it.personalized, it.config, { custom: customByLine[n] }
        );
        if (priced.needsCustomUpload) throw Object.assign(new Error(`Upload your design to order ${priced.name || "this item"}.`), { userFacing: true });
        const { unitPrice, personalizationFee, name, type } = priced;
        const lineTotal = (unitPrice + personalizationFee) * qty;
        subtotal += lineTotal;
        return {
          productId: it.productId,
          // name/type from the catalog row, never from the request.
          name: name || String(it.productId), type: type || "",
          size: String(it.size || "").slice(0, 40),
          qty, unitPrice, personalized: !!it.personalized,
          persName: String(it.persName || "").slice(0, 200), personalizationFee, lineTotal,
          // Configurable line snapshot (built + validated server-side); stored in order_items.configJson.
          ...(priced.config ? { config: priced.config } : {}),
          // The customer's files, recorded on the line (order_item_files, uploadedBy 'customer').
          customFiles: customFilesOf_(priced.config),
        };
      })
    );
  } catch (e) {
    // Only deliberate pricing messages ("Size XL not available…") reach the
    // customer; an internal error's text is logged, never echoed back.
    if (!e || !e.userFacing) console.error("Order pricing failed:", e);
    return jsonResponse({ status: "error", message: e && e.userFacing ? e.message : "We couldn't price your order — please refresh the page and try again." }, 400);
  }

  // Shipping: a carrier rate is only accepted via a signed quote bound to
  // this org, this cart and this ZIP. No token = no carrier charge (either
  // local pickup, or a manual quote the admin bills separately later).
  let serverShippingCost = 0;
  let serverShippingMethod = "";
  // The ship-to address, whitelisted and with its state checked against the ZIP — the state
  // decides sales tax, and the quote below only binds the ZIP (cleanShippingAddress).
  // Region → country: "US" checks the formats; "OTHER" takes postal code and region as free text.
  const { country } = await getLocaleSettings(env.DB);
  const addrCheck = cleanShippingAddress(shippingAddress, country);
  if (addrCheck.error) return jsonResponse({ status: "error", message: addrCheck.error }, 400);
  let cleanAddr = addrCheck.address;
  // What this shop offers (migrations/0045): local pickup, carrier shipping, and its own flat-fee
  // options. The fee and wording of a custom option come from the shop's list, never the request.
  const delivery = Array.isArray(orgRow.deliveryOptions) && orgRow.deliveryOptions.length ? orgRow.deliveryOptions
    : [{ id: "pickup", type: "pickup", label: "Local pickup", fee: 0 }].concat(orgRow.shippingEnabled ? [{ id: "shipping", type: "shipping", label: "Shipping", fee: null }] : []);
  // Carrier rates are quoted by US ZIP only, so outside the US the shipping option isn't offered,
  // whatever the shop's list says (pickup and the shop's own options still are).
  // The same goes for an install with the Shipping feature switched off.
  const offersShipping = country === "US" && featureOn("shipping") && delivery.some(o => o.type === "shipping");
  // "Shipping, quote to follow": the cart fits no box, so there is no carrier rate to sign and the
  // shop sets the shipping afterwards. Only the server decides that (below) — the request merely asks.
  const manualShipping = !shippingQuoteToken && !!body.manualShipping && !!cleanAddr;
  if ((shippingQuoteToken || manualShipping) && !offersShipping) {
    return jsonResponse({ status: "error", message: country === "US" ? "This shop doesn't offer shipping — please choose another delivery option."
      : "Carrier shipping isn't available for this shop's region — please choose another delivery option." }, 400);
  }
  if (manualShipping) {
    // The same box picker /api/shipping runs, on the catalog's own types and weights. A cart that
    // fits a box can be quoted, so it must be: otherwise sending manualShipping:true would be a way
    // to have any order placed with no shipping charge at all.
    let fitsABox = true;
    try {
      const products = await getProductsByOrg(env.DB, orgId, true);
      const weightOf = new Map(products.map(p => [String(p.productId), p.weightOz]));
      let presets = null;
      try { presets = await getBoxPresets(env.DB); } catch (_) {}
      fitsABox = !!selectBox(pricedItems.map(it => ({
        type: it.type, qty: it.qty, weightOz: typeof weightOf.get(it.productId) === "number" ? weightOf.get(it.productId) : 0,
      })), presets);
    } catch (e) {
      console.error("Could not check the box for a quote-to-follow order:", e);
    }
    if (fitsABox) {
      return jsonResponse({ status: "error", message: "Shipping for this cart can be quoted now — please enter your ZIP and choose a shipping rate." }, 400);
    }
    // The address is where the parcel will go, and its state decides the sales tax — so it has to
    // be one the shop can ship to (street, city) with a ZIP the state check can vouch for
    // (cleanShippingAddress matched the two).
    if (!cleanAddr.line1 || !cleanAddr.city) {
      return jsonResponse({ status: "error", message: "Please enter the full shipping address — street, city, state and ZIP." }, 400);
    }
    if (!cleanAddr.zip || !zipStates(cleanAddr.zip).length) {
      return jsonResponse({ status: "error", message: "Please enter a valid ZIP code for the shipping address." }, 400);
    }
    serverShippingMethod = SHIPPING_QUOTE_PENDING;
  }
  if (!shippingQuoteToken && !manualShipping) {
    const wanted = body.deliveryOptionId == null ? "" : String(body.deliveryOptionId);
    const choices = delivery.filter(o => o.type !== "shipping");
    // No id = a page loaded before the list existed: it could only mean local pickup.
    const pick = wanted ? choices.find(o => o.id === wanted) : (choices.find(o => o.type === "pickup") || (choices.length === 1 ? choices[0] : null));
    if (!pick) {
      return jsonResponse({ status: "error", message: wanted ? "That delivery option is no longer offered — please refresh the page and choose again."
        : (choices.length ? "Please choose a delivery option."
          : (offersShipping ? "Please enter your ZIP and choose a shipping rate." : "This shop has no delivery option available right now — please contact the shop.")) }, 400);
    }
    if (pick.type === "custom") { serverShippingCost = Number(pick.fee) || 0; serverShippingMethod = pick.label; }
    // Pickup and the shop's own options have no ship-to address — the storefront doesn't ask for
    // one. The ship-to state decides sales tax, so an address sent along with one of them is not
    // kept: a made-up out-of-state address on a pickup order would otherwise drop the order's tax.
    cleanAddr = null;
  }
  if (shippingQuoteToken) {
    const q = await verifyQuote(env, shippingQuoteToken);
    if (!q.ok) return jsonResponse({ status: "error", message: q.reason }, 400);
    const cartKey = canonicalItems(items);
    if (!cartKey || q.orgId !== orgId || q.items !== cartKey) {
      return jsonResponse({ status: "error", message: "Your cart changed since shipping was quoted — please refresh shipping rates." }, 400);
    }
    if (!cleanAddr || cleanAddr.zip !== q.zip) {
      return jsonResponse({ status: "error", message: "Shipping ZIP doesn't match the quoted ZIP — please refresh shipping rates." }, 400);
    }
    // The state decides the tax and is only checked against the ZIP's prefix, so the ZIP has to be
    // one the table knows: an unassigned prefix would let the address name any state it liked.
    if (!zipStates(cleanAddr.zip).length) {
      return jsonResponse({ status: "error", message: "Please enter a valid ZIP code for the shipping address." }, 400);
    }
    serverShippingCost = q.amountCents / 100;
    serverShippingMethod = String(q.method || "").slice(0, 100);
  }
  const total = subtotal + serverShippingCost;

  // Weight from the catalog, not the client (used later for label purchase).
  let serverWeightOz = 0;
  try {
    const products = await getProductsByOrg(env.DB, orgId, false);
    const byId = Object.fromEntries(products.map(p => [p.productId, p]));
    serverWeightOz = pricedItems.reduce((sum, it) => {
      const w = byId[it.productId] && Number(byId[it.productId].weightOz);
      return sum + (w > 0 ? w : 8) * it.qty;
    }, 0);
  } catch (_) {}

  const order = {
    orderId, orgId, customerName: customerName.trim(), contact, paymentMethod: String(paymentMethod || "").slice(0, 40),
    subtotal, shippingCost: serverShippingCost, total,
    shippingMethod: serverShippingMethod,
    shippingAddress: cleanAddr,
    totalWeightOz: serverWeightOz,
    placedAt: new Date().toISOString(),
  };

  // What the order comes to, as recorded (insertOrder works the tax out per line; with tax added
  // on top it's part of the total). The storefront shows these figures, never its own estimate.
  let placed;
  try {
    placed = (await insertOrder(env.DB, order, pricedItems)) || {};
  } catch (e) {
    // The same order id twice (a double click, a retry after a lost answer): the order is already
    // there, so say so plainly instead of failing with an error page.
    if (/UNIQUE constraint failed: orders\.orderId/i.test(String(e && e.message))) {
      return jsonResponse({ status: "error", message: "This order has already been received." }, 409);
    }
    throw e;
  }

  // The customer's "order received" email goes out AFTER the response: sending can take a second
  // or more, and the customer shouldn't wait on it — the order is already saved. waitUntil keeps
  // the Worker alive until it finishes; receivedEmailAt is only stamped on a confirmed send, so a
  // failure still shows as "—" in the admin (and the Resend button works).
  // The owner hears about new orders in the 6 AM daily roll-up (/api/daily-digest).
  const sendReceived = (async () => {
    // The tax recorded for this order (backed out per line in insertOrder), so
    // the receipt shows exactly what's on the books.
    let taxInfo = {};
    try {
      const saved = await getOrderById(env.DB, orderId);
      if (saved) taxInfo = { salesTax: saved.salesTax, taxRate: saved.taxRate, taxExempt: saved.taxExempt, taxMode: saved.taxMode,
        // With tax on top, the order's total is the saved one (items + shipping + tax), not the sum above.
        ...(saved.taxMode === "exclusive" ? { total: saved.effectiveTotal, effectiveTotal: saved.effectiveTotal } : {}) };
    } catch (_) {}
    const receivedSent = await sendOrderReceivedEmail(env, { ...order, ...taxInfo, items: pricedItems, manualShipping });
    if (receivedSent) {
      await setOrderEmailTimestamp(env.DB, orderId, "receivedEmailAt", new Date().toISOString());
    }
  })().catch((e) => console.error("Order-received email failed for", orderId, e));
  if (typeof context.waitUntil === "function") context.waitUntil(sendReceived);
  else await sendReceived;

  return jsonResponse(placed.taxMode === "exclusive"
    ? { status: "ok", taxMode: "exclusive", salesTax: placed.salesTax, total: placed.total }
    : { status: "ok" });
}

export async function onRequestGet() {
  return jsonResponse({ status: "error", message: "Use POST for this endpoint." }, 405);
}

// The customer's own designs named in a storefront cart → one `opts.custom` per line (priceItem): an
// ordinary line names its upload as `customUploadId`, a configurable line on each custom location
// (`{location, custom: true, uploadId}`). Every upload must belong to this shop and this line's
// product and be under 24 hours old. Throws a customer-facing error otherwise.
const UPLOAD_ID_RE = /^[a-f0-9]{32}$/;
const UPLOAD_MAX_AGE_MS = 24 * 3600 * 1000;
async function customDesignsForCart_(db, orgId, items) {
  const wanted = items.map((it) => {
    const m = new Map();
    if (it.customUploadId != null) m.set(CUSTOM_PLAIN_LOCATION, it.customUploadId);
    const locs = it.config && Array.isArray(it.config.locations) ? it.config.locations : [];
    for (const l of locs) if (l && (l.custom === true || l.graphicId === "custom") && l.uploadId != null && l.location != null) m.set(String(l.location), l.uploadId);
    return m;
  });
  const ids = [...new Set(wanted.flatMap((m) => [...m.values()]))];
  if (!ids.length) return items.map(() => ({}));
  if (ids.some((id) => typeof id !== "string" || !UPLOAD_ID_RE.test(id)) || ids.length > 40) throw userError_("We couldn't find your uploaded design — please upload it again.");
  let rows = [];
  try {
    ({ results: rows } = await db.prepare("SELECT * FROM customer_design_uploads WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all());
  } catch (e) { if (!/no such table/i.test(String(e && e.message))) throw e; }
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wanted.map((m, n) => {
    const out = {};
    for (const [loc, id] of m) {
      const r = byId.get(id);
      if (!r || r.orgId !== orgId || r.productId !== items[n].productId) throw userError_("We couldn't find your uploaded design — please upload it again.");
      if (!(Date.now() - Date.parse(r.createdAt) < UPLOAD_MAX_AGE_MS)) throw userError_("Your uploaded design has expired — please upload it again.");
      out[loc] = { uploadId: r.id, fileKey: r.fileKey, fileName: r.fileName, fileExt: r.fileExt };
    }
    return out;
  });
}
const userError_ = (message) => Object.assign(new Error(message), { userFacing: true });
// The files a line's custom entries name, once each.
function customFilesOf_(config) {
  const seen = new Set(), out = [];
  for (const l of (config && Array.isArray(config.locations) ? config.locations : [])) {
    if (!l || !l.custom || !l.fileKey || seen.has(l.fileKey)) continue;
    seen.add(l.fileKey);
    out.push({ fileKey: l.fileKey, fileName: l.fileName || "", fileExt: l.fileExt || "" });
  }
  return out;
}
