import { filesFromPatch } from './patch';
import type { ReviewFile } from './review';

/**
 * The sample reviews behind the example chips. Each one is a real review: a
 * pull request, a small codebase, or a single file. They are deliberately
 * uneven in quality — a preset whose files all score the same teaches nothing
 * about what Jev is reading.
 */
export interface Preset {
  label: string;
  /** One line under the label: what this example is for. */
  blurb: string;
  files: ReviewFile[];
}

/**
 * A four-file pull request against a TypeScript billing service: one tidy
 * extraction, one new module that earns every smell it has, the tests that
 * came with it, and a config bump. Stored as the diff a reviewer would
 * actually be handed, and split per file the way the agent splits a paste.
 */
const REFUND_PR = `diff --git a/src/billing/refund-service.ts b/src/billing/refund-service.ts
index 3c1a2f9..8b7d410 100644
--- a/src/billing/refund-service.ts
+++ b/src/billing/refund-service.ts
@@ -1,10 +1,11 @@
 import { Ledger } from "./ledger";
 import { PaymentGateway } from "./payment-gateway";
+import { refundableAmount } from "./refund-policy";
 import type { Order, Refund } from "./types";
 
 export class RefundService {
   constructor(
     private readonly ledger: Ledger,
     private readonly gateway: PaymentGateway,
   ) {}
 
@@ -11,25 +12,19 @@ export class RefundService {
-  async refund(order: Order, reason: string): Promise<Refund> {
-    let amount = 0;
-    for (const line of order.lines) {
-      if (line.refunded) continue;
-      amount += line.unitPrice * line.quantity;
-      if (line.taxRate > 0) {
-        amount += line.unitPrice * line.quantity * line.taxRate;
-      }
-    }
-    if (order.shippingRefundable) {
-      amount += order.shippingCost;
-    }
-    if (amount <= 0) {
-      throw new Error("nothing to refund");
-    }
-    const receipt = await this.gateway.credit(order.paymentId, amount);
-    await this.ledger.record({
-      orderId: order.id,
-      amount,
-      reason,
-      receiptId: receipt.id,
-    });
-    return { orderId: order.id, amount, receiptId: receipt.id, reason };
-  }
+  async refund(order: Order, reason: string): Promise<Refund> {
+    const amount = refundableAmount(order);
+    if (amount <= 0) {
+      throw new Error("nothing to refund");
+    }
+    const receipt = await this.gateway.credit(order.paymentId, amount);
+    await this.recordRefund(order, amount, reason, receipt.id);
+    return { orderId: order.id, amount, receiptId: receipt.id, reason };
+  }
+
+  private async recordRefund(
+    order: Order,
+    amount: number,
+    reason: string,
+    receiptId: string,
+  ): Promise<void> {
+    await this.ledger.record({ orderId: order.id, amount, reason, receiptId });
+  }
 }
diff --git a/src/billing/refund-policy.ts b/src/billing/refund-policy.ts
new file mode 100644
index 0000000..a91c33d
--- /dev/null
+++ b/src/billing/refund-policy.ts
@@ -0,0 +1,33 @@
+// import { Money } from "./money";
+// import { roundHalfEven } from "../util/round";
+
+export function refundableAmount(order: any, includeShipping?: boolean) {
+  let t = 0;
+  if (order) {
+    if (order.lines) {
+      for (const l of order.lines) {
+        if (!l.refunded) {
+          if (l.quantity > 0) {
+            if (l.unitPrice > 0) {
+              t = t + l.unitPrice * l.quantity;
+              if (l.taxRate > 0) {
+                t = t + l.unitPrice * l.quantity * l.taxRate;
+              }
+              if (order.createdAt < Date.now() - 2592000000) {
+                t = t * 0.85;
+              }
+            }
+          }
+        }
+      }
+    }
+  }
+  // if (order.coupon) {
+  //   t = t - order.coupon.value;
+  //   console.log("coupon applied", order.coupon.code);
+  // }
+  if (includeShipping === true && order.shippingCost < 2500) {
+    t = t + order.shippingCost;
+  }
+  return Math.round(t * 100) / 100;
+}
diff --git a/src/billing/__tests__/refund-service.test.ts b/src/billing/__tests__/refund-service.test.ts
index 5f0c1b2..2d9e7a4 100644
--- a/src/billing/__tests__/refund-service.test.ts
+++ b/src/billing/__tests__/refund-service.test.ts
@@ -1,5 +1,6 @@
 import { describe, expect, it } from "vitest";
 import { RefundService } from "../refund-service";
+import { refundableAmount } from "../refund-policy";
 import { fakeGateway, fakeLedger, orderWithLines } from "./fixtures";
 
 describe("RefundService", () => {
@@ -14,10 +15,22 @@ describe("RefundService", () => {
     expect(ledger.record).toHaveBeenCalledWith(
       expect.objectContaining({ orderId: order.id, amount: 42 }),
     );
   });
 
   it("refuses an order with nothing left to refund", async () => {
     const order = orderWithLines([{ unitPrice: 10, quantity: 1, refunded: true }]);
     await expect(service.refund(order, "duplicate")).rejects.toThrow("nothing to refund");
   });
+
+  it("adds tax to every unrefunded line", () => {
+    const order = orderWithLines([{ unitPrice: 100, quantity: 2, taxRate: 0.2 }]);
+    expect(refundableAmount(order)).toBe(240);
+  });
+
+  it("leaves shipping out unless the caller asks for it", () => {
+    const order = orderWithLines([{ unitPrice: 10, quantity: 1 }]);
+    order.shippingCost = 5;
+    expect(refundableAmount(order)).toBe(10);
+    expect(refundableAmount(order, true)).toBe(15);
+  });
 });
diff --git a/config/billing.json b/config/billing.json
index 1a2b3c4..7d8e9f0 100644
--- a/config/billing.json
+++ b/config/billing.json
@@ -2,9 +2,11 @@
   "currency": "EUR",
   "refunds": {
     "enabled": true,
-    "windowDays": 30
+    "windowDays": 30,
+    "partialRefundPercent": 85,
+    "includeShippingUnderCents": 2500
   },
   "dunning": {
     "retries": 3
   }
 }`;

