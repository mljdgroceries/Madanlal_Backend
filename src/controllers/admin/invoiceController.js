const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");
const Order = require("../../models/orderModel");
const Warehouse = require("../../models/warehouseModel");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const { catchAsyncError } = require("../../utils/generateError");

const formatCurrency = (value) => `Rs.${Number(value || 0).toFixed(2)}`;

const numberToWords = (num) => {
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const twoDigits = (n) => {
    if (n < 20) return ones[n];
    const ten = Math.floor(n / 10);
    const unit = n % 10;
    return `${tens[ten]}${unit ? ` ${ones[unit]}` : ""}`.trim();
  };

  const threeDigits = (n) => {
    const hundred = Math.floor(n / 100);
    const rest = n % 100;
    if (!hundred) return twoDigits(rest);
    return `${ones[hundred]} Hundred${rest ? ` ${twoDigits(rest)}` : ""}`.trim();
  };

  if (!Number.isFinite(num) || num < 0) return "Zero";
  if (num === 0) return "Zero";

  let n = Math.floor(num);
  const parts = [];

  const crore = Math.floor(n / 10000000);
  if (crore) {
    parts.push(`${threeDigits(crore)} Crore`);
    n %= 10000000;
  }

  const lakh = Math.floor(n / 100000);
  if (lakh) {
    parts.push(`${threeDigits(lakh)} Lakh`);
    n %= 100000;
  }

  const thousand = Math.floor(n / 1000);
  if (thousand) {
    parts.push(`${threeDigits(thousand)} Thousand`);
    n %= 1000;
  }

  if (n) parts.push(threeDigits(n));
  return parts.join(" ").replace(/\s+/g, " ").trim();
};

const amountToWords = (amount) => {
  const safeAmount = Number(amount || 0);
  const rupees = Math.floor(safeAmount);
  const paise = Math.round((safeAmount - rupees) * 100);

  const rupeesWords = numberToWords(rupees);
  if (!paise) return `INR ${rupeesWords} Only`;
  const paiseWords = numberToWords(paise);
  return `INR ${rupeesWords} and ${paiseWords} Paise Only`;
};

const formatDate = (value) => {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toLocaleDateString("en-GB");
};

const resolveInvoiceNumber = (order) => {
  if (order.invoiceNumber) return order.invoiceNumber;
  if (order.invoiceNumber) return order.invoiceNumber;
  if (order.orderId) return `INV-${order.orderId}`;
  return `INV-${String(order._id).slice(-8).toUpperCase()}`;
};

const getOrderQuery = (orderId) =>
  mongoose.Types.ObjectId.isValid(orderId) ? { _id: orderId } : { orderId };

