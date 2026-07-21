// Netlify Forms submission -> Meta Conversions API (Lead / lead_type: form)
// Env: META_CAPI_TOKEN, META_PIXEL_ID, (optional) META_TEST_EVENT_CODE
const crypto = require('crypto');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const norm = (v) => String(v || '').trim().toLowerCase();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  // Netlify wraps submitted fields in `data`
  const d = body.payload && body.payload.data ? body.payload.data : (body.data || body);

  // Only send when the visitor consented, or consent was not required for them.
  // Server-side tracking bypasses browser blocking, so it must respect the choice deliberately.
  const consent = String(d.consent_state || '').toLowerCase();
  if (consent === 'denied') {
    console.log('capi-form: suppressed, consent denied');
    return { statusCode: 200, body: 'Suppressed' };
  }

  const eventId = d.event_id || `form-${Date.now()}`;

  const user_data = {};
  if (d.email) user_data.em = [sha256(norm(d.email))];
  if (d.name) {
    const parts = norm(d.name).split(/\s+/);
    if (parts[0]) user_data.fn = [sha256(parts[0])];
    if (parts.length > 1) user_data.ln = [sha256(parts[parts.length - 1])];
  }
  if (d.fbp) user_data.fbp = d.fbp;
  if (d.fbc) user_data.fbc = d.fbc;
  if (d.client_ua) user_data.client_user_agent = d.client_ua;

  const payload = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: 'https://curatedartagency.com/',
        user_data,
        custom_data: { lead_type: 'form' }
      }
    ]
  };
  if (process.env.META_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  }

  const url =
    `https://graph.facebook.com/v21.0/${process.env.META_PIXEL_ID}/events` +
    `?access_token=${encodeURIComponent(process.env.META_CAPI_TOKEN || '')}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('capi-form: Meta rejected', res.status, text);
      return { statusCode: 200, body: 'Logged error' };
    }
    console.log('capi-form: sent', eventId, text);
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('capi-form: send failed', err);
    return { statusCode: 500, body: 'Send failed' };
  }
};
