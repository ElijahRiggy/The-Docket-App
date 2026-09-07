// Vercel serverless function — runs on the server, never in the visitor's browser.
// Keeps GROQ_API_KEY secret and calls Groq's free-tier chat completions API.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  var complaint = typeof body.complaint === 'string' ? body.complaint.trim() : '';
  var category = typeof body.category === 'string' ? body.category : null;
  var stripeSessionId = typeof body.stripeSessionId === 'string' ? body.stripeSessionId.trim().slice(0, 200) : '';

  if (!complaint) {
    res.status(400).json({ error: 'Missing complaint' });
    return;
  }
  // Keep prompts small: cheaper, faster, and safely under free-tier limits.
  complaint = complaint.slice(0, 1500);

  var apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is not configured — GROQ_API_KEY is missing.' });
    return;
  }

  // Never trust a client-supplied "bribed" flag directly — verify the payment
  // actually happened by asking Stripe about the checkout session ID that its
  // own success-page redirect attached to the URL. A visitor can't fake this:
  // Stripe session IDs are long random strings, not something you can guess.
  var bribed = false;
  if (stripeSessionId) {
    var stripeSecret = process.env.STRIPE_SECRET_KEY;
    if (stripeSecret) {
      try {
        var stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(stripeSessionId), {
          headers: { 'Authorization': 'Bearer ' + stripeSecret }
        });
        if (stripeRes.ok) {
          var session = await stripeRes.json();
          if (session && session.payment_status === 'paid') {
            bribed = true;
          }
        }
      } catch (e) {
        // Verification failed for any reason — fail safe, do not grant the bribe.
      }
    }
  }

  var prompt = buildPrompt(complaint, category, bribed);

  try {
    var groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.9,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (groqRes.status === 429) {
      res.status(429).json({ error: 'Rate limited' });
      return;
    }
    if (!groqRes.ok) {
      var errText = await groqRes.text();
      res.status(502).json({ error: 'Upstream error', detail: errText.slice(0, 300) });
      return;
    }

    var data = await groqRes.json();
    var raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) {
      res.status(502).json({ error: 'No content returned' });
      return;
    }

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      res.status(502).json({ error: 'Could not parse ruling' });
      return;
    }

    var juryVoteForYou = Number(parsed.juryVoteForYou) || 50;
    if (bribed) {
      // Paid bias: guarantee a favorable outcome regardless of what the model produced.
      juryVoteForYou = Math.max(juryVoteForYou, 88);
    }

    res.status(200).json({
      caseTitle: String(parsed.caseTitle || '').slice(0, 120),
      charge: String(parsed.charge || '').slice(0, 200),
      ruling: String(parsed.ruling || '').slice(0, 1200),
      sentence: String(parsed.sentence || '').slice(0, 300),
      juryVoteForYou: juryVoteForYou,
      quote: String(parsed.quote || '').slice(0, 200)
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error', detail: String(err).slice(0, 300) });
  }
};

function buildPrompt(complaint, category, bribed) {
  var lines = [
    'You are the presiding judge of "The Docket," a satirical small-claims court for everyday disputes people bring to you.',
    'Tone: fair-minded but funny. Genuinely weigh both sides of the dispute before ruling, then write with dry wit and courtroom flourish. Be sharp and entertaining, never cruel or insulting toward either party.',
    '',
    'Case category: ' + (category || 'Unspecified'),
    'Complaint, in the submitter\'s own words:',
    '"""' + complaint + '"""',
    ''
  ];

  if (bribed) {
    lines.push(
      'SPECIAL INSTRUCTION: the submitter has slipped the judge an envelope of cash under the table. The ruling MUST favor the submitter and find heavily in their favor — write the ruling and sentence as though the submitter is clearly, thoroughly in the right, no matter what the complaint actually says. Keep it funny and make the judge\'s "impartiality" a running joke (wink at the bribe without ever using the words "bribe," "paid," or "money").',
      ''
    );
  }

  lines.push(
    'Reply with ONLY a JSON object (no other text, no markdown fence) with exactly these fields:',
    '{',
    '  "caseTitle": short punchy lawsuit-style case name, max 6 words, e.g. "The Thermostat Incident",',
    '  "charge": a dry, legal-sounding mock charge against whoever is more at fault, max 8 words,',
    '  "ruling": 3-5 sentences in the judge\'s voice, actually weighing both sides fairly, witty but not mean,',
    '  "sentence": one sentence, a lighthearted creative mock punishment or resolution for whoever the ruling finds more at fault,',
    '  "juryVoteForYou": integer 0-100 — the percent of a public jury that would side with the person who SUBMITTED this complaint (not the other party), based on how reasonable their side sounds. This number must match the reasoning in "ruling": if the submitter is clearly in the right, this should be high (70+); if clearly in the wrong, low (30 or under); if it is a genuine toss-up, near 50,',
    '  "quote": one punchy quotable line the judge would say, under 12 words, fit for a headline',
    '}'
  );

  return lines.join('\n');
}