const renderItemsTable = (doc, rows, startY) => {
  const tableX = 35;
  let y = startY;
  const headerHeight = 24;
  const minRowHeight = 24;
  const maxDescriptionLines = 2;

  const colWidths = {
    sr: 24,
    desc: 96,
    hsn: 40,
    cgst: 35,
    sgst: 35,
    qty: 28,
    baseAmount: 72,
    rate: 82,
    per: 30,
    amount: 61,
  };

  const fitTextToTwoLines = (text, width) => {
    const raw = String(text || "");
    if (!raw) return "";

    const fullHeight = doc.heightOfString(raw, { width, lineGap: 0 });
    const maxAllowedHeight = doc.currentLineHeight() * maxDescriptionLines;
    if (fullHeight <= maxAllowedHeight) return raw;

    let truncated = raw;
    while (truncated.length > 0) {
      truncated = truncated.slice(0, -1);
      const candidate = `${truncated}...`;
      const candidateHeight = doc.heightOfString(candidate, { width, lineGap: 0 });
      if (candidateHeight <= maxAllowedHeight) return candidate;
    }
    return "...";
  };

  const getRowHeight = (row) => {
    const descWidth = colWidths.desc - 10;
    doc.font("Helvetica").fontSize(8);
    const safeDescription = fitTextToTwoLines(row.desc, descWidth);
    const descHeight = doc.heightOfString(safeDescription, { width: descWidth, lineGap: 0 });
    return Math.max(minRowHeight, Math.ceil(descHeight) + 12);
  };

  const drawRow = (yPos, row, isHeader = false, dynamicHeight = minRowHeight) => {
    let x = tableX;
    const currentRowHeight = isHeader ? headerHeight : dynamicHeight;

    const style = isHeader ? "Helvetica-Bold" : "Helvetica";
    doc.font(style).fontSize(8);

    const cells = [
      row.sr,
      row.desc,
      row.hsn,
      row.cgst,
      row.sgst,
      row.qty,
      row.baseAmount,
      row.rate,
      row.per,
      row.amount,
    ];

    const widths = Object.values(colWidths);

    cells.forEach((text, i) => {
      doc
        .rect(x, yPos, widths[i], currentRowHeight)
        .strokeColor("#E3E3E3")
        .lineWidth(0.8)
        .stroke();

      const align = isHeader ? "center" : i === 8 ? "center" : i >= 5 ? "right" : "left";
      const textY = isHeader ? yPos + 6 : yPos + 8;
      const lineGap = 0;

      const cellText =
        !isHeader && i === 1 ? fitTextToTwoLines(text, widths[i] - 10) : String(text || "");

      doc.text(cellText, x + 5, textY, {
        width: widths[i] - 10,
        align,
        lineGap,
      });

      x += widths[i];
    });
  };

  drawRow(
    y,
    {
      sr: "#",
      desc: "DESCRIPTION",
      hsn: "HSN/SAC",
      cgst: "CGST",
      sgst: "SGST",
      qty: "QTY",
      baseAmount: "Price\n(Without GST)",
      per: "Per",
      rate: "Price\n(With GST)",
      amount: "Amount\n(With GST)",
    },
    true,
  );

  y += headerHeight;

  rows.forEach((item, index) => {
    const row = {
      sr: String(index + 1),
      desc: item.description,
      hsn: item.hsnCode || "-",
      cgst: `${item.cgstPercent}%`,
      sgst: `${item.sgstPercent}%`,
      qty: String(item.quantity),
      baseAmount: formatCurrency(item.baseAmount),
      rate: formatCurrency(item.unitRate),
      per: "PCS",
      amount: formatCurrency(item.amount),
    };
    const dynamicRowHeight = getRowHeight(row);
    drawRow(y, row, false, dynamicRowHeight);
    y += dynamicRowHeight;
  });

  return y + 10;
};

