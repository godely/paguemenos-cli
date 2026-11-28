// Report retailer-local wall times as supplied. A checkout quote never reserves the item.
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const dated = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export function fulfillmentTiming(sla, point) {
  const estimate = sla.shippingEstimate;
  const date = sla.shippingEstimateDate;
  const timing = {
    shippingEstimate: typeof estimate === 'string' && /^\d+(?:m|h|d|bd)$/.test(estimate) ? estimate : null,
    shippingEstimateDate: typeof date === 'string' && dated.test(date) && Number.isFinite(Date.parse(date)) ? date : null,
  };
  if (sla.deliveryChannel !== 'pickup-in-point') return timing;
  const hours = [];
  for (const slot of Array.isArray(point?.businessHours) ? point.businessHours : []) {
    const day = slot?.DayOfWeek;
    if (Number.isInteger(day) && day >= 0 && day <= 6 && clock.test(slot.OpeningTime) && clock.test(slot.ClosingTime)) {
      hours.push({dayOfWeek: day, opens:slot.OpeningTime, closes:slot.ClosingTime});
    }
  }
  return {...timing, pickupHours:hours.length ? hours : null};
}