export const PRESETS: readonly Preset[] = [
  {
    blurb: 'A four-file pull request, judged file by file.',
    files: filesFromPatch(REFUND_PR),
    label: 'PR: refund flow',
  },
  {
    blurb: 'Five TypeScript files across the whole quality range.',
    files: [
      {
        content: `import { addMoney, multiplyMoney, subtractMoney, zeroMoney, type Money } from "./money";

const PAYMENT_TERMS_DAYS = 30;

export interface InvoiceLine {
  description: string;
  unitPrice: Money;
  quantity: number;
}

export interface Invoice {
  number: string;
  currency: string;
  issuedOn: Date;
  lines: readonly InvoiceLine[];
  payments: readonly Money[];
}

export function totalBeforeTax(invoice: Invoice): Money {
  return invoice.lines.map(lineTotal).reduce(addMoney, zeroMoney(invoice.currency));
}

export function amountPaid(invoice: Invoice): Money {
  return invoice.payments.reduce(addMoney, zeroMoney(invoice.currency));
}

export function amountOutstanding(invoice: Invoice): Money {
  return subtractMoney(totalBeforeTax(invoice), amountPaid(invoice));
}

export function isSettled(invoice: Invoice): boolean {
  return amountOutstanding(invoice).cents <= 0;
}

export function isOverdue(invoice: Invoice, today: Date): boolean {
  return !isSettled(invoice) && today > dueDate(invoice);
}

export function dueDate(invoice: Invoice): Date {
  return addDays(invoice.issuedOn, PAYMENT_TERMS_DAYS);
}

export function daysLate(invoice: Invoice, today: Date): number {
  return isOverdue(invoice, today) ? daysBetween(dueDate(invoice), today) : 0;
}

function lineTotal(line: InvoiceLine): Money {
  return multiplyMoney(line.unitPrice, line.quantity);
}

function addDays(date: Date, days: number): Date {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

function daysBetween(earlier: Date, later: Date): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((later.getTime() - earlier.getTime()) / millisecondsPerDay);
}
`,
        path: 'src/invoicing/invoice.ts',
      },
      {
        content: `import { db } from "../db";
import { mailer } from "../mailer";
import { fmt, calc, check } from "./utils";

export let lastRunAt: Date | null = null;
export let processed = 0;

export class InvoiceService {
  cache: any = {};
  retries = 0;

  // Runs the whole month-end job.
  async run(customerId: string, send: boolean, dryRun: boolean, notifyOps: boolean) {
    lastRunAt = new Date();
    const rows = await db.query("SELECT * FROM invoices WHERE customer_id = ?", [customerId]);
    const out: any[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.status != "void") {
        if (r.status == "open" || r.status == "partial") {
          let total = 0;
          for (let j = 0; j < r.lines.length; j++) {
            total = total + r.lines[j].price * r.lines[j].qty;
            if (r.lines[j].tax) {
              total = total + r.lines[j].price * r.lines[j].qty * 0.19;
            }
          }
          let paid = 0;
          for (let j = 0; j < r.payments.length; j++) {
            paid = paid + r.payments[j].amount;
          }
          const due = total - paid;
          if (due > 0) {
            const age = (Date.now() - new Date(r.issued_on).getTime()) / 86400000;
            if (age > 30) {
              r.status = "overdue";
              if (age > 60) {
                r.dunning = 2;
                if (age > 90) {
                  r.dunning = 3;
                  if (notifyOps) {
                    await mailer.send("ops@example.com", "Invoice " + r.number + " is 90 days late", fmt(due));
                  }
                }
              } else {
                r.dunning = 1;
              }
            }
            if (send && !dryRun) {
              await mailer.send(r.email, "Invoice " + r.number, "You owe " + fmt(due));
              r.reminded_at = new Date();
            }
            if (!dryRun) {
              await db.query("UPDATE invoices SET status = ?, dunning = ? WHERE id = ?", [r.status, r.dunning, r.id]);
            }
            this.cache[r.id] = { total: total, due: due };
            out.push({ id: r.id, number: r.number, total: total, due: due, status: r.status });
            processed = processed + 1;
          }
        }
      }
    }
    console.log("done", out.length);
    return out;
  }

  // Same thing but for one invoice. Copied from run() on purpose, for now.
  async one(id: string) {
    const r = (await db.query("SELECT * FROM invoices WHERE id = ?", [id]))[0];
    let total = 0;
    for (let j = 0; j < r.lines.length; j++) {
      total = total + r.lines[j].price * r.lines[j].qty;
      if (r.lines[j].tax) {
        total = total + r.lines[j].price * r.lines[j].qty * 0.19;
      }
    }
    return check(total) ? calc(total) : null;
  }
}
`,
        path: 'src/invoicing/invoice-service.ts',
      },
      {
        content: `// Grab bag. Everything that did not fit anywhere else.

export function fmt(n: number) {
  return "EUR " + (Math.round(n * 100) / 100).toFixed(2);
}

export function fmt2(n: number) {
  return "EUR " + (Math.round(n * 100) / 100).toFixed(2) + " (incl. VAT)";
}

export function calc(total: number) {
  let t = total;
  if (t > 10000) {
    t = t - t * 0.02;
  }
  if (t > 50000) {
    t = t - t * 0.05;
  }
  return Math.round(t * 100) / 100;
}

export function calcWithTax(total: number) {
  let t = total;
  if (t > 10000) {
    t = t - t * 0.02;
  }
  if (t > 50000) {
    t = t - t * 0.05;
  }
  t = t * 1.19;
  return Math.round(t * 100) / 100;
}

export function check(n: number) {
  if (n == null) return false;
  if (n < 0) return false;
  if (n > 99999999) return false;
  return true;
}

export function days(a: any, b: any) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function late(issued: any) {
  return days(issued, new Date()) > 30;
}

export function veryLate(issued: any) {
  return days(issued, new Date()) > 90;
}
`,
        path: 'src/invoicing/utils.ts',
      },
      {
        content: `import { InvoiceService } from "./invoice-service";
import { db } from "../db";

const service = new InvoiceService();

export async function getInvoice(req: any, res: any) {
  const id = req.params.id;
  if (!id) {
    return null;
  }
  const rows = await db.query("SELECT * FROM invoices WHERE id = ?", [id]);
  if (rows.length == 0) {
    return null;
  }
  const invoice = rows[0];
  if (invoice.deleted) {
    return null;
  }
  res.json(invoice);
}

export async function postRun(req: any, res: any) {
  const customerId = req.body.customerId;
  const result = await service.run(customerId, req.body.send, req.body.dryRun, false);
  if (result == null) {
    res.status(500).send("error");
    return -1;
  }
  res.json(result);
  return result.length;
}

export async function getTotal(req: any, res: any) {
  const t = await service.one(req.params.id);
  if (t == null) {
    res.status(404).send("");
    return null;
  }
  res.send(String(t));
  return t;
}

export async function deleteInvoice(req: any, res: any) {
  await db.query("DELETE FROM invoices WHERE id = ?", [req.params.id]);
  res.status(204).end();
}
`,
        path: 'src/invoicing/invoice-controller.ts',
      },
      {
        content: `import { describe, expect, it } from "vitest";
import { amountOutstanding, daysLate, isOverdue, isSettled } from "./invoice";
import { euros, invoiceIssuedOn } from "./test-support";

describe("an invoice", () => {
  const january1st = new Date("2025-01-01");
  const february15th = new Date("2025-02-15");

  it("owes the total of its lines until something is paid", () => {
    const invoice = invoiceIssuedOn(january1st, [{ unitPrice: euros(120), quantity: 2 }]);

    expect(amountOutstanding(invoice)).toEqual(euros(240));
    expect(isSettled(invoice)).toBe(false);
  });

  it("is settled once the payments cover the total", () => {
    const invoice = invoiceIssuedOn(january1st, [{ unitPrice: euros(50), quantity: 1 }], [euros(50)]);

    expect(isSettled(invoice)).toBe(true);
    expect(isOverdue(invoice, february15th)).toBe(false);
  });

  it("counts the days past its due date, and only those", () => {
    const invoice = invoiceIssuedOn(january1st, [{ unitPrice: euros(10), quantity: 1 }]);

    expect(daysLate(invoice, february15th)).toBe(14);
  });
});
`,
        path: 'src/invoicing/invoice.test.ts',
      },
    ],
    label: 'Codebase: invoice service',
  },
  {
    blurb: 'Three Python files: one tidy, one sprawling, one haunted.',
    files: [
      {
        content: `"""Command line entry point for the weekly reporting job."""

import argparse
import sys

from reporting.db import open_connection
from reporting.report import build_weekly_report


def parse_arguments(argv):
    parser = argparse.ArgumentParser(prog="weekly-report")
    parser.add_argument("--week", required=True, help="ISO week, e.g. 2025-W07")
    parser.add_argument("--team", default="all")
    parser.add_argument("--output", default="-", help="File to write, or - for stdout")
    return parser.parse_args(argv)


def write_report(report, destination):
    if destination == "-":
        sys.stdout.write(report)
        return
    with open(destination, "w", encoding="utf-8") as handle:
        handle.write(report)


def main(argv=None):
    arguments = parse_arguments(argv if argv is not None else sys.argv[1:])
    with open_connection() as connection:
        report = build_weekly_report(connection, arguments.week, arguments.team)
    write_report(report, arguments.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`,
        path: 'reporting/cli.py',
      },
      {
        content: `import datetime
import json
import os

CACHE = {}


def build_weekly_report(conn, week, team, fmt="text", verbose=False, retry=True):
    global CACHE
    key = week + team + fmt
    if key in CACHE:
        return CACHE[key]
    rows = conn.execute("select * from events where week = ?", (week,)).fetchall()
    out = []
    totals = {}
    for r in rows:
        if r[3] != "deleted":
            if team == "all" or r[2] == team:
                if r[1] is not None:
                    if r[1] > 0:
                        d = r[4]
                        if d is None:
                            d = 0
                        v = r[1] * 1.0
                        if r[5] == "eur":
                            v = v * 1.09
                        elif r[5] == "gbp":
                            v = v * 1.27
                        if d > 86400 * 7:
                            v = v * 0.5
                        if r[2] not in totals:
                            totals[r[2]] = 0
                        totals[r[2]] = totals[r[2]] + v
                        out.append((r[0], r[2], round(v, 2)))
                        if verbose:
                            print("row", r[0], r[2], v)
                    else:
                        if retry:
                            try:
                                v2 = conn.execute("select v from backfill where id = ?", (r[0],)).fetchone()
                                if v2:
                                    out.append((r[0], r[2], v2[0]))
                            except Exception:
                                pass
    if fmt == "json":
        text = json.dumps({"week": week, "rows": out, "totals": totals})
    else:
        lines = ["Week " + week + " for " + team, ""]
        for o in out:
            lines.append(str(o[0]) + "  " + str(o[1]) + "  " + str(o[2]))
        lines.append("")
        for t in totals:
            lines.append(t + ": " + str(round(totals[t], 2)))
        text = os.linesep.join(lines)
    CACHE[key] = text
    with open("/tmp/last_report.txt", "w") as f:
        f.write(text)
    print("report built at", datetime.datetime.now())
    return text
`,
        path: 'reporting/report.py',
      },
      {
        content: `import os
import sqlite3
from contextlib import contextmanager

# import psycopg2
# from psycopg2.extras import RealDictCursor

DB_PATH = os.environ.get("REPORTING_DB", "reporting.sqlite")


@contextmanager
def open_connection():
    connection = sqlite3.connect(DB_PATH)
    try:
        yield connection
    finally:
        connection.close()


def fetch_events(connection, week):
    cursor = connection.execute("select * from events where week = ?", (week,))
    return cursor.fetchall()


# def open_connection_pg():
#     conn = psycopg2.connect(os.environ["PG_DSN"], cursor_factory=RealDictCursor)
#     conn.autocommit = True
#     return conn
#
# def fetch_events_pg(conn, week):
#     with conn.cursor() as cur:
#         cur.execute("select * from events where week = %s", (week,))
#         return cur.fetchall()


def record_run(connection, week, rows_written):
    connection.execute(
        "insert into report_runs (week, rows_written) values (?, ?)",
        (week, rows_written),
    )
    connection.commit()
`,
        path: 'reporting/db.py',
      },
    ],
    label: 'Codebase: Python CLI',
  },
  {
    blurb: 'One file that does everything.',
    files: [
      {
        content: `function process(data, flag, cb) {
  var r = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i].t == 1) {
      if (flag) {
        var x = data[i].v * 1.2;
        if (x > 100) {
          r.push({ id: data[i].id, v: x, s: "hi" });
        } else {
          r.push({ id: data[i].id, v: x, s: "lo" });
        }
      } else {
        r.push({ id: data[i].id, v: data[i].v, s: "n" });
      }
    } else if (data[i].t == 2) {
      fetch("/api/log?id=" + data[i].id);
      window.lastId = data[i].id;
    }
  }
  if (cb) cb(r);
  return r.length > 0 ? r : null;
}
`,
        path: 'src/process.js',
      },
    ],
    label: 'God function',
  },
  {
    blurb: 'The clean version, for contrast.',
    files: [
      {
        content: `const LOYALTY_THRESHOLD_YEARS = 3;

export function isEligibleForDiscount(customer: Customer): boolean {
  return isLoyal(customer) && hasNoOverdueInvoices(customer);
}

function isLoyal(customer: Customer): boolean {
  return customer.yearsActive >= LOYALTY_THRESHOLD_YEARS;
}

function hasNoOverdueInvoices(customer: Customer): boolean {
  return customer.invoices.every((invoice) => !invoice.isOverdue());
}
`,
        path: 'src/discount.ts',
      },
    ],
    label: 'Textbook',
  },
];