const renderInvoicePdf = ({ order, user, items, totals, warehouseAddress, warehousePhone, warehouseEmail }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 30 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const invoiceNo = resolveInvoiceNumber(order);
    const companyName = process.env.INVOICE_COMPANY_NAME || "MLJD GROCERIES PVT LTD";
    const companyAddress = warehouseAddress ||
      process.env.INVOICE_COMPANY_ADDRESS ||
      "H.NO. 1, BASANT AWAS, MAHARAJA AGRASEN MARG, AGRA, 202005";
    const companyGstin = process.env.INVOICE_COMPANY_GSTIN || "NA";
    const companyCin = process.env.INVOICE_COMPANY_CIN || "NA";
    const companyPhone = warehousePhone || process.env.INVOICE_COMPANY_PHONE || "N/A";
    const companyEmail = warehouseEmail || process.env.INVOICE_COMPANY_EMAIL || "N/A";
    const buyerName = order.deliveryAddress?.fullName || user?.fullName || "N/A";
    const buyerPhone = order.deliveryAddress?.phoneNumber || user?.phone || "N/A";
    const buyerAddress = [order.deliveryAddress?.houseFlatOfficeNo, order.deliveryAddress?.area_building, order.deliveryAddress?.address, order.deliveryAddress?.landmark].filter(Boolean).join(", ") || "N/A";
    const buyerPincode = order.deliveryAddress?.pincode || "";
    const stateText = "UTTAR PRADESH (Code: 09)";

    // === HEADER SECTION (dynamic Y) ===
    doc.font("Helvetica-Bold").fontSize(18).text(companyName, 35, 35);
    doc.font("Helvetica").fontSize(9).text(companyAddress, 35, 60, { width: 300 });
    const companyAddrHeight = doc.heightOfString(companyAddress, { width: 300 });
    const gstinY = Math.max(88, 60 + companyAddrHeight + 6);
    doc.text(`GSTIN: ${companyGstin}`, 35, gstinY);
    doc.text(`CIN: ${companyCin}`, 35, gstinY + 16);

    doc.font("Helvetica-Bold").fontSize(16).text("TAX INVOICE", 390, 35);
    doc.font("Helvetica").fontSize(9).text(`Invoice No: ${invoiceNo}`, 390, 62, {
      width: 160,
      align: "right",
    });
    doc.text(`Date: ${formatDate(order.createdAt)}`, 390, 78, {
      width: 160,
      align: "right",
    });

    // === E-WAY / STATE / SHIPPING SECTION ===
    const sep1Y = Math.max(125, gstinY + 32);
    doc.moveTo(35, sep1Y).lineTo(560, sep1Y).strokeColor("#E3E3E3").lineWidth(1).stroke();
    const labelsY = sep1Y + 13;
    const valuesY = labelsY + 16;
    doc.font("Helvetica").fontSize(8);
    doc.text("E-WAY BILL NO.", 35, labelsY);
    doc.text("STATE", 230, labelsY);
    doc.text("SHIPPING ADDRESS", 390, labelsY);
    doc.font("Helvetica-Bold").fontSize(10).text("____", 35, valuesY);
    doc.text(stateText, 230, valuesY);
    doc.font("Helvetica-Bold").fontSize(10).text(buyerName, 390, valuesY, { width: 170 });
    const shippingAddrY = valuesY + doc.heightOfString(buyerName, { width: 170 }) + 6;
    doc.font("Helvetica").fontSize(9);
    doc.text(`${buyerAddress}${buyerPincode ? `, ${buyerPincode}` : ""}`, 390, shippingAddrY, { width: 170 });
    const shippingAddrHeight = doc.heightOfString(`${buyerAddress}${buyerPincode ? `, ${buyerPincode}` : ""}`, { width: 170 });
    const shippingPhoneY = shippingAddrY + shippingAddrHeight + 8;
    doc.font("Helvetica-Bold").fontSize(9).text(`Phone No.: ${buyerPhone}`, 390, shippingPhoneY, { width: 170 });
    const shippingBottomY = shippingPhoneY + doc.heightOfString(`Phone No.: ${buyerPhone}`, { width: 170 });

    // === SEPARATOR (adapts to shipping address height) ===
    const sep2Y = Math.max(sep1Y + 57, shippingBottomY + 14);
    doc.moveTo(35, sep2Y).lineTo(560, sep2Y).strokeColor("#EDEDED").lineWidth(1).stroke();

    // === BUYER / COMPANY CONTACT SECTION (dynamic Y) ===
    const buyerLabelY = sep2Y + 16;
    const buyerNameY = buyerLabelY + 16;
    const buyerAddrY = buyerNameY;
    const buyerFullAddr = `${buyerAddress}${buyerPincode ? `, ${buyerPincode}` : ""}`;

    doc.font("Helvetica").fontSize(8).text("BUYER (BILL TO)", 35, buyerLabelY);
    doc.font("Helvetica").fontSize(9).text(buyerFullAddr, 35, buyerAddrY, {
      width: 190,
    });
    const buyerAddrHeight = doc.heightOfString(buyerFullAddr, { width: 190 });
    const buyerBottomY = buyerAddrY + buyerAddrHeight;

    doc.font("Helvetica").fontSize(8).text("Company Contact", 360, buyerLabelY, {
      width: 190,
      align: "right",
    });
    doc.font("Helvetica").fontSize(9).text(`Tel: ${companyPhone}`, 360, buyerNameY, {
      width: 190,
      align: "right",
    });
    doc.text(`Email: ${companyEmail}`, 360, buyerNameY + 16, {
      width: 190,
      align: "right",
      ellipsis: true,
    });

    // === ITEMS TABLE (starts after buyer section) ===
    const tableStartY = Math.max(buyerBottomY + 26, sep2Y + 118);
    const tableEndY = renderItemsTable(doc, items, tableStartY);
    doc.moveTo(35, tableEndY).lineTo(560, tableEndY).strokeColor("#E3E3E3").stroke();

    const totalsY = tableEndY + 12;
    doc.font("Helvetica-Bold").fontSize(10).text("Amount Chargeable (in words):", 35, totalsY);
    doc.font("Helvetica").fontSize(9).text(amountToWords(totals.grandTotal), 35, totalsY + 20, {
      width: 300,
    });

    const rightX = 360;
    const valueX = 550;
    let tY = totalsY;
    const addRow = (label, value) => {
      doc.font("Helvetica").fontSize(10);
      doc.text(label, rightX, tY);
      doc.text(Number(value || 0).toFixed(2), valueX - 70, tY, { width: 70, align: "right" });
      tY += 22;
    };

    addRow("Sub-Total", totals.subTotal);
    addRow("Delivery Charge (excluding tax)", totals.deliveryCharge);
    addRow("Platform Fee (excluding tax)", totals.platformFee);
    addRow("CGST Amount", totals.totalCgst);
    addRow("SGST Amount", totals.totalSgst);
    if (Number(totals.couponDiscount || 0) > 0) {
      addRow("Discount", totals.couponDiscount);
    }
    tY += 4;
    doc.moveTo(rightX, tY).lineTo(550, tY).strokeColor("#E3E3E3").stroke();
    tY += 8;

    doc.font("Helvetica-Bold").fontSize(12);
    doc.text("Total", rightX, tY);
    doc.text(`Rs.${Number(totals.grandTotal || 0).toFixed(2)}`, valueX - 95, tY - 2, {
      width: 95,
      align: "right",
    });

    doc.font("Helvetica-Bold").fontSize(10).text("Declaration:", 35, totalsY + 48);
    doc.font("Helvetica").fontSize(9).text(
      "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
      35,
      totalsY + 66,
      { width: 280 },
    );

    doc.font("Helvetica-Bold").fontSize(9).text(
      "Delivery charge and Platform Fee taxed at 18%",
      35,
      totalsY + 96,
      { width: 280 }
    );

    // === FOOTER (dynamic Y based on content above) ===
    const footerLineY = Math.max(640, tY + 50, totalsY + 130);
    doc.moveTo(35, footerLineY).lineTo(560, footerLineY).strokeColor("#E9E9E9").stroke();
    doc.font("Helvetica").fontSize(8).text("Terms: Standard terms apply. Subject to Agra Jurisdiction.", 35, footerLineY + 22);
    doc.text("This is a Computer Generated Invoice", 35, footerLineY + 40);
    doc.moveTo(450, footerLineY + 50).lineTo(560, footerLineY + 50).strokeColor("#BBBBBB").stroke();
    doc.font("Helvetica-Bold").fontSize(8).text("Authorised Signatory", 463, footerLineY + 66);
    doc.font("Helvetica").fontSize(8).text(`for ${companyName}.`, 468, footerLineY + 82);

    doc.end();
  });

