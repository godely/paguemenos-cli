export function point(latitude, longitude) {
  if ([latitude, longitude].some(v => v == null || String(v).trim() === '')) throw new TypeError('Supply both coordinates');
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new TypeError('Invalid coordinates');
  return { latitude: lat, longitude: lon };
}

export function checkoutOrigin(origin) {
  if (typeof origin === 'string' && /^\d{5}-?\d{3}$/.test(origin) && !/^0+-?0+$/.test(origin)) return { postalCode: origin.replace('-', '') };
  if (origin && typeof origin === 'object') {
    const {latitude, longitude} = point(origin.latitude, origin.longitude);
    return {geoCoordinates:[longitude,latitude]};
  }
  throw new TypeError('Supply a valid CEP or coordinates');
}
