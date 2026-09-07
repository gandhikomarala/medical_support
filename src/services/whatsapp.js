const axios = require('axios');

const GUPSHUP_SEND_URL = 'https://api.gupshup.io/wa/api/v1/msg';

function isConfigured() {
  const key = process.env.GUPSHUP_API_KEY;
  return key && key !== 'your_gupshup_api_key' && !key.startsWith('placeholder');
}

function client() {
  return axios.create({
    baseURL: 'https://api.gupshup.io',
    headers: {
      apikey: process.env.GUPSHUP_API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
}

async function sendText(toPhone, text) {
  if (!isConfigured()) {
    console.log(`[WHATSAPP SANDBOX OUT] -> ${toPhone}:\n${text}\n`);
    return { status: 'submitted', mock: true, destination: toPhone, text };
  }

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: process.env.GUPSHUP_SOURCE_NUMBER || '919959461095',
    destination: toPhone,
    'src.name': process.env.GUPSHUP_APP_NAME || 'AyansMedicare',
    message: JSON.stringify({ type: 'text', text }),
  });
  const res = await client().post(GUPSHUP_SEND_URL, body);
  return res.data;
}

async function sendMedia(toPhone, mediaUrl, caption) {
  if (!isConfigured()) {
    console.log(`[WHATSAPP SANDBOX MEDIA OUT] -> ${toPhone}: [${mediaUrl}] ${caption || ''}\n`);
    return { status: 'submitted', mock: true, destination: toPhone, mediaUrl, caption };
  }

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: process.env.GUPSHUP_SOURCE_NUMBER || '919959461095',
    destination: toPhone,
    'src.name': process.env.GUPSHUP_APP_NAME || 'AyansMedicare',
    message: JSON.stringify({ type: 'image', originalUrl: mediaUrl, previewUrl: mediaUrl, caption }),
  });
  const res = await client().post(GUPSHUP_SEND_URL, body);
  return res.data;
}

async function broadcast(phones, text) {
  for (const phone of phones) {
    try {
      await sendText(phone, text);
    } catch (err) {
      console.error(`Failed to send WhatsApp message to ${phone}:`, err.message);
    }
  }
}

module.exports = { sendText, sendMedia, broadcast };
