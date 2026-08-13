function generateSKU(category, subcategory, productName, measurmentValue, measurmentUnit, index) {
    const catCode = category.substring(0, 3).toUpperCase();
    const subCatCode = subcategory.substring(0, 3).toUpperCase();
    const prodCode = productName.substring(0, 3).toUpperCase();
    const measureCode = `${measurmentValue}${measurmentUnit}`.replace(/\s+/g, '').toUpperCase();
    const suffix = String(index + 1).padStart(3, '0');
    return `${catCode}-${subCatCode}-${prodCode}-${measureCode}-${suffix}`;
}

module.exports = generateSKU;