const { validCoordinates } = require("./distanceDeliveryHelper");

const warehouseLocationFields = (body) => {
  const fields = {};
  if (body.warehouseName !== undefined) {
    if (typeof body.warehouseName !== "string" || !body.warehouseName.trim()) {
      throw new Error("warehouseName must be a non-empty string.");
    }
    fields.warehouseName = body.warehouseName.trim();
  }
  let coordinates = body.coordinates;
  if (body.latitude !== undefined || body.longitude !== undefined) {
    const pair = [body.longitude, body.latitude];
    if (!validCoordinates(pair)) throw new Error("Valid numeric latitude and longitude are both required.");
    if (coordinates !== undefined && (!validCoordinates(coordinates) || coordinates.some((n, i) => n !== pair[i]))) {
      throw new Error("coordinates and latitude/longitude must refer to the same location.");
    }
    coordinates = pair;
  }
  if (coordinates !== undefined) {
    if (!validCoordinates(coordinates)) throw new Error("coordinates must be [longitude, latitude] within valid bounds.");
    fields.coordinates = coordinates;
  }
  return fields;
};

module.exports = { warehouseLocationFields };
