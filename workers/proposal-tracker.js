/**
 * Cloudflare Worker: Proposal Event Tracker
 *
 * Handles proposal tracking events (viewed, signed) and updates Attio Deal records.
 * Stores signature data in Cloudflare KV for permanent audit trail.
 *
 * Endpoints:
 *   POST /api/proposal-event     — track view/sign events
 *   GET  /api/proposal-event?dealId=xxx  — check if proposal is already signed
 *
 * KV Binding: PROPOSAL_SIGNATURES (stores signature + audit data per deal)
 */

const ATTIO_API_BASE = 'https://api.attio.com/v2';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }
    const url = new URL(request.url);
    if (url.pathname !== '/api/proposal-event') {
      return sendJSON({ error: 'Not found' }, 404);
    }
    if (request.method === 'GET') {
      return handleGetSignature(url, env);
    }
    if (request.method === 'POST') {
      return handlePostEvent(request, env);
    }
    return sendJSON({ error: 'Method not allowed' }, 405);
  }
};

async function handleGetSignature(url, env) {
  const dealId = url.searchParams.get('dealId');
  if (!dealId) {
    return sendJSON({ error: 'dealId query parameter required' }, 400);
  }
  try {
    const stored = await env.PROPOSAL_SIGNATURES.get(dealId, 'json');
    if (stored) {
      return sendJSON({ signed: true, data: stored });
    } else {
      return sendJSON({ signed: false });
    }
  } catch (error) {
    console.error('Error checking signature:', error);
    return sendJSON({ error: 'Failed to check signature status' }, 500);
  }
}

async function handlePostEvent(request, env) {
  try {
    const payload = await request.json();
    const validation = validatePayload(payload);
    if (!validation.valid) {
      return sendJSON({ error: 'Invalid request', details: validation.errors }, 400);
    }
    if (payload.type === 'signed') {
      const existing = await env.PROPOSAL_SIGNATURES.get(payload.dealId, 'json');
      if (existing) {
        return sendJSON({ success: false, error: 'Proposal has already been signed', signed_at: existing.signedAt }, 409);
      }
    }
    const clientIP = request.headers.get('CF-Connecting-IP') || 'Unknown';
    const country = request.headers.get('CF-IPCountry') || 'Unknown';
    const result = await processProposalEvent(payload, env.ATTIO_API_KEY, env.PROPOSAL_SIGNATURES, clientIP, country);
    return sendJSON(result, 200);
  } catch (error) {
    console.error('Error processing proposal event:', error);
    return sendJSON({ error: 'Internal server error', message: error.message }, 500);
  }
}

function validatePayload(payload) {
  const errors = [];
  if (!payload.type || !['viewed', 'signed'].includes(payload.type)) {
    errors.push('type must be "viewed" or "signed"');
  }
  if (!payload.dealId || typeof payload.dealId !== 'string') {
    errors.push('dealId must be a non-empty string');
  }
  if (!payload.timestamp || isNaN(Date.parse(payload.timestamp))) {
    errors.push('timestamp must be a valid ISO 8601 date string');
  }
  if (payload.type === 'signed') {
    if (!payload.signature_data || typeof payload.signature_data !== 'object') {
      errors.push('signature_data is required for signed events');
    }
  }
  return { valid: errors.length === 0, errors };
}

async function processProposalEvent(payload, apiKey, kvStore, clientIP, country) {
  const { type, dealId, timestamp, signature_data } = payload;
  let updatePayload;

  if (type === 'viewed') {
    const checkResponse = await fetch(`${ATTIO_API_BASE}/objects/deals/records/${dealId}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
    });
    if (checkResponse.ok) {
      const record = await checkResponse.json();
      const existingValue = record?.data?.values?.proposal_first_viewed;
      if (existingValue && existingValue.length > 0 && existingValue[0]?.value) {
        return { success: true, event: type, dealId, timestamp, message: 'Proposal already viewed previously, skipping update' };
      }
    }
    updatePayload = { data: { values: { proposal_first_viewed: timestamp } } };
  } else if (type === 'signed') {
    const auditRecord = {
      signedBy: signature_data.signedBy,
      role: signature_data.role,
      email: signature_data.email,
      signatureMethod: signature_data.signatureMethod,
      signatureImage: signature_data.signatureImage,
      signedAt: timestamp,
      clientIP: clientIP,
      country: country,
      userAgent: signature_data.userAgent || 'Unknown',
      dealId: dealId
    };
    await kvStore.put(dealId, JSON.stringify(auditRecord));
    updatePayload = { data: { values: { proposal_signed: timestamp } } };
  }

  const response = await fetch(`${ATTIO_API_BASE}/objects/deals/records/${dealId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(updatePayload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Attio API error (${response.status}): ${errorText}`);
  }
  await response.json();
  return {
    success: true, event: type, dealId, timestamp,
    message: type === 'viewed' ? 'Proposal view recorded successfully' : 'Proposal signed and audit trail stored'
  };
}

function handleCORS() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': 'https://kenthomas.co',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  }});
}

function sendJSON(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://kenthomas.co',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }});
}
