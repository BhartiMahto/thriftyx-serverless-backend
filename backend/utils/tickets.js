/**
 * Per-city ticket resolution.
 *
 * Each city (locations[].tickets) has its OWN tickets + inventory. This returns
 * the ticket list that applies to a given booking city, falling back to the
 * event's shared top-level tickets when that city defines none (legacy events,
 * or single-ticket events).
 */
const norm = (s) => String(s || "").trim().toLowerCase();

function ticketsForCity(event, city) {
  const locations = Array.isArray(event?.locations) ? event.locations : [];
  if (city) {
    const loc = locations.find((l) => norm(l.city) === norm(city));
    if (loc && Array.isArray(loc.tickets) && loc.tickets.length) return loc.tickets;
  }
  // No city given, or that city has no own tickets → shared event tickets.
  return Array.isArray(event?.tickets) ? event.tickets : [];
}

/** Find a single ticket by name within a city (or shared). */
function findTicket(event, city, name) {
  return ticketsForCity(event, city).find((t) => norm(t.name) === norm(name)) || null;
}

/** The locations[] entry matching a booking city, or null. */
function locationForCity(event, city) {
  if (!event || !city) return null;
  const locations = Array.isArray(event.locations) ? event.locations : [];
  return locations.find((l) => norm(l.city) === norm(city)) || null;
}

/**
 * The city + venue an order is actually FOR. A multi-city event has one
 * top-level city/venue but each booking carries its own `event_city`; use that
 * (and the matching location's venue) so admin/lists don't show the primary
 * city for every booking. Falls back to the event's top-level fields.
 */
function orderCityVenue(order) {
  const event = order?.event_id || {};
  const city = order?.event_city || event.city || null;
  const loc = locationForCity(event, order?.event_city);
  const venue = loc?.venue || event.venue_name || event.venue || null;
  return { city, venue };
}

/**
 * The effective date + times for a booking city. A city may override the event's
 * top-level date/start_time/end_time (e.g. one city postponed or its time
 * changed); falls back to the top-level whenever the city sets none. Keeps
 * single-city + legacy events working (they only carry the top-level date).
 */
function whenForCity(event, city) {
  const loc = locationForCity(event, city);
  const set = (v) => v !== undefined && v !== null && v !== "";
  return {
    date: set(loc?.date) ? loc.date : (event?.date ?? null),
    start_time: set(loc?.start_time) ? loc.start_time : (event?.start_time || ""),
    end_time: set(loc?.end_time) ? loc.end_time : (event?.end_time || ""),
  };
}

module.exports = { ticketsForCity, findTicket, locationForCity, orderCityVenue, whenForCity };
