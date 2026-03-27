require('dotenv').config();

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleGenAI } = require('@google/genai');

// ── Validate environment ───────────────────────────────────────────────────────
const REQUIRED_ENV = ['GOOGLE_API_KEY', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WEBHOOK_VERIFY_TOKEN'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`ERROR: ${key} is not set in your environment.`);
        process.exit(1);
    }
}

const GOOGLE_API_KEY       = process.env.GOOGLE_API_KEY;
const WHATSAPP_TOKEN       = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID    = process.env.WHATSAPP_PHONE_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PORT                 = process.env.PORT || 3000;

const GRAPH_API = 'https://graph.facebook.com/v22.0';

// ── Google AI client ───────────────────────────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Webhook verification (Meta calls this once to confirm the endpoint)
app.get('/webhook', (req, res) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
        console.log('✅ Webhook verified by Meta');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Incoming messages from WhatsApp
app.post('/webhook', async (req, res) => {
    // Acknowledge immediately — Meta requires a 200 within 5 seconds
    res.sendStatus(200);

    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
            const messages = change.value?.messages;
            if (!messages?.length) continue;

            for (const msg of messages) {
                await handleMessage(msg, change.value.metadata.phone_number_id).catch(console.error);
            }
        }
    }
});

app.get('/', (_req, res) => res.send('WhatsApp Jewelry Bot is running'));

// ── Message handler ────────────────────────────────────────────────────────────
async function handleMessage(msg, phoneNumberId) {
    const from = msg.from; // sender's WhatsApp number

    // Only handle image messages
    if (msg.type !== 'image') {
        if (msg.type === 'text') {
            await sendText(from, '👋 Send me a jewelry photo and I\'ll generate a stunning model shot wearing it.\n\nOptionally add a caption like _"on a white background"_ or _"on a mannequin"_ to customise the scene.');
        }
        return;
    }

    const mediaId          = msg.image.id;
    const customInstruction = (msg.image.caption || '').trim() || null;

    await sendText(from, '⏳ Analyzing your jewelry and generating the image... this takes about 15–20 seconds.');

    try {
        const { base64, mimeType } = await downloadWhatsAppMedia(mediaId);
        const imageBase64 = await generateModelShot(base64, mimeType, customInstruction);

        const uploadedMediaId = await uploadMediaToMeta(imageBase64, phoneNumberId);
        const caption = customInstruction
            ? `✨ "${customInstruction}" — generated with Gemini`
            : '✨ Your jewelry on a model — generated with Gemini';
        await sendImage(from, uploadedMediaId, caption);

    } catch (err) {
        console.error('[Error]', err?.response?.data || err.message);
        const errMsg = err?.message?.includes('safety')
            ? '⚠️ The image was blocked by safety filters. Try a different photo.'
            : '❌ Something went wrong. Please try again.';
        await sendText(from, errMsg);
    }
}

// ── Download media from Meta ───────────────────────────────────────────────────
async function downloadWhatsAppMedia(mediaId) {
    // 1. Get the media URL
    const { data: mediaInfo } = await axios.get(`${GRAPH_API}/${mediaId}`, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    // 2. Download the actual bytes
    const { data: imageBuffer } = await axios.get(mediaInfo.url, {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
        responseType: 'arraybuffer',
    });

    return {
        base64: Buffer.from(imageBuffer).toString('base64'),
        mimeType: mediaInfo.mime_type || 'image/jpeg',
    };
}

// ── Upload generated image to Meta ────────────────────────────────────────────
async function uploadMediaToMeta(base64Image, phoneNumberId) {
    const imageBuffer = Buffer.from(base64Image, 'base64');
    const form        = new FormData();

    form.append('file', imageBuffer, { filename: 'jewelry.jpeg', contentType: 'image/jpeg' });
    form.append('type', 'image/jpeg');
    form.append('messaging_product', 'whatsapp');

    const { data } = await axios.post(
        `${GRAPH_API}/${phoneNumberId}/media`,
        form,
        { headers: { ...form.getHeaders(), Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );

    return data.id;
}

// ── Send helpers ───────────────────────────────────────────────────────────────
async function sendText(to, text) {
    await axios.post(
        `${GRAPH_API}/${WHATSAPP_PHONE_ID}/messages`,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
}

async function sendImage(to, mediaId, caption) {
    await axios.post(
        `${GRAPH_API}/${WHATSAPP_PHONE_ID}/messages`,
        { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption } },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
}

// ── Generate model shot directly from jewelry image ────────────────────────────
async function generateModelShot(base64Image, mimeType, customInstruction) {
    const sceneInstruction = customInstruction
        ? `Place the jewelry in this scene: ${customInstruction}.`
        : 'Show the jewelry being worn by an elegant fashion model. Studio setting, professional fashion photography, soft bokeh background, high-end Vogue magazine quality, cinematic lighting.';

    const prompt = [
        'You are a photorealistic product renderer. Study the jewelry in the reference image with extreme precision and reproduce it exactly — do not alter, simplify, or stylise it in any way.',
        '',
        'REPRODUCE EXACTLY:',
        '- Every gemstone: exact color, cut style, facet pattern, number of stones, arrangement, and size ratios between stones',
        '- Metal: exact color and finish (yellow gold, rose gold, silver, platinum, oxidised, brushed, polished, matte)',
        '- All design details: prong count, setting style, engraving, filigree, milgrain, links, clasps, chain weave pattern',
        '- Proportions: the jewelry must be the exact same shape and scale as in the reference — do not resize, warp or simplify',
        '- Surface reflections and sparkle must match the original material (diamonds sparkle, pearls glow softly, gold reflects warmly)',
        '',
        'STRICT RULES: Do NOT add gemstones that are not in the reference. Do NOT remove or merge design elements. Do NOT change the metal color. Do NOT alter proportions.',
        '',
        sceneInstruction,
        '',
        'The jewelry is the absolute focal point. Frame TIGHT — the jewelry should fill at least 40-50% of the image. Crop in close on the body part wearing it (hand, neck, ear, wrist). Minimal negative space, do NOT pull back to show full body. Ultra-sharp macro detail on the jewelry, 8K resolution, professional studio lighting that reveals every surface facet and texture.',
    ].join('\n');

    const GEMINI_TIMEOUT_MS = 60_000;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3-pro-image-preview',
                contents: [{
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType, data: base64Image } },
                    ],
                }],
                config: {
                    responseModalities: ['TEXT', 'IMAGE'],
                    httpOptions: { timeout: GEMINI_TIMEOUT_MS },
                },
            });
            const parts = response.candidates?.[0]?.content?.parts || [];
            const imagePart = parts.find(p => p.inlineData?.data && !p.thought);
            if (imagePart) return imagePart.inlineData.data;
            console.log(`[Gemini] No image on attempt ${attempt} — retrying...`);
        } catch (err) {
            if (attempt < 2) {
                const isTimeout = err.name === 'AbortError';
                const delay = isTimeout ? 2000 : attempt * 5000;
                console.log(`[Gemini] ${isTimeout ? 'Timeout' : 'Error'} on attempt ${attempt} (${err.message}) — retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
    throw new Error('Gemini returned no image after 2 attempts');
}

// ── Start server ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Jewelry Bot listening on port ${PORT}`);
});
