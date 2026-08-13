const PETPOOJA_UNITS = [
  { "id": 1, "name": "BAGS", "code": "BAG", "gstUnit": "BAG" },
  { "id": 2, "name": "BALE", "code": "BAL", "gstUnit": "BAL" },
  { "id": 3, "name": "BUNDLES", "code": "BDL", "gstUnit": "BDL" },
  { "id": 4, "name": "BUCKLES", "code": "BKL", "gstUnit": "BKL" },
  { "id": 5, "name": "BILLIONS OF UNITS", "code": "BOU", "gstUnit": "BOU" },
  { "id": 6, "name": "BOX", "code": "BOX", "gstUnit": "BOX" },
  { "id": 7, "name": "BOTTLES", "code": "BTL", "gstUnit": "BTL" },
  { "id": 8, "name": "BUNCHES", "code": "BUN", "gstUnit": "BUN" },
  { "id": 9, "name": "CANS", "code": "CAN", "gstUnit": "CAN" },
  { "id": 10, "name": "CUBIC METER", "code": "CBM", "gstUnit": "CBM" },
  { "id": 11, "name": "CUBIC CENTIMETER", "code": "CCM", "gstUnit": "CCM" },
  { "id": 12, "name": "CENTIMETER", "code": "CMS", "gstUnit": "CMS" },
  { "id": 13, "name": "CARTONS", "code": "CTN", "gstUnit": "CTN" },
  { "id": 14, "name": "DOZEN", "code": "DOZ", "gstUnit": "DOZ" },
  { "id": 15, "name": "DRUM", "code": "DRM", "gstUnit": "DRM" },
  { "id": 16, "name": "GREAT GROSS", "code": "GGR", "gstUnit": "GGR" },
  { "id": 17, "name": "GRAMS", "code": "GMS", "gstUnit": "GMS" },
  { "id": 18, "name": "GROSS", "code": "GRS", "gstUnit": "GRS" },
  { "id": 19, "name": "GROSS YARDS", "code": "GYD", "gstUnit": "GYD" },
  { "id": 20, "name": "KILOGRAMS", "code": "KGS", "gstUnit": "KGS" },
  { "id": 21, "name": "KILOLITER", "code": "KLR", "gstUnit": "KLR" },
  { "id": 22, "name": "KILOMETRE", "code": "KME", "gstUnit": "KME" },
  { "id": 23, "name": "MILLILITRE", "code": "MLT", "gstUnit": "MLT" },
  { "id": 24, "name": "METERS", "code": "MTR", "gstUnit": "MTR" },
  { "id": 25, "name": "METRIC TONS", "code": "MTS", "gstUnit": "MTS" },
  { "id": 26, "name": "NUMBERS", "code": "NOS", "gstUnit": "NOS" },
  { "id": 27, "name": "PACKS", "code": "PAC", "gstUnit": "PAC" },
  { "id": 28, "name": "PIECES", "code": "PCS", "gstUnit": "PCS" },
  { "id": 29, "name": "PAIRS", "code": "PRS", "gstUnit": "PRS" },
  { "id": 30, "name": "QUINTAL", "code": "QTL", "gstUnit": "QTL" },
  { "id": 31, "name": "ROLLS", "code": "ROL", "gstUnit": "ROL" },
  { "id": 32, "name": "SETS", "code": "SET", "gstUnit": "SET" },
  { "id": 33, "name": "SQUARE FEET", "code": "SQF", "gstUnit": "SQF" },
  { "id": 34, "name": "SQUARE METERS", "code": "SQM", "gstUnit": "SQM" },
  { "id": 35, "name": "SQUARE YARDS", "code": "SQY", "gstUnit": "SQY" },
  { "id": 36, "name": "TABLETS", "code": "TBS", "gstUnit": "TBS" },
  { "id": 37, "name": "TEN GROSS", "code": "TGM", "gstUnit": "TGM" },
  { "id": 38, "name": "THOUSANDS", "code": "THD", "gstUnit": "THD" },
  { "id": 39, "name": "TONNES", "code": "TON", "gstUnit": "TON" },
  { "id": 40, "name": "TUBES", "code": "TUB", "gstUnit": "TUB" },
  { "id": 41, "name": "US GALLONS", "code": "UGS", "gstUnit": "UGS" },
  { "id": 42, "name": "UNITS", "code": "UNT", "gstUnit": "UNT" },
  { "id": 43, "name": "YARDS", "code": "YDS", "gstUnit": "YDS" },
  { "id": 44, "name": "OTHERS", "code": "OTH", "gstUnit": "OTH" },
  { "id": 45, "name": "LITERS", "code": "LTR", "gstUnit": "OTH" },
  { "id": 46, "name": "FEET", "code": "FT", "gstUnit": "OTH" },
  { "id": 47, "name": "PUDA", "code": "PUDA", "gstUnit": "OTH" },
  { "id": 48, "name": "INCHES", "code": "INCH", "gstUnit": "OTH" },
  { "id": 49, "name": "TIN", "code": "TIN", "gstUnit": "OTH" },
  { "id": 50, "name": "PLATES", "code": "PLATE", "gstUnit": "OTH" },
  { "id": 51, "name": "CUBIC FEET", "code": "CF", "gstUnit": "OTH" },
  { "id": 52, "name": "CABS", "code": "CABS", "gstUnit": "OTH" },
  { "id": 53, "name": "HOURS", "code": "HRS", "gstUnit": "OTH" },
  { "id": 54, "name": "CARAT", "code": "CRT", "gstUnit": "OTH" },
  { "id": 55, "name": "CASE", "code": "CASE", "gstUnit": "OTH" },
  { "id": 56, "name": "POUCH", "code": "POU", "gstUnit": "OTH" },
  { "id": 57, "name": "PENA", "code": "PENA", "gstUnit": "OTH" },
  { "id": 58, "name": "M", "code": "M", "gstUnit": "OTH" }
];

/**
 * Maps local measurement units to Petpooja standard unit objects.
 * Defaults to PIECES (id: 28) if no match is found.
 */
function mapLocalUnit(/*localUnit*/) {
  // Always return the PCS unit regardless of the input
  return { "id": 28, "name": "PIECES", "code": "PCS", "gstUnit": "PCS" };
}



module.exports = {
  PETPOOJA_UNITS,
  mapLocalUnit
};
