const { DeliverySlot } = require("../models/deliverySlotModel");
const StoredClosure = require("../models/storedClosureModel");

const IST_OFFSET_MINUTES = 330; // Asia/Kolkata is UTC+05:30 (no DST)
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const getISTParts = (date) => {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
};

const makeISTMidnightDate = ({ year, month, day }) => {
  const utcMidnightMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return new Date(utcMidnightMs - IST_OFFSET_MINUTES * 60 * 1000);
};

const formatISTYMD = (date) => {
  const { year, month, day } = getISTParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const isTimeInRange = (timeMin, startMin, endMin) => {
  // Treat 23:59 cutoff as "end of day" so 23:59 orders still match.
  const normalizedEndMin = endMin === 23 * 60 + 59 ? 24 * 60 : endMin;

  if (startMin === normalizedEndMin) return true; // full-day range
  if (startMin < normalizedEndMin) {
    return timeMin >= startMin && timeMin < normalizedEndMin;
  }
  return timeMin >= startMin || timeMin < normalizedEndMin; // wraps midnight
};

/**
 * Convert time string (e.g., "2:00 PM", "14:00") to minutes from midnight
 */
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;

  const cleanTime = timeStr.trim().toUpperCase();

  if (cleanTime.includes("AM") || cleanTime.includes("PM")) {
    const parts = cleanTime.split(/\s*(AM|PM)/);
    const timePart = parts[0];
    const period = parts[1];

    const timeSplit = timePart.split(":");
    let hour = parseInt(timeSplit[0]);
    const minute = timeSplit[1] ? parseInt(timeSplit[1]) : 0;

    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;

    return hour * 60 + minute;
  } else {
    const timeSplit = cleanTime.split(":");
    const hour = parseInt(timeSplit[0]);
    const minute = timeSplit[1] ? parseInt(timeSplit[1]) : 0;
    return hour * 60 + minute;
  }
};

/**
 * Format date to YYYY-MM-DD string for comparison
 */
const formatDateToString = (date) => formatISTYMD(date);

/**
 * Check if a date matches any closure date (handles multiple date formats)
 */
const isClosureDate = (date, closureDates) => {
  if (!closureDates || closureDates.length === 0) return false;
  
  const dateStr = formatDateToString(date);
  const { year: dateYear, month: dateMonth, day: dateDay } = getISTParts(date);

  return closureDates.some(closureDate => {
    if (!closureDate) return false;
    
    const normalizedClosure = String(closureDate).trim();
    
    // Try to parse as Date object first (handles ISO strings, timestamps, etc.)
    const closureDateObj = new Date(normalizedClosure);
    if (!isNaN(closureDateObj.getTime())) {
      const closureDateStr = formatDateToString(closureDateObj);
      if (closureDateStr === dateStr) return true;
    }
    
    // Try string matching with common formats
    // YYYY-MM-DD format
    if (normalizedClosure === dateStr) return true;
    
    // DD-MM-YYYY format (with or without padding)
    const ddMMyyyy1 = `${dateDay}-${dateMonth}-${dateYear}`;
    const ddMMyyyy2 = `${String(dateDay).padStart(2, '0')}-${String(dateMonth).padStart(2, '0')}-${dateYear}`;
    if (normalizedClosure === ddMMyyyy1 || normalizedClosure === ddMMyyyy2) return true;
    
    // DD/MM/YYYY format (with or without padding)
    const ddMMyyyySlash1 = `${dateDay}/${dateMonth}/${dateYear}`;
    const ddMMyyyySlash2 = `${String(dateDay).padStart(2, '0')}/${String(dateMonth).padStart(2, '0')}/${dateYear}`;
    if (normalizedClosure === ddMMyyyySlash1 || normalizedClosure === ddMMyyyySlash2) return true;
    
    return false;
  });
};

/**
 * Calculate expected delivery date & window (skips closure days)
 */
