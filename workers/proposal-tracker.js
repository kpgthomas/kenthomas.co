/**
 * Cloudflare Worker: Proposal Event Tracker
 *
 * Handles proposal tracking events (viewed, signed) and updates Attio Deal records
 * Endpoint: POST /api/proposal-event
 */

const ATTIO_API_BASE = 'https://api.attio.com/v2';

/**
 * Main request handler
 */
export default {
  async fetch(request, env) {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // Only accept POST requests to /api/proposal-event
    if (request.method !== 'POST') {
      return sendJSON({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/proposal-event') {
      return sendJSON({ error: 'Not found' }, 404);
    }

    try {
      // Parse and validate request payload
      const payload = await request.json();
      const validation = validatePayload(payload);

      if (!validation.valid) {
        return sendJSON(
          { error: 'Invalid request', details: validation.errors },
          400
        );
      }

      // Process the event
      const result = await processProposalEvent(
        payload,
        env.ATTIO_API_KEY
      );

      return sendJSON(result, 200);
    } catch (error) {
      console.error('Error processing proposal event:', error);
      return sendJSON(
        { error: 'Internal server error', message: error.message },
        500
      );
    }
  }
};

/**
 * Validate incoming payload
 */
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

  if (payload.type === 'signed' && payload.signature_data) {
    if (typeof payload.signature_data !== 'object') {
      errors.push('signature_data must be an object');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Process proposal event and update Attio deal
 */
async function processProposalEvent(payload, apiKey) {
  const { type, dealId, timestamp, signature_data } = payload;

  // Determine which field to update based on event type
  let updatePayload;

  if (type === 'viewed') {
    // For "viewed" events: Set "Proposal First Viewed" only if not already set
    // First, check if the field already has a value
    const checkResponse = await fetch(
      `${ATTIO_API_BASE}/objects/deals/records/${dealId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }
    );

    if (checkResponse.ok) {
      const record = await checkResponse.json();
      const existingValue = record?.data?.values?.proposal_first_viewed;
      if (existingValue && existingValue.length > 0 && existingValue[0]?.value) {
        return {
          success: true,
          event: type,
          dealId,
          timestamp,
          message: 'Proposal already viewed previously, skipping update'
        };
      }
    }

    updatePayload = {
      data: {
        values: {
          proposal_first_viewed: timestamp
        }
      }
    };
  } else if (type === 'signed') {
    // For "signed" events: Set "Proposal Signed"
    updatePayload = {
      data: {
        values: {
          proposal_signed: timestamp
        }
      }
    };
  }

  // Call Attio API to update the deal record
  const response = await fetch(
    `${ATTIO_API_BASE}/objects/deals/records/${dealId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(updatePayload)
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Attio API error (${response.status}): ${errorText}`
    );
  }

  const attioResponse = await response.json();

  return {
    success: true,
    event: type,
    dealId,
    timestamp,
    message: type === 'viewed'
      ? 'Proposal view recorded successfully'
      : 'Proposal signed successfully'
  };
}

/**
 * Handle CORS preflight requests
 */
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'https://kenthomas.co',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

/**
 * Send JSON response with CORS headers
 */
function sendJSON(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://kenthomas.co',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
