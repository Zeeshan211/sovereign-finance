diff --git a//workspace/repo/sovereign-finance-repo/functions/api/ledger.js b//workspace/repo/sovereign-finance-repo/functions/api/ledger.js
--- a//workspace/repo/sovereign-finance-repo/functions/api/ledger.js
+++ b//workspace/repo/sovereign-finance-repo/functions/api/ledger.js
@@ -1,0 +1,88 @@
+/* /api/ledger
+ * Sovereign Finance · Ledger API
+ * v0.2.0-linked-reversal-engine
+ *
+ * Purpose:
+ * - Canonical ledger endpoint for Phase 1 backend contract
+ * - Wraps /api/transactions for clear naming
+ * - Exposes transaction list, creation, and reversal support
+ * - Money engine foundation for all balance mutations
+ *
+ * This is the Phase 1 contract endpoint.
+ * Use /api/ledger for new code.
+ * /api/transactions continues to work for backward compatibility.
+ */
+
+import * as Transactions from './transactions.js';
+import * as TransactionsReverse from './transactions/reverse.js';
+
+const VERSION = 'v0.2.0-linked-reversal-engine';
+
+export async function onRequestGet(context) {
+  try {
+    // Delegate to transactions.js
+    const response = await Transactions.onRequestGet(context);
+
+    // Wrap response with ledger version
+    const body = await response.json();
+
+    return json({
+      ...body,
+      ledger_version: VERSION,
+      ledger_contract: {
+        endpoint: '/api/ledger',
+        transaction_endpoint: '/api/transactions',
+        reversal_endpoint: '/api/ledger/reverse',
+        purpose: 'Canonical ledger API for Phase 1 backend contract',
+        supports_reversal: true,
+        supports_linked_transactions: true,
+        money_engine: true
+      }
+    });
+  } catch (err) {
+    return json({
+      ok: false,
+      version: VERSION,
+      error: err.message || String(err)
+    }, 500);
+  }
+}
+
+export async function onRequestPost(context) {
+  try {
+    const url = new URL(context.request.url);
+
+    // Check if this is a reversal request
+    if (url.pathname.endsWith('/reverse')) {
+      return await TransactionsReverse.onRequestPost(context);
+    }
+
+    // Delegate to transactions.js for creation
+    const response = await Transactions.onRequestPost(context);
+
+    // Wrap response with ledger version
+    const body = await response.json();
+
+    return json({
+      ...body,
+      ledger_version: VERSION
+    }, response.status);
+  } catch (err) {
+    return json({
+      ok: false,
+      version: VERSION,
+      error: err.message || String(err)
+    }, 500);
+  }
+}
+
+function json(obj, status = 200) {
+  return new Response(JSON.stringify(obj), {
+    status,
+    headers: {
+      'Content-Type': 'application/json',
+      'Cache-Control': 'no-cache'
+    }
+  });
+}
+
