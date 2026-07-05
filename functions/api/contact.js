export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://kenthomas.co',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const body = await request.json();
    const { name, email, business, message } = body;

    // Validate required fields
    if (!name || !email) {
      return new Response(JSON.stringify({ error: 'Name and email are required.' }), {
        status: 400,
        headers,
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(JSON.stringify({ error: 'Please enter a valid email address.' }), {
        status: 400,
        headers,
      });
    }

    const attioApiKey = env.ATTIO_API_KEY;

    // Step 1: Assert the person record (create or match existing by email)
    const personValues = {
      email_addresses: [email],
      name: [{ full_name: name, first_name: name.split(' ')[0], last_name: name.split(' ').slice(1).join(' ') || '' }],
    };

    const assertResponse = await fetch('https://api.attio.com/v2/objects/people/records?matching_attribute=email_addresses', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${attioApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          values: personValues,
        },
      }),
    });

    if (!assertResponse.ok) {
      const errorText = await assertResponse.text();
      return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
        status: 500,
        headers,
      });
    }

    const attioData = await assertResponse.json();
    const personId = attioData.data?.id?.record_id;

    // Step 2: If business name provided, assert a company and link it
    if (business && business.trim()) {
      try {
        const companyResponse = await fetch('https://api.attio.com/v2/objects/companies/records?matching_attribute=name', {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${attioApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            data: {
              values: {
                name: [{ value: business.trim() }],
              },
            },
          }),
        });

        if (companyResponse.ok) {
          const companyData = await companyResponse.json();
          const companyId = companyData.data?.id?.record_id;

          // Link person to company
          if (personId && companyId) {
            await fetch(`https://api.attio.com/v2/objects/people/records/${personId}`, {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${attioApiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                data: {
                  values: {
                    company: [{ target_object: 'companies', target_record_id: companyId }],
                  },
                },
              }),
            });
          }
        }
      } catch (companyErr) {
        console.error('Company link error:', companyErr);
        // Continue — person was still created
      }
    }

    // Step 3: Add a note with their message
    if (personId) {
      const noteContent = [
        `Contact form submission from kenthomas.co`,
        ``,
        `Name: ${name}`,
        business ? `Business: ${business}` : null,
        message ? `Message: ${message}` : null,
        ``,
        `Submitted: ${new Date().toISOString().split('T')[0]}`,
      ].filter(Boolean).join('\n');

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
            title: 'Contact form enquiry — kenthomas.co',
            format: 'plaintext',
            content: noteContent,
          },
        }),
      });

      // Step 4: Trigger the Attio workflow that creates the reply task.
      // Workflow-created tasks notify the assignee; API-created ones do not.
      try {
        const webhookResponse = await fetch('https://hooks.attio.com/w/5e62a492-63c3-4894-b248-f613fadfd57b/90e8e044-3670-4aa0-9f25-cec1cb4a98ff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'contact-form',
            task: `Reply to contact form enquiry from ${name}${business ? ` (${business.trim()})` : ''} — kenthomas.co`,
            email: email,
          }),
        });
        if (!webhookResponse.ok) {
          console.error('Task webhook failed:', webhookResponse.status, await webhookResponse.text());
        }
      } catch (taskErr) {
        console.error('Task webhook error:', taskErr);
        // Continue — note and person are still created
      }
    }

    return new Response(JSON.stringify({ success: true }), {
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

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': 'https://kenthomas.co',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
