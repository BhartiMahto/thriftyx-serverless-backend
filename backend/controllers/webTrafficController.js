const { GoogleAuth } = require("google-auth-library");

/**
 * Website traffic for the admin dashboard, pulled from the Google Analytics 4
 * Data API. Env-gated:
 *   GA_PROPERTY_ID   — numeric GA4 property id (NOT the "G-..." measurement id)
 *   GA_SA_CREDENTIALS — the service-account key JSON (as a string), with Viewer
 *                       access granted to the property in GA4.
 * When either is missing the endpoint returns { configured: false } so the admin
 * page can show a "connect analytics" state instead of erroring.
 */
const PROPERTY_ID = process.env.GA_PROPERTY_ID;
const SA_CREDS = process.env.GA_SA_CREDENTIALS;

let _auth = null;
const getAuth = () => {
  if (_auth) return _auth;
  _auth = new GoogleAuth({
    credentials: JSON.parse(SA_CREDS),
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  return _auth;
};

const isoDate = (d) => d.toISOString().slice(0, 10);
const num = (row, i) => Number(row?.metricValues?.[i]?.value || 0);

const getWebTraffic = async (req, res) => {
  try {
    if (!PROPERTY_ID || !SA_CREDS) {
      return res.status(200).json({ message: "Not configured", data: { configured: false }, statusCode: 200 });
    }

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 27 * 864e5);
    const dateRanges = [{ startDate: isoDate(from), endDate: isoDate(to) }];

    const client = await getAuth().getClient();
    const token = (await client.getAccessToken()).token;

    // Four reports in one call: totals, daily trend, top cities, top sources.
    const body = {
      requests: [
        { dateRanges, metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "screenPageViews" }] },
        { dateRanges, dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }], orderBys: [{ dimension: { dimensionName: "date" } }] },
        { dateRanges, dimensions: [{ name: "city" }, { name: "region" }], metrics: [{ name: "activeUsers" }], orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }], limit: 8 },
        { dateRanges, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 6 },
      ],
    };

    const resp = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:batchRunReports`,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );

    if (!resp.ok) {
      const t = await resp.text();
      console.error("GA Data API error:", resp.status, t.slice(0, 400));
      return res.status(502).json({ message: "Could not fetch analytics from Google", statusCode: 502 });
    }

    const reports = (await resp.json()).reports || [];
    const totalsRow = reports[0]?.rows?.[0];

    const data = {
      configured: true,
      range: { from: isoDate(from), to: isoDate(to) },
      summary: {
        users: num(totalsRow, 0),
        sessions: num(totalsRow, 1),
        pageviews: num(totalsRow, 2),
      },
      trend: (reports[1]?.rows || []).map((r) => ({
        // GA returns YYYYMMDD → ISO for the chart.
        date: `${r.dimensionValues[0].value.slice(0, 4)}-${r.dimensionValues[0].value.slice(4, 6)}-${r.dimensionValues[0].value.slice(6, 8)}`,
        users: num(r, 0),
      })),
      cities: (reports[2]?.rows || []).map((r) => ({
        city: r.dimensionValues[0].value,
        region: r.dimensionValues[1].value,
        users: num(r, 0),
      })),
      sources: (reports[3]?.rows || []).map((r) => ({
        source: r.dimensionValues[0].value,
        sessions: num(r, 0),
      })),
    };

    return res.status(200).json({ message: "Web traffic", data, statusCode: 200 });
  } catch (e) {
    console.error("getWebTraffic error:", e.message);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = { getWebTraffic };
