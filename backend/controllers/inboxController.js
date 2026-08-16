const { client, isConfigured, whatsappFrom, smsFrom } = require("../utils/twilioClient");
const { toE164 } = require("../utils/phone");
const User = require("../models/userModel");

/**
 * WhatsApp / SMS INBOX — the replies customers send back to our Twilio number.
 *
 * Twilio stores every inbound message as a Message resource, so we can PULL them
 * with the REST API — no webhook / Console change needed. There is no "direction"
 * filter on messages.list, so:
 *   - If we know our own sender number (whatsappFrom / smsFrom), we list by
 *     `to = <our number>` — those are inbound by definition (outbound has
 *     `to = customer`). This is precise and cheap.
 *   - Otherwise we pull recent messages and keep the ones with
 *     direction === "inbound".
 * See utils/twilioClient.js for the optional TWILIO_WHATSAPP_FROM env.
 */

const stripChannel = (addr = "") => ({
  channel: addr.startsWith("whatsapp:") ? "whatsapp" : "sms",
  number: addr.replace(/^whatsapp:/, ""),
});

const last10 = (v = "") => String(v).replace(/\D/g, "").slice(-10);

const listInbound = async (req, res) => {
  try {
    if (!isConfigured || !client) {
      return res.status(200).json({
        message: "Twilio not configured",
        data: [],
        meta: { count: 0, configured: false, mode: "none" },
        statusCode: 200,
      });
    }

    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 400); // up to ~13mo (Twilio's retention)
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
    const search = String(req.query.search || "").trim().toLowerCase();
    const dateSentAfter = new Date(Date.now() - days * 864e5);

    // --- Fetch inbound messages ---
    let raw = [];
    let mode;
    if (whatsappFrom || smsFrom) {
      // Precise: inbound = messages whose `to` is one of our own senders.
      mode = "by-recipient";
      const targets = [];
      if (whatsappFrom) targets.push(`whatsapp:${whatsappFrom.replace(/^whatsapp:/, "")}`);
      if (smsFrom) targets.push(smsFrom);
      const perTarget = await Promise.all(
        targets.map((to) => client.messages.list({ to, dateSentAfter, limit }))
      );
      raw = perTarget.flat();
    } else {
      // Fallback: pull recent messages, keep only inbound.
      mode = "scan";
      const all = await client.messages.list({ dateSentAfter, limit });
      raw = all.filter((m) => m.direction === "inbound");
    }

    // Belt-and-braces: keep only true inbound even in by-recipient mode.
    let items = raw
      .filter((m) => m.direction === "inbound")
      .map((m) => {
        const { channel, number } = stripChannel(m.from || "");
        return {
          sid: m.sid,
          channel,
          from: number,
          e164: toE164(number) || number,
          body: m.body || "",
          numMedia: Number(m.numMedia) || 0,
          status: m.status,
          dateSent: m.dateSent || m.dateCreated || null,
        };
      });

    if (search) {
      items = items.filter(
        (i) => i.body.toLowerCase().includes(search) || i.from.includes(search)
      );
    }

    // Enrich with a known user's name (match by last-10 digits of phone).
    const wanted = new Set();
    for (const i of items) {
      const l = last10(i.e164);
      if (l.length === 10) {
        wanted.add(i.e164);
        wanted.add(l);
        wanted.add(`91${l}`);
        wanted.add(`+91${l}`);
        wanted.add(`0${l}`);
      }
    }
    if (wanted.size) {
      const users = await User.find({ phone: { $in: [...wanted] } })
        .select("name phone gender")
        .lean();
      const byLocal = new Map();
      for (const u of users) {
        const l = last10(u.phone);
        if (l.length === 10 && !byLocal.has(l)) byLocal.set(l, u);
      }
      items = items.map((i) => {
        const u = byLocal.get(last10(i.e164));
        return { ...i, userName: u?.name || null, userGender: u?.gender || null };
      });
    }

    items.sort((a, b) => new Date(b.dateSent || 0) - new Date(a.dateSent || 0));

    res.status(200).json({
      message: "Inbound messages",
      data: items,
      meta: { count: items.length, days, configured: true, mode },
      statusCode: 200,
    });
  } catch (e) {
    console.error("inbox listInbound error:", e.message);
    res.status(502).json({ message: `Could not fetch messages: ${e.message}`, statusCode: 502 });
  }
};

module.exports = { listInbound };
