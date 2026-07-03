export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://kenthomas.co',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = await request.json();
    const { email, name, guide } = body;

    // Validate inputs
    if (!email || !guide) {
      return new Response(JSON.stringify({ error: 'Email and guide are required.' }), {
        status: 400,
        headers,
      });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({ error: 'Please enter a valid email address.' }), {
        status: 400,
        headers,
      });
    }

    // Map guide slugs to PDF paths and titles
    const guides = {
      'its-not-a-lead-problem': {
        pdf: '/guides/its-not-a-lead-problem/Its-Not-a-Lead-Problem.pdf',
        title: "It's Not a Lead Problem",
      },
      'not-everyone-who-says-sounds-interesting': {
        pdf: '/guides/not-everyone-who-says-sounds-interesting/Not-Everyone-Who-Says-Sounds-Interesting-Is-Going-to-Buy.pdf',
        title: 'Not Everyone Who Says Sounds Interesting Is Going to Buy',
      },
      'they-didnt-ghost-your-proposal': {
        pdf: '/guides/they-didnt-ghost-your-proposal/They-Didnt-Ghost-Your-Proposal.pdf',
        title: "They Didn't Ghost Your Proposal",
      },
      'your-best-growth-lever': {
        pdf: '/guides/your-best-growth-lever/Your-Best-Growth-Lever-Is-the-Clients-You-Already-Have.pdf',
        title: 'Your Best Growth Lever Is the Clients You Already Have',
      },
      'you-cant-hire-what-you-cant-explain': {
        pdf: '/guides/you-cant-hire-what-you-cant-explain/You-Cant-Hire-What-You-Cant-Explain.pdf',
        title: "You Can't Hire What You Can't Explain",
      },
      'the-business-runs-but-only-when-you-do': {
        pdf: '/guides/the-business-runs-but-only-when-you-do/The-Business-Runs-But-Only-When-You-Do.pdf',
        title: 'The Business Runs But Only When You Do',
      },
    };

    const guideData = guides[guide];
    if (!guideData) {
      return new Response(JSON.stringify({ error: 'Guide not found.' }), {
        status: 400,
        headers,
      });
    }

    const attioApiKey = env.ATTIO_API_KEY;

    // Step 1: Assert the person by email (creates a new record or matches an existing one).
    // We only match on email here so we do not overwrite anything on an existing record.
    const assertResponse = await fetch('https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${attioApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          values: {
            email_addresses: [email],
          },
        },
      }),
    });

    if (!assertResponse.ok) {
      const errorText = await assertResponse.text();
      console.error('Attio API error:', errorText);
      // Still allow the download even if Attio fails
      return new Response(JSON.stringify({
        success: true,
        pdf: guideData.pdf,
        warning: 'Contact could not be saved, but your download is ready.',
      }), {
        status: 200,
        headers,
      });
    }

    const attioData = await assertResponse.json();
    const personId = attioData.data?.id?.record_id;
    const currentValues = attioData.data?.values || {};

    if (personId) {
      // Step 2: Enrich only the fields that are currently empty, so we never
      // clobber an existing prospect's real name or lead source.
      const patchValues = {};

      const hasName = Array.isArray(currentValues.name) && currentValues.name.length > 0;
      if (!hasName && name && name.trim()) {
        const n = name.trim();
        patchValues.name = [{
          full_name: n,
          first_name: n.split(' ')[0],
          last_name: n.split(' ').slice(1).join(' ') || '',
        }];
      }

      const hasSource = Array.isArray(currentValues.lead_source)
        && currentValues.lead_source.length > 0
        && currentValues.lead_source[0]?.value;
      if (!hasSource) {
        patchValues.lead_source = [{ value: 'guide download' }];
      }

      if (Object.keys(patchValues).length > 0) {
        await fetch(`https://api.attio.com/v2/objects/people/records/${personId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${attioApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ data: { values: patchValues } }),
        });
      }

      // Step 3: Add a note recording which guide they downloaded.
      await fetch('https://api.attio.com/v2/notes', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${attioApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: {
            parent_object: 'people',
            parent_record_id: personId,
            title: `Downloaded guide: ${guideData.title}`,
            format: 'plaintext',
            content: `${name ? name.trim() + ' downloaded' : 'Downloaded'} "${guideData.title}" from kenthomas.co on ${new Date().toISOString().split('T')[0]}.`,
          },
        }),
      });
    }

    return new Response(JSON.stringify({
      success: true,
      pdf: guideData.pdf,
    }), {
      status: 200,
      headers,
    });

  } catch (err) {
    console.error('Function error:', err);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
      status: 500,
      headers,
    });
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://kenthomas.co',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
