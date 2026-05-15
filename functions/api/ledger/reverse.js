diff --git a//workspace/repo/sovereign-finance-repo/functions/api/ledger/reverse.js b//workspace/repo/sovereign-finance-repo/functions/api/ledger/reverse.js
--- a//workspace/repo/sovereign-finance-repo/functions/api/ledger/reverse.js
+++ b//workspace/repo/sovereign-finance-repo/functions/api/ledger/reverse.js
@@ -1,0 +1,61 @@
+/* /api/ledger/reverse — POST
+ * Sovereign Finance · Ledger Reversal
+ * v0.2.0-linked-reversal-engine
+ *
+ * Purpose:
+ * - Canonical reversal endpoint for Phase 1
+ * - Wraps /api/transactions/reverse for clear ledger naming
+ * - Handles single transaction and linked transfer reversals
+ * - Updates original transactions as reversed
+ * - Creates reversal transaction rows
+ *
+ * Phase 1 contract:
+ * - Reversal must mark original transaction as reversed
+ * - Reversal must create inverse transaction
+ * - Linked reversals must handle both sides atomically
+ * - Balance calculations must exclude reversed transactions
+ */
+
+import * as TransactionsReverse from '../transactions/reverse.js';
+
+const VERSION = 'v0.2.0-linked-reversal-engine';
+
+export async function onRequestPost(context) {
+  try {
+    // Delegate to transactions/reverse.js
+    const response = await TransactionsReverse.onRequestPost(context);
+
+    // Wrap response with ledger version
+    const body = await response.json();
+
+    return json({
+      ...body,
+      ledger_reversal_version: VERSION,
+      ledger_contract: {
+        endpoint: '/api/ledger/reverse',
+        transaction_reversal_endpoint: '/api/transactions/reverse',
+        purpose: 'Canonical reversal endpoint for Phase 1 backend contract',
+        supports_single_reversal: true,
+        supports_linked_reversal: true,
+        marks_original_reversed: true
+      }
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
+      'content-type': 'application/json',
+      'cache-control': 'no-store'
+    }
+  });
+}
+
