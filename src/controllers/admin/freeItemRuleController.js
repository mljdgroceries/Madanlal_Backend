const FreeItemRule = require("../../models/freeItemRuleModel");
const FreeItem = require("../../models/freeItemModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");

const normalizeMinOrderValue = (value) => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) return String(asNumber);
  return trimmed;
};

const parseOptionalDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const validityOverlaps = (aFrom, aUntil, bFrom, bUntil) => {
  const leftFrom = aFrom || new Date(0);
  const leftUntil = aUntil || new Date(8640000000000000);
  const rightFrom = bFrom || new Date(0);
  const rightUntil = bUntil || new Date(8640000000000000);

  return (
    leftFrom.getTime() <= rightUntil.getTime() &&
    rightFrom.getTime() <= leftUntil.getTime()
  );
};

exports.createFreeItemRule = catchAsyncError(async (req, res) => {
  const {
    ruleName,
    minOrderValue,
    usageLimitPerCustomer,
    validFrom,
    validUntil,
    description,
    status,
    freeItems,
    freeItemQuantity,
    isFirstTimeCustomer,
  } = req.body;

  // Validation
  if (!ruleName || !minOrderValue || !freeItems || !freeItemQuantity) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Rule name, minimum order value, free item, and quantity are required.",
    });
  }

  // ✅ Check if the free item exists
  const normalizedMinOrderValue = normalizeMinOrderValue(minOrderValue);
  const rawMinOrderValue = String(minOrderValue).trim();
  const validFromDate = parseOptionalDate(validFrom);
  const validUntilDate = parseOptionalDate(validUntil);

  if (validFrom && !validFromDate) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid validFrom date.",
    });
  }

  if (validUntil && !validUntilDate) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid validUntil date.",
    });
  }

  if (
    validFromDate &&
    validUntilDate &&
    validFromDate.getTime() > validUntilDate.getTime()
  ) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "validFrom cannot be after validUntil.",
    });
  }

  const candidates = await FreeItemRule.find({
    minOrderValue: { $in: [rawMinOrderValue, normalizedMinOrderValue] },
    status: { $ne: "Deleted" },
  })
    .select("validFrom validUntil")
    .lean();

  const hasOverlap = (candidates || []).some((rule) =>
    validityOverlaps(rule.validFrom, rule.validUntil, validFromDate, validUntilDate)
  );

  if (hasOverlap) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message:
        "A free item rule with the same minimum order value already exists for an overlapping validity period.",
    });
  }

  const freeItemData = await FreeItem.findById(freeItems);
  if (!freeItemData) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Free item not found.",
    });
  }

  // ✅ Check stock availability
  if (freeItemData.stock < freeItemQuantity) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: `Insufficient stock for item "${freeItemData.productName}". Available: ${freeItemData.stock}, Required: ${freeItemQuantity}`,
    });
  }

  // ✅ Create the new rule
  const newRule = await FreeItemRule.create({
    ruleName,
    minOrderValue: normalizedMinOrderValue,
    usageLimitPerCustomer,
    validFrom: validFromDate,
    validUntil: validUntilDate,
    description,
    status,
    freeItems,
    freeItemQuantity,
    isFirstTimeCustomer,
  });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Free item rule created successfully.",
    data: newRule,
  });
});

