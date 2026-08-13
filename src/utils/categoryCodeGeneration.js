const normalizeText = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ");

const getAlphaPrefix = (value) => {
  const letters = String(value || "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();

  return letters.slice(0, 3);
};

const generateCategoryCodeFromName = (categoryName) => normalizeText(categoryName);

const generateSubCategoryCode = (categoryName, subCategoryName) => {
  const categoryPrefix = getAlphaPrefix(categoryName);
  const subCategoryPrefix = getAlphaPrefix(subCategoryName);
  return `${categoryPrefix}-${subCategoryPrefix}`;
};

module.exports = {
  generateCategoryCodeFromName,
  generateSubCategoryCode,
};
