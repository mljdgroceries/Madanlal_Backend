const GST_TAX_GROUP_MAP = {
  0: 1,
  5: 3,
  12: 5,
  18: 7,
  28: 9,
  3: 11,
  40: 13,
};

const ITEM_GST_TAX_IDS = {
  0: { intra: 1, inter: 2 },
  5: { intra: 3, inter: 4 },
  12: { intra: 5, inter: 6 },
  18: { intra: 7, inter: 8 },
  28: { intra: 9, inter: 10 },
  3: { intra: 11, inter: 12 },
  40: { intra: 13, inter: 14 },
};

// Component tax IDs returned by Petpooja's voucher-init endpoint for intra-state GST.
const INTRA_COMPONENT_TAX_IDS = {
  0: { cgst: 1, sgst: 2 },
  5: { cgst: 4, sgst: 5 },
  12: { cgst: 7, sgst: 8 },
  18: { cgst: 10, sgst: 11 },
  28: { cgst: 13, sgst: 14 },
  3: { cgst: 16, sgst: 17 },
  40: { cgst: 19, sgst: 20 },
};

const resolveGstPercent = (...values) => {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  return 0;
};

const getPetpoojaTaxGroupId = (gstPercent) =>
  GST_TAX_GROUP_MAP[Number(gstPercent)] ?? GST_TAX_GROUP_MAP[18];

const getPetpoojaItemGstTaxIds = (gstPercent) =>
  ITEM_GST_TAX_IDS[Number(gstPercent)] ?? ITEM_GST_TAX_IDS[18];

const getPetpoojaIntraComponentTaxIds = (gstPercent) =>
  INTRA_COMPONENT_TAX_IDS[Number(gstPercent)] ?? INTRA_COMPONENT_TAX_IDS[18];

const calcInclusiveFeeTax = (fee, gstPercent = 18) => {
  const amount = Number(fee || 0);
  if (amount <= 0) return { net: 0, tax: 0, taxable: 0 };
  const taxable = Number((amount / (1 + gstPercent / 100)).toFixed(2));
  const tax = Number((amount - taxable).toFixed(2));
  return { net: taxable, tax, taxable };
};

module.exports = {
  GST_TAX_GROUP_MAP,
  ITEM_GST_TAX_IDS,
  resolveGstPercent,
  getPetpoojaTaxGroupId,
  getPetpoojaItemGstTaxIds,
  getPetpoojaIntraComponentTaxIds,
  calcInclusiveFeeTax,
};