exports.getAllFreeItemRules = catchAsyncError(async (req, res) => {
  let { search, page, limit, status } = req.query;

  page = parseInt(page) 
  limit = parseInt(limit) 
  const skip = (page - 1) * limit;

  let query = { status: { $ne: "Deleted" } };

  // 🔍 Search by ruleName or description
  if (search) {
    const regex = new RegExp(search, "i");
    query.$or = [
      { ruleName: regex },
      { freeItemQuantity: regex },
      { minOrderValue: regex },
    ];
  }

   if (status) {
    query.status = status;
  }

  // 📊 Get total count
  const total = await FreeItemRule.countDocuments(query);

  // 📦 Fetch paginated + sorted data
  const rules = await FreeItemRule.find(query)
    .populate("freeItems", "productName productImage")
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(limit);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Free item rules fetched successfully.",
    data: {
      rules,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
});

exports.getFreeItemRuleById = catchAsyncError(async (req, res) => {
  const { ruleId } = req.query;

  const rule = await FreeItemRule.findById(ruleId)
//   .populate("freeItems");

  if (!rule) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Free item rule not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Free item rule fetched successfully.",
    data: rule,
  });
});
exports.updateFreeItemRule = catchAsyncError(async (req, res) => {
  const { ruleId } = req.query;
  const {
    freeItems,
    freeItemQuantity,
    ...updatedData
  } = req.body;

  // ✅ Check if rule exists
  const existingRule = await FreeItemRule.findById(ruleId);
  if (!existingRule) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Free item rule not found.",
    });
  }

  // ✅ If user tries to update freeItems or quantity, validate them
  const nextMinOrderValue = updatedData.minOrderValue ?? existingRule.minOrderValue;
  const normalizedMinOrderValue = normalizeMinOrderValue(nextMinOrderValue);
  const rawMinOrderValue = String(nextMinOrderValue).trim();

  const nextValidFrom = updatedData.validFrom ?? existingRule.validFrom;
  const nextValidUntil = updatedData.validUntil ?? existingRule.validUntil;

  const validFromDate = parseOptionalDate(nextValidFrom);
  const validUntilDate = parseOptionalDate(nextValidUntil);

  if (updatedData.validFrom && !validFromDate) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid validFrom date.",
    });
  }

  if (updatedData.validUntil && !validUntilDate) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid validUntil date.",
    });
  }

  if (
    validFromDate &&
    validUntilDate &&
    validFromDate.getTime() > validUntilDate.getTime()
  ) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "validFrom cannot be after validUntil.",
    });
  }

  const candidates = await FreeItemRule.find({
    _id: { $ne: ruleId },
    minOrderValue: { $in: [rawMinOrderValue, normalizedMinOrderValue] },
    status: { $ne: "Deleted" },
  })
    .select("validFrom validUntil")
    .lean();

  const hasOverlap = (candidates || []).some((rule) =>
    validityOverlaps(rule.validFrom, rule.validUntil, validFromDate, validUntilDate)
  );

  if (hasOverlap) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message:
        "Another free item rule with the same minimum order value exists for an overlapping validity period.",
    });
  }

  if (freeItems || freeItemQuantity) {
    const freeItemIdToCheck = freeItems || existingRule.freeItems;
    const quantityToCheck = freeItemQuantity || existingRule.freeItemQuantity;

    const freeItemData = await FreeItem.findById(freeItemIdToCheck);

    if (!freeItemData) {
      return responseHandler({
        res,
        code: statusCode.RESULTNOTFOUND,
        message: "Free item not found.",
      });
    }

    // ✅ Check stock availability
    if (freeItemData.stock < quantityToCheck) {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: `Insufficient stock for item "${freeItemData.productName}". Available: ${freeItemData.stock}, Required: ${quantityToCheck}`,
      });
    }
  }
  // ✅ Prepare update fields properly
  const updateFields = { ...updatedData };
  if (freeItems) updateFields.freeItems = freeItems;
  if (freeItemQuantity) updateFields.freeItemQuantity = freeItemQuantity;
  if (updatedData.minOrderValue !== undefined) {
    updateFields.minOrderValue = normalizedMinOrderValue;
  }
  if (updatedData.validFrom !== undefined) updateFields.validFrom = validFromDate;
  if (updatedData.validUntil !== undefined) updateFields.validUntil = validUntilDate;

  // ✅ Proceed with update
  const updatedRule = await FreeItemRule.findByIdAndUpdate(
    ruleId,
    { $set: updateFields },
    { new: true }
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Free item rule updated successfully.",
    data: updatedRule,
  });
});

exports.deleteFreeItemRule = catchAsyncError(async (req, res) => {
  const { ruleId } = req.query;

  const rule = await FreeItemRule.findByIdAndUpdate(ruleId, { status: "Deleted" }, { new: true });

  if (!rule) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Free item rule not found.",
    });
  }

  return responseHandler({ 
    res,
    code: statusCode.SUCCESS,
    message: "Free item rule deleted successfully.",
  });
});

