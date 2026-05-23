/* Pakistan FY2025-26 Tax & Fee Constants
 * Source: Finance Act 2025-26, SBP circulars, FBR notifications
 * Import: import { PAKISTAN_FY_2025_26, calculateIncomeTax, calculateIntlFeeBreakdown, calculateAtmFee } from './_lib/pakistan_taxes.js';
 */

export const PAKISTAN_FY_2025_26 = {
  incomeTaxSlabs: [
    { upTo: 600000,    rate: 0,  fixed: 0      },
    { upTo: 1200000,   rate: 1,  fixed: 0      },
    { upTo: 2200000,   rate: 11, fixed: 6000   },
    { upTo: 3200000,   rate: 23, fixed: 116000 },
    { upTo: 4100000,   rate: 30, fixed: 346000 },
    { upTo: Infinity,  rate: 35, fixed: 616000 }
  ],

  incomeSurchargeThreshold: 10000000,
  incomeSurchargeRate: 10,

  section236Y: {
    filer: 5,
    nonFiler: 10
  },

  fedOnBankCharges: 16,

  defaultFxFeePct: 4.5,

  atmOtherBankFee: 35,

  ibftFreeTierMonthly: 25000,
  ibftFeeAfterFreeTier: (amount) => Math.min(0.001 * amount, 200),

  billerFixedFee: 31.25,

  praItTax: 5
};

export function calculateIncomeTax(annualTaxable) {
  if (annualTaxable <= 0) return 0;

  let tax = 0;
  let prevSlab = 0;

  for (const slab of PAKISTAN_FY_2025_26.incomeTaxSlabs) {
    if (annualTaxable <= slab.upTo) {
      tax = slab.fixed + ((annualTaxable - prevSlab) * slab.rate / 100);
      break;
    }
    prevSlab = slab.upTo;
  }

  if (annualTaxable > PAKISTAN_FY_2025_26.incomeSurchargeThreshold) {
    tax = tax * (1 + PAKISTAN_FY_2025_26.incomeSurchargeRate / 100);
  }

  return Math.round(tax);
}

export function calculateIntlFeeBreakdown(basePkr, isPraApplicable = false, isFiler = true) {
  const fxFeePct = PAKISTAN_FY_2025_26.defaultFxFeePct / 100;
  const excisePct = PAKISTAN_FY_2025_26.fedOnBankCharges / 100;
  const advTaxPct = (isFiler
    ? PAKISTAN_FY_2025_26.section236Y.filer
    : PAKISTAN_FY_2025_26.section236Y.nonFiler) / 100;

  const fxFee = basePkr * fxFeePct;
  const excise = fxFee * excisePct;
  const advTax = basePkr * advTaxPct;
  const praTax = isPraApplicable
    ? basePkr * (PAKISTAN_FY_2025_26.praItTax / 100)
    : 0;

  const total = basePkr + fxFee + excise + advTax + praTax;

  return {
    base:    Math.round(basePkr * 100) / 100,
    fxFee:   Math.round(fxFee * 100) / 100,
    excise:  Math.round(excise * 100) / 100,
    advTax:  Math.round(advTax * 100) / 100,
    praTax:  Math.round(praTax * 100) / 100,
    total:   Math.round(total * 100) / 100
  };
}

export function calculateAtmFee(sourceAccountId, atmBank) {
  const src = String(sourceAccountId || '').toLowerCase();
  const bank = String(atmBank || '').toLowerCase();

  if (src === bank) return 0;
  if (src.includes('mashreq') && bank.includes('mashreq')) return 0;

  return PAKISTAN_FY_2025_26.atmOtherBankFee;
}
