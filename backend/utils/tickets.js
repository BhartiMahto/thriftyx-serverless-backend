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

module.exports = { ticketsForCity, findTicket };
