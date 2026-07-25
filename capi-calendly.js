// Calendly invitee.created -> Meta Conversions API (Lead / lead_type: call)
// Env: META_CAPI_TOKEN, META_PIXEL_ID, CALENDLY_SIGNING_KEY, (optional) META_TEST_EVENT_CODE
const crypto = require('crypto');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const norm = (v) => String(v || '').trim().toLowerCase();

// Calendly sends: Calendly-Webhook-Signature: t=<ts>,v1=<hmac>
// HMAC-SHA256 over `${t}.${rawBody}` using the signing key.
function verify(rawBody, header, key) {
  if (!header || !key) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=').map((s) => s.trim()))
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  // Reject anything older than 5 minutes (replay protection)
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = crypto.createHmac('sha256', key).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// https://api.calendly.com/scheduled_events/AAA/invitees/BBB -> BBB
const uuidFromUri = (uri) => String(uri || '').split('/').filter(Boolean).pop() || '';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );

  if (!verify(raw, headers['calendly-webhook-signature'], process.env.CALENDLY_SIGNING_KEY)) {
    console.warn('capi-calendly: signature rejected');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return { statusCode: 400, body: 'Bad JSON' };
  }

  if (body.event !== 'invitee.created') {
    // Acknowledge anything else so Calendly does not retry.
    return { statusCode: 200, body: 'Ignored' };
  }

  const p = body.payload || {};
  const tracking = p.tracking || {};

  // fbp / fbc were smuggled through Calendly's UTM fields by the page.
  const fbp = tracking.utm_content || '';
  const fbc = tracking.utm_term || '';

  const eventId = uuidFromUri(p.uri);
  if (!eventId) {
    console.warn('capi-calendly: no invitee uri, cannot dedupe');
  }

  const user_data = {};
  if (p.email) user_data.em = [sha256(norm(p.email))];
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;
  if (headers['x-nf-client-connection-ip']) {
    user_data.client_ip_address = headers['x-nf-client-connection-ip'];
  }

  // Name is optional but lifts Event Match Quality when present.
  if (p.first_name) user_data.fn = [sha256(norm(p.first_name))];
  if (p.last_name) user_data.ln = [sha256(norm(p.last_name))];

  const payload = {
    data: [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId || `cal-${Date.now()}`,
        action_source: 'website',
        event_source_url: 'https://curatedartagency.com/',
        user_data,
        custom_data: { lead_type: 'call' }
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
      console.error('capi-calendly: Meta rejected', res.status, text);
      // 200 back to Calendly so it does not retry a permanently bad event.
      return { statusCode: 200, body: 'Logged error' };
    }
    console.log('capi-calendly: sent', eventId, text);
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('capi-calendly: send failed', err);
    return { statusCode: 500, body: 'Send failed' };
  }
};
