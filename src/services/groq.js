const axios = require('axios');

function isConfigured() {
  const key = process.env.GROQ_API_KEY;
  return key && key !== 'your_groq_api_key' && !key.startsWith('placeholder');
}

async function chat(messages, { jsonMode = false } = {}) {
  if (!isConfigured()) {
    return null;
  }
  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
      messages,
      temperature: 0.2,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return res.data.choices[0].message.content;
}

async function parsePrescriptionMessage(text) {
  if (isConfigured()) {
    try {
      const raw = await chat(
        [
          {
            role: 'system',
            content:
              'You extract structured data from a doctor\'s casual WhatsApp message about a home-care patient. ' +
              'Reply with ONLY a JSON object: {"prescription": string, "lab_tests": string[]}. ' +
              'If no lab tests were mentioned, use an empty array. Do not invent medicine or tests not mentioned.',
          },
          { role: 'user', content: text },
        ],
        { jsonMode: true }
      );
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn('Groq call failed, falling back to rule-based parser:', err.message);
    }
  }

  // Heuristic parser
  const tests = [];
  const knownTests = ['cbc', 'thyroid', 'tsh', 'lipid profile', 'blood sugar', 'glucose', 'creatinine', 'crp', 'urine'];
  const lower = text.toLowerCase();
  for (const t of knownTests) {
    if (lower.includes(t)) tests.push(t.toUpperCase());
  }
  return { prescription: text, lab_tests: tests };
}

async function parseVisitTime(text) {
  if (isConfigured()) {
    try {
      const raw = await chat(
        [
          {
            role: 'system',
            content:
              'A lab technician replied with when they can reach a patient\'s home. ' +
              'Reply with ONLY a JSON object: {"visit_time": string, "confirmed": boolean}. ' +
              '"confirmed" is false only if the message does not actually commit to a time. ' +
              'Keep visit_time short and human-readable, e.g. "Today, 5:30 PM" or "Tomorrow morning, ~9 AM".',
          },
          { role: 'user', content: text },
        ],
        { jsonMode: true }
      );
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn('Groq parseVisitTime failed:', err.message);
    }
  }
  return { visit_time: text.trim(), confirmed: true };
}

async function assistantReply(patientMessage, contextSummary) {
  if (isConfigured()) {
    try {
      const res = await chat([
        {
          role: 'system',
          content:
            'You are Nhealth\'s WhatsApp assistant. Answer briefly and warmly about home healthcare ' +
            'booking status, services (doctor visits, nursing, lab tests, pharmacy), and general next steps. ' +
            'Never give medical advice or diagnoses. If unsure, say a coordinator will follow up shortly. ' +
            `Context: ${contextSummary || 'no active request on file'}`,
        },
        { role: 'user', content: patientMessage },
      ]);
      if (res) return res;
    } catch (err) {
      console.warn('Groq assistantReply failed:', err.message);
    }
  }
  return 'Hi! Thank you for reaching out to Nhealth. A coordinator is reviewing your message and will update you shortly.';
}

module.exports = { parsePrescriptionMessage, parseVisitTime, assistantReply };
