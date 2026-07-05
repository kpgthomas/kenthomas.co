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
    const { name, email, business, phone, total, tier, scores, answers } = body;

    // Validate required fields
    if (!name || !email || !business) {
      return new Response(JSON.stringify({ error: 'Name, email and business are required.' }), {
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

    if (typeof total !== 'number' || total < 0 || total > 100 || !Array.isArray(answers)) {
      return new Response(JSON.stringify({ error: 'Invalid assessment payload.' }), {
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
      return new Response(JSON.stringify({ error: 'Something went wrong. Please try again.' }), {
        status: 500,
        headers,
      });
    }

    const attioData = await assertResponse.json();
    const personId = attioData.data?.id?.record_id;

    // Add phone number if provided (separate call so a bad number can
    // never block the person record or the assessment note)
    if (personId && phone && phone.trim()) {
      try {
        await fetch(`https://api.attio.com/v2/objects/people/records/${personId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${attioApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            data: {
              values: {
                phone_numbers: [{ original_phone_number: phone.trim(), country_code: 'AU' }],
              },
            },
          }),
        });
      } catch (phoneErr) {
        console.error('Phone update error:', phoneErr);
      }
    }

    // Step 2: Assert the company and link it
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

    // Step 3: Add a structured note with the full assessment results.
    // Format is designed to be read by the revenue-independence-assessment
    // report skill, so keep the structure stable if editing.
    if (personId) {
      const lines = [
        'REVENUE INDEPENDENCE ASSESSMENT — kenthomas.co',
        '',
        `Name: ${name}`,
        `Business: ${business}`,
        `Email: ${email}`,
        phone && phone.trim() ? `Phone: ${phone.trim()}` : '',
        `Submitted: ${new Date().toISOString()}`,
        '',
        `Overall Score: ${total}/100`,
        `Tier: ${tier || ''}`,
        '',
        'CATEGORY SCORES',
        `Responsibility: ${scores?.responsibility?.score ?? '?'}/25`,
        `Foundations: ${scores?.foundations?.score ?? '?'}/25`,
        `Methods: ${scores?.methods?.score ?? '?'}/35`,
        `Metrics: ${scores?.metrics?.score ?? '?'}/15`,
        '',
        'ANSWERS',
      ];

      answers.forEach((a) => {
        const pts = a.points === null || a.points === undefined ? 'context' : `${a.points} pts`;
        lines.push(`${a.id}. ${a.question}`);
        lines.push(`   Answer: ${a.answer} (${pts})`);
      });

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
            title: `Revenue Independence Assessment — ${total}/100 (${tier || 'unscored'})`,
            format: 'plaintext',
            content: lines.join('\n'),
          },
        }),
      });

      // Create an Attio task assigned to Ken so the submission triggers
      // a notification (personal review + report, same business day)
      try {
        await fetch('https://api.attio.com/v2/tasks', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${attioApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            data: {
              content: `Review Revenue Independence Assessment: ${name} (${business.trim()}) scored ${total}/100 (${tier || 'unscored'}). Generate and send the report.`,
              format: 'plaintext',
              deadline_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
              is_completed: false,
              linked_records: [{ target_object: 'people', target_record_id: personId }],
              assignees: [{ referenced_actor_type: 'workspace-member', referenced_actor_id: '46cf4d4f-5912-4677-85eb-0ced9c0b5f13' }],
            },
          }),
        });
      } catch (taskErr) {
        console.error('Task creation error:', taskErr);
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
