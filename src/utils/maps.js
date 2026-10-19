function buildGoogleMapsLink(lat, lng, label = "") {
  const base = "https://www.google.com/maps";
  if (label) return `${base}?q=${encodeURIComponent(label)}&ll=${lat},${lng}&z=17`;
  return `${base}?q=${lat},${lng}&z=17`;
}

module.exports = { buildGoogleMapsLink };