const calculateExpectedDeliveryDate = async (orderTime = new Date(), options = {}) => {
  // convert UTC → IST
  const orderIst = getISTParts(orderTime);
  const orderTimeInMinutes = orderIst.hour * 60 + orderIst.minute;
  const orderDayStartIST = makeISTMidnightDate(orderIst);

  const slots = Array.isArray(options.slots)
    ? options.slots
    : await DeliverySlot.find({ enabled: true }).lean();
  const slotWithMinutes = (slots || []).map((slot) => ({
    ...slot,
    orderStartMinutes: timeToMinutes(slot.orderStartTime),
    orderCutoffMinutes: timeToMinutes(slot.orderCutoffTime),
  }));

  const orderedSlots = slotWithMinutes.sort(
    (a, b) => a.orderStartMinutes - b.orderStartMinutes
  );

  const matchedSlot =
    orderedSlots.find((slot) =>
      isTimeInRange(orderTimeInMinutes, slot.orderStartMinutes, slot.orderCutoffMinutes)
    ) || null;

  const fallbackSameDayWindow = { startTime: "16:00", endTime: "21:00" };
  const fallbackNextDayWindow = { startTime: "10:00", endTime: "13:00" };

  const sameDaySlot = orderedSlots.find((s) => s.slotType === "SAME_DAY") || null;
  const nextDaySlot = orderedSlots.find((s) => s.slotType === "NEXT_DAY") || null;

  let intendedTag = matchedSlot?.slotType;
  if (!intendedTag) {
    // Backward-compatible fallback: 00:00-13:59 same-day, 14:00+ next-day
    intendedTag = orderTimeInMinutes < 14 * 60 ? "SAME_DAY" : "NEXT_DAY";
  }

  let deliveryDate =
    intendedTag === "SAME_DAY"
      ? new Date(orderDayStartIST)
      : new Date(orderDayStartIST.getTime() + MS_PER_DAY);
  let deliveryTag = intendedTag;
  let deliveryWindow =
    intendedTag === "SAME_DAY"
      ? sameDaySlot?.deliveryWindow || fallbackSameDayWindow
      : nextDaySlot?.deliveryWindow || fallbackNextDayWindow;

  // 00:00 - 13:59 → Same Day Evening

  // 14:00 - 23:59 → Next Day Morning


  // Get all store closures
  const closures = Array.isArray(options.closures)
    ? options.closures
    : await StoredClosure.find({});
  const closureDates = (closures || [])
    .map((c) => (c && typeof c === "object" ? c.closureDate : c))
    .filter(Boolean);

  // Skip closure days - keep incrementing until we find a non-closure day
  let maxAttempts = 30; // Prevent infinite loop (max 30 days ahead)
  let attempts = 0;
  
  while (isClosureDate(deliveryDate, closureDates) && attempts < maxAttempts) {
    deliveryDate = new Date(deliveryDate.getTime() + MS_PER_DAY);
    attempts++;
  }

  deliveryTag = getDeliveryTag(deliveryDate, orderTime);
  deliveryWindow =
    deliveryTag === "SAME_DAY"
      ? sameDaySlot?.deliveryWindow || fallbackSameDayWindow
      : nextDaySlot?.deliveryWindow || fallbackNextDayWindow;

  // If we hit max attempts, log warning but return the date anyway
  if (attempts >= maxAttempts) {
    console.warn(`Warning: Could not find non-closure date within ${maxAttempts} days`);
  }

  return {
    deliveryDate,
    deliveryTag,
    deliveryWindow
  };
};

/**
 * Get delivery tag from delivery date
 */
const getDeliveryTag = (deliveryDate, now = new Date()) => {
  if (!deliveryDate) return "NEXT_DAY";

  const todayYmd = getISTParts(now);
  const deliveryYmd = getISTParts(new Date(deliveryDate));

  const isSameDay =
    deliveryYmd.year === todayYmd.year &&
    deliveryYmd.month === todayYmd.month &&
    deliveryYmd.day === todayYmd.day;

  if (isSameDay) {
    return "SAME_DAY";
  }

  const todayStart = makeISTMidnightDate(todayYmd);
  const tomorrow = new Date(todayStart.getTime() + MS_PER_DAY);
  const tomorrowYmd = getISTParts(tomorrow);

  const isTomorrow =
    deliveryYmd.year === tomorrowYmd.year &&
    deliveryYmd.month === tomorrowYmd.month &&
    deliveryYmd.day === tomorrowYmd.day;

  if (isTomorrow) {
    return "NEXT_DAY";
  }

  return "NEXT_DAY";
};

module.exports = {
  calculateExpectedDeliveryDate,
  getDeliveryTag,
  timeToMinutes
};
