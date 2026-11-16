const wards = require("../data/agra-city-wards.json");
const { validCoordinates } = require("./distanceDeliveryHelper");

// Returns 0 outside, 1 inside and 2 on an edge. GeoJSON uses longitude first.
function ringContains(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    const length = Math.hypot(dx, dy);
    if (length > 0 && Math.abs((x - ax) * dy - (y - ay) * dx) / length <= 1e-10 &&
        x >= Math.min(ax, bx) - 1e-10 && x <= Math.max(ax, bx) + 1e-10 &&
        y >= Math.min(ay, by) - 1e-10 && y <= Math.max(ay, by) + 1e-10) return 2;
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside ? 1 : 0;
}

function polygonContains(point, rings) {
  const outer = ringContains(point, rings[0]);
  if (!outer) return false;
  if (outer === 2) return true;
  for (const hole of rings.slice(1)) {
    const match = ringContains(point, hole);
    if (match === 2) return true;
    if (match === 1) return false;
  }
  return true;
}

function isInAgraCity(coordinates) {
  return validCoordinates(coordinates) && wards.features.some(({ geometry }) =>
    geometry.type === "Polygon" ? polygonContains(coordinates, geometry.coordinates) :
      geometry.type === "MultiPolygon" && geometry.coordinates.some(rings => polygonContains(coordinates, rings)));
}

function validateAgraAddress(location) {
  if (!validCoordinates(location?.coordinates)) return {
    serviceable: false, errorType: "ADDRESS_LOCATION_MISSING",
    message: "Please provide valid address coordinates [longitude, latitude].",
  };
  if (!isInAgraCity(location.coordinates)) return {
    serviceable: false, errorType: "OUTSIDE_AGRA_CITY",
    message: "Only addresses within Agra city are allowed.",
  };
  return { serviceable: true };
}

module.exports = { isInAgraCity, validateAgraAddress, polygonContains };
