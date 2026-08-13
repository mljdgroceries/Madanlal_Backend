const path = require("path");

const getExcelJs = () => {
  try {
    // eslint-disable-next-line global-require
    return require("exceljs");
  } catch (err) {
    const error = new Error(
      "exceljs is not installed. Please run: npm install exceljs"
    );
    error.cause = err;
    throw error;
  }
};

const normalizeFileName = (fileName) => {
  const base = String(fileName || "export.xlsx").trim() || "export.xlsx";
  const ext = path.extname(base).toLowerCase();
  if (ext === ".xlsx") return base;
  return `${base}.xlsx`;
};

const safeCell = (value) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  return value;
};

const autoFitColumns = (worksheet, { sampleSize = 200, min = 10, max = 60 } = {}) => {
  const columns = worksheet.columns || [];
  columns.forEach((col) => {
    const headerLen = col.header ? String(col.header).length : 0;
    let best = headerLen;
    const key = col.key;
    if (!key) return;

    const values = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (values.length >= sampleSize) return;
      values.push(row.getCell(key).value);
    });

    values.forEach((v) => {
      if (v === null || v === undefined) return;
      const text =
        typeof v === "object" && v.text ? String(v.text) : String(v);
      best = Math.max(best, text.length);
    });

    col.width = Math.max(min, Math.min(max, best + 2));
  });
};

const addSheet = (workbook, { name, columns, rows, autoFit = true }) => {
  const worksheet = workbook.addWorksheet(String(name || "Sheet1"));
  worksheet.columns = (columns || []).map((c) => ({
    ...c,
    key: c.key,
    header: c.header,
  }));

  const safeRows = (rows || []).map((r) => {
    const out = {};
    Object.entries(r || {}).forEach(([k, v]) => {
      out[k] = safeCell(v);
    });
    return out;
  });

  if (safeRows.length > 0) worksheet.addRows(safeRows);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  if (autoFit) autoFitColumns(worksheet);
  return worksheet;
};

const createWorkbook = ({ creator = "Madan API" } = {}) => {
  const ExcelJS = getExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = creator;
  workbook.created = new Date();
  return workbook;
};

const sendWorkbook = async (res, workbook, { fileName }) => {
  const finalName = normalizeFileName(fileName);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${finalName}"`
  );
  await workbook.xlsx.write(res);
  res.end();
};

const isExportRequest = (req) =>
  String(req?.query?.export || "").trim().toLowerCase() === "true";

module.exports = {
  isExportRequest,
  createWorkbook,
  addSheet,
  sendWorkbook,
};