exports.downloadInvoice = catchAsyncError(async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "orderId is required.",
    });
  }

  const order = await Order.findOne(getOrderQuery(orderId))
    .populate("items.productId", "productName hsnCode")
    .populate("userId", "fullName phone email");

  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }

  const returnedQtyByVariation = new Map();
  (order.returnedItemsDetails || []).forEach((ret) => {
    const key = ret?.variationId?.toString?.();
    if (!key) return;
    returnedQtyByVariation.set(
      key,
      (returnedQtyByVariation.get(key) || 0) + (Number(ret?.quantity) || 0),
    );
  });

  const shouldSubtractReturned =
    order.status !== "Delivered" && !order.tracking?.isDelivered;

  const items = (order.items || []).map((item) => {
    const quantity = Number(item.quantity || 0);
    const variationKey = item?.variationId?.toString?.();
    const returnedQty = variationKey ? returnedQtyByVariation.get(variationKey) || 0 : 0;
    const netQuantity = shouldSubtractReturned
      ? Math.max(quantity - returnedQty, 0)
      : quantity;
    if (netQuantity <= 0) return null;

    const subtotal = Number(item.subtotal || 0);
    const storedUnitRate = Number(item.priceWithGST || 0);
    const derivedUnitRate =
      storedUnitRate > 0
        ? storedUnitRate
        : quantity > 0 && subtotal > 0
          ? subtotal / quantity
          : Number(item.basePrice || 0);
    const gstPercent = Number(item.gstPercent || 0);
    const lineAmountWithGst = Number((netQuantity * derivedUnitRate).toFixed(2));
    const netGstAmount =
      gstPercent > 0
        ? Number((lineAmountWithGst - lineAmountWithGst / (1 + gstPercent / 100)).toFixed(2))
        : 0;
    const lineBaseAmount = Number((lineAmountWithGst - netGstAmount).toFixed(2));
    const baseAmount = netQuantity > 0
      ? Number((lineBaseAmount / netQuantity).toFixed(2))
      : Number(item.basePrice || 0);

    return {
      description: item.productId?.productName || "Product",
      hsnCode: item.productId?.hsnCode || "-",
      quantity: netQuantity,
      baseAmount,
      lineBaseAmount,
      unitRate: Number(derivedUnitRate.toFixed(2)),
      amount: lineAmountWithGst,
      cgstPercent: Number((gstPercent / 2).toFixed(2)),
      sgstPercent: Number((gstPercent / 2).toFixed(2)),
      cgstAmount: Number((netGstAmount / 2).toFixed(2)),
      sgstAmount: Number((netGstAmount / 2).toFixed(2)),
    };
  }).filter(Boolean);

  const computedItemsSubTotal = Number(
    items.reduce((sum, item) => sum + Number(item.lineBaseAmount || 0), 0).toFixed(2),
  );
  const safeSubTotal = computedItemsSubTotal;
  const deliveryCharge = Number(order.deliveryCharge || 0);
  const platformFee = Number(order.platformFee || 0);
  const storedDiscount = Number(order.couponDiscount || 0);



  // Calculate GST for delivery and platform fees (18% inclusive — matches Petpooja)
  const { calcInclusiveFeeTax } = require("../../integrations/petpooja/constants/taxMapping");
  const calcNetAndTax = (fee) => {
    const { net, tax } = calcInclusiveFeeTax(fee, 18);
    return { net, tax };
  };
  const { net: deliveryNet, tax: deliveryTax } = calcNetAndTax(deliveryCharge);
  const { net: platformNet, tax: platformTax } = calcNetAndTax(platformFee);
  // Split GST into CGST & SGST equally
  const feeCgst = Number(((deliveryTax + platformTax) / 2).toFixed(2));
  const feeSgst = feeCgst;
  // Update tax totals to include fee taxes
  const totalCgst = Number((
    items.reduce((sum, item) => sum + Number(item.cgstAmount || 0), 0) + feeCgst
  ).toFixed(2));
  const totalSgst = Number((
    items.reduce((sum, item) => sum + Number(item.sgstAmount || 0), 0) + feeSgst
  ).toFixed(2));
  const grandTotal = Number(
    Math.max(safeSubTotal + totalCgst + totalSgst + deliveryNet + platformNet - storedDiscount, 0).toFixed(2)
  );

  const totals = {
    subTotal: safeSubTotal,
    totalCgst,
    totalSgst,
    deliveryCharge: deliveryNet,
    platformFee: platformNet,
    couponDiscount: storedDiscount,
    grandTotal,
  };

  // Fetch default warehouse address from DB
  const defaultWarehouse = await Warehouse.findOne({ isDefault: true, isActive: true });

  const pdfBuffer = await renderInvoicePdf({
    order,
    user: order.userId,
    items,
    totals,
    warehouseAddress: defaultWarehouse?.address || null,
    warehousePhone: defaultWarehouse?.phone || null,
    warehouseEmail: defaultWarehouse?.email || null,
  });

  const filename = `${resolveInvoiceNumber(order)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(pdfBuffer);
});
