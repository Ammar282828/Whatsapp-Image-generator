// ── Detect runtime: standalone (Railway) only if RAILWAY=true is explicitly set ──
const IS_STANDALONE = process.env.RAILWAY === 'true';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');

const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');
const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');

if (IS_STANDALONE && process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
} else {
    if (!admin.apps.length) admin.initializeApp();
}
const db = admin.firestore();

// ── Timing constants ──────────────────────────────────────────────────────────
const SESSION_EXPIRY_MS = 2  * 60 * 60 * 1000; // auto-clear idle sessions after 2h
const QUEUE_WARN_MS     = 30 * 60 * 1000;       // warn user if queue >30 min old
const QUEUE_REJECT_MS   = 60 * 60 * 1000;       // reject if queue >60 min (WhatsApp URLs expire)
const DEDUP_TTL_MS      = 5  * 60 * 1000;       // suppress duplicate webhook deliveries for 5 min

// ── Logo watermark cache (loaded once per function instance) ──────────────────
const LOGO_URL = 'https://houseofmina.store/cdn/shop/files/MINA_logo.png';
const WATERMARK_WIDTH  = 120; // px — wide enough to be visible
const WATERMARK_MARGIN = 12;  // px — gap from corner
let _logoMaroon = null;
let _logoWhite  = null;

async function getLogos() {
    if (_logoMaroon && _logoWhite) return { maroon: _logoMaroon, white: _logoWhite };
    const { data } = await axios.get(LOGO_URL, { responseType: 'arraybuffer', timeout: 10000 });
    const raw = Buffer.from(data);
    // Maroon version — original colors, resized
    _logoMaroon = await sharp(raw).resize(WATERMARK_WIDTH, null, { fit: 'inside' }).png().toBuffer();
    // White version — same shape but all pixels become white
    const { data: pixels, info } = await sharp(raw)
        .resize(WATERMARK_WIDTH, null, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < pixels.length; i += info.channels) {
        pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255;
    }
    _logoWhite = await sharp(pixels, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
    return { maroon: _logoMaroon, white: _logoWhite };
}

async function addWatermark(base64Image) {
    const imgBuf = Buffer.from(base64Image, 'base64');
    const { maroon, white } = await getLogos();
    // Sample bottom-right quadrant brightness using extract + stats (avoids decoding full image to raw)
    const meta = await sharp(imgBuf).metadata();
    const regionLeft = Math.floor(meta.width * 0.72);
    const regionTop  = Math.floor(meta.height * 0.72);
    const { channels } = await sharp(imgBuf)
        .extract({ left: regionLeft, top: regionTop, width: meta.width - regionLeft, height: meta.height - regionTop })
        .stats();
    // Luminance-weighted mean: 0.299*R + 0.587*G + 0.114*B
    const brightness = 0.299 * channels[0].mean + 0.587 * channels[1].mean + 0.114 * channels[2].mean;
    const logo = brightness < 128 ? white : maroon;
    // Extend logo with transparent padding so it sits WATERMARK_MARGIN px from the corner
    const paddedLogo = await sharp(logo)
        .extend({ bottom: WATERMARK_MARGIN, right: WATERMARK_MARGIN, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
    const result = await sharp(imgBuf)
        .composite([{ input: paddedLogo, gravity: 'southeast', blend: 'over' }])
        .jpeg({ quality: 90 }).toBuffer();
    return result.toString('base64');
}

// ── Global function config ────────────────────────────────────────────────────
setGlobalOptions({
        maxInstances: 10,
        minInstances: 1,
        timeoutSeconds: 540,
        memory: '1GiB',
        region: 'us-central1',
    });

const GRAPH_API = 'https://graph.facebook.com/v22.0';

// ── Build the Express app ─────────────────────────────────────────────────────
function createApp(secrets) {
    const ai = new GoogleGenAI({ apiKey: secrets.googleApiKey });
    const app = express();
    app.use(express.json());

    // Health check
    app.get('/', (_req, res) => res.send('WhatsApp Jewelry Bot is running'));

    // Webhook verification — Meta calls this once to confirm the endpoint
    app.get('/webhook', (req, res) => {
        const mode      = req.query['hub.mode'];
        const token     = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === secrets.webhookVerifyToken) {
            console.log('Webhook verified by Meta');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    });

    // Incoming messages from WhatsApp
    app.post('/webhook', async (req, res) => {
        res.sendStatus(200); // Acknowledge immediately — Meta requires 200 within 5s

        const body = req.body;
        if (body.object !== 'whatsapp_business_account') return;

        for (const entry of body.entry || []) {
            for (const change of entry.changes || []) {
                const messages = change.value?.messages;
                if (!messages?.length) continue;
                for (const msg of messages) {
                    const reqId = Math.random().toString(36).slice(2, 8).toUpperCase();
                    if (msg.id && await isDuplicate(msg.id)) {
                        console.log(`[${reqId}] Skipping duplicate msg ${msg.id}`);
                        continue;
                    }
                    // Parallelise housekeeping — don't wait for markAsRead before handling
                    const phoneNumberId = change.value.metadata.phone_number_id;
                    if (msg.id) markProcessed(msg.id); // fire-and-forget
                    markAsRead(msg.id, phoneNumberId, secrets.whatsappToken); // fire-and-forget
                    await handleMessage(msg, phoneNumberId, secrets, ai, reqId)
                        .catch(err => console.error(`[${reqId}] Unhandled:`, err.message));
                }
            }
        }
    });

    return app;
}

const HELP_MESSAGE = `👋 *House of Mina Bot*

📸 *Batch mode (recommended):*
1. Send one or more jewelry photos
2. Each photo is queued — caption sets the scene
3. Type *done* to generate from all angles at once

⚡ *Quick mode (single image instantly):*
Add _now_ to caption: e.g. _flat now_ or just _now_

🎬 *Scene captions:*
• _(no caption)_ → elegant model shot
• _model_ → fashion model, Vogue quality
• _flat_ → flat lay on white marble
• _white_ → clean white e-commerce
• _mannequin_ → on a mannequin
• _bg: [description]_ → fully custom scene

✍️ *Text commands:*
• _done_ → generate from queued images
• _status_ → check what's in your queue
• _scene [type]_ → change scene without clearing queue
• _cancel_ → clear the queue
• _retry_ → re-run the last failed generation
• _desc: [product details]_ → House of Mina WhatsApp copy
• _help_ → show this menu

💡 *Tips:*
• Send front + back + detail shots for best accuracy
• Scene locks on the first image's caption
• Add plating info: _model, gold plated_`;

const SCENES = {
    model:      'The jewelry is worn by a beautiful, elegant woman — mid-20s, professionally styled. Single large softbox from camera-left, off-white seamless background. CRITICAL: determine the jewelry type from the reference and frame the shot accordingly — DO NOT shoot full-body or mid-body:\n- Ring → extreme close-up of her hand, fingers slightly curled, shot from slightly above. Her hand rests on a neutral surface or hangs naturally. Nails clean and natural. Skin on knuckles has real texture.\n- Earrings → tight portrait shot of her face from the side or three-quarter angle, framed from chin to just above the ear. Hair tucked behind the ear or pulled back to show the earring clearly. The earring is the focal point.\n- Necklace / pendant → close-up of her neck and upper chest, framed from collarbone to just below the chin. Décolletage visible, skin has real texture and natural warmth. Off-shoulder or low neckline.\n- Bracelet / bangle → close-up of her wrist and forearm, slightly angled, soft natural light catching the metal.\n- Brooch / hair accessory → tight crop on the exact placement area.\nIn every case: the jewelry fills a large portion of the frame. Real optical bokeh on the background. Expression and body are relaxed, not stiff or posed.',
    flat:       'The jewelry is laid on a real slab of white Carrara marble with natural grey and gold veining visible close-up. Shot from directly overhead, camera parallel to the surface. Single light source: diffused window light from the upper-left, casting a real soft shadow to the lower-right — not centered, not shadowless. The marble surface has slight natural variation in texture. The jewelry is NOT perfectly centered — placed at the upper-right third of the frame. A few props if natural: a folded linen cloth edge visible at the bottom, or a single dried flower petal nearby. Nothing staged or symmetrical.',
    white:      'The jewelry sits on a white surface under a single overhead softbox. Clean, minimal e-commerce shot but with soul — slight drop shadow directly beneath the piece, natural and soft. The background fades to pure white at the edges but is not perfectly even close to the jewelry. The jewelry is placed slightly off-center. Shot at a low 15-degree angle from the front so you see both the top and slight depth of the piece. No reflections, no gradients, no artificial glow.',
    mannequin:  'The jewelry is displayed on a matte white ceramic mannequin neck/hand form placed on a warm light-grey linen surface. Single studio strobe from the upper-right creates clear directional light with visible shadow on the left side of the mannequin. The mannequin form is slightly angled — not straight-on. The linen surface has visible weave texture. Background: warm grey gradient, darker at the edges. Shot at a natural portrait angle, slightly compressed perspective.',
};

const ANGLES = [
    {
        id: 'front',
        label: 'Front View',
        instruction: 'Straight-on front view. Product faces directly at camera, centered. Full product visible.',
    },
    {
        id: 'elevated',
        label: '3/4 Elevated',
        instruction: '3/4 elevated angle.',
    },
    {
        id: 'band',
        label: 'Band Focus',
        instruction: 'Band/shank focus shot.',
    },
    {
        id: 'detail',
        label: 'Detail Close-up',
        instruction: 'Extreme macro close-up.',
    },
];

function resolveScene(caption) {
    if (!caption) return { scene: SCENES.model, label: 'model shot' };
    const lower = caption.toLowerCase();

    // Custom scene via "bg: ..."
    const bgMatch = lower.match(/\bbg:\s*(.+)/);
    if (bgMatch) return { scene: `Place the jewelry in this scene: ${bgMatch[1].trim()}.`, label: bgMatch[1].trim() };

    if (lower.includes('flat'))       return { scene: SCENES.flat,      label: 'flat lay' };
    if (lower.includes('white'))      return { scene: SCENES.white,     label: 'white background' };
    if (lower.includes('mannequin'))  return { scene: SCENES.mannequin, label: 'mannequin' };
    if (lower.includes('model'))      return { scene: SCENES.model,     label: 'model shot' };

    // Treat the whole caption as a custom scene
    return { scene: `Place the jewelry in this scene: ${caption}.`, label: caption };
}

// ── Firestore session helpers ─────────────────────────────────────────────────
// Only media IDs are stored (not base64) — well under Firestore's 1MB limit.
// Images are downloaded in bulk only when user types "done".
async function getSession(from) {
    const ref = db.collection('sessions').doc(from);
    const doc = await ref.get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (data.expiresAt && Date.now() > data.expiresAt) {
        await ref.delete();
        return null; // session expired (2h idle)
    }
    return data;
}

async function addMediaIdToSession(from, mediaId, caption) {
    const ref = db.collection('sessions').doc(from);
    let count, sceneLabel, showMenu, flowState;
    await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        const data = doc.exists ? doc.data() : {};
        const mediaIds = data.mediaIds || [];
        mediaIds.push(mediaId);
        const scene = data.scene || resolveScene(caption).scene;
        const now = Date.now();
        count = mediaIds.length;
        sceneLabel = getSceneLabel(scene);
        showMenu = !data.menuSent;
        flowState = data.flowState || null;
        t.set(ref, {
            mediaIds,
            scene,
            menuSent: true,
            flowState: data.flowState || null,
            jewelryType: data.jewelryType || null,
            outputType: data.outputType || null,
            updatedAt: now,
            queuedAt:  data.queuedAt || now,
            expiresAt: now + SESSION_EXPIRY_MS,
        });
    });
    return { count, sceneLabel, showMenu, flowState };
}

// ── Flow state helpers (multi-step menu tracking) ────────────────────────────
async function setFlowState(from, flowState, scene, jewelryType, outputType) {
    const ref = db.collection('sessions').doc(from);
    const now = Date.now();
    await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        const data = doc.exists ? doc.data() : {};
        const update = {
            flowState,
            updatedAt: now,
            expiresAt: now + SESSION_EXPIRY_MS,
        };
        if (scene !== undefined) update.scene = scene;
        if (jewelryType !== undefined) update.jewelryType = jewelryType;
        if (outputType !== undefined) update.outputType = outputType;
        if (!doc.exists) {
            update.mediaIds = [];
            update.menuSent = false;
            update.queuedAt = now;
        }
        t.set(ref, { ...data, ...update });
    });
}

async function clearFlowState(from) {
    const ref = db.collection('sessions').doc(from);
    await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        if (doc.exists) {
            t.update(ref, { flowState: null, jewelryType: null, outputType: null });
        }
    });
}

async function clearSession(from) {
    await db.collection('sessions').doc(from).delete();
}

// ── Retry job helpers ─────────────────────────────────────────────────────────
async function saveRetryJob(from, mediaIds, scene, label) {
    await db.collection('retry_jobs').doc(from).set({ mediaIds, scene, label, savedAt: Date.now() });
}
async function getRetryJob(from) {
    const doc = await db.collection('retry_jobs').doc(from).get();
    return doc.exists ? doc.data() : null;
}
async function clearRetryJob(from) {
    await db.collection('retry_jobs').doc(from).delete();
}

// ── Pending-done flag helpers ──────────────────────────────────────────────────
// Stored when user types "done" before images have landed in Firestore.
// The image handler picks this up and auto-triggers processing.
async function setPendingDone(from) {
    await db.collection('pending_done').doc(from).set({ at: Date.now() });
}
async function claimPendingDone(from) {
    // Atomically delete — returns true if this caller claimed it (it existed)
    const ref = db.collection('pending_done').doc(from);
    let claimed = false;
    await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        if (doc.exists && (Date.now() - doc.data().at) < 5 * 60 * 1000) {
            t.delete(ref);
            claimed = true;
        }
    });
    return claimed;
}
async function clearPendingDone(from) {
    await db.collection('pending_done').doc(from).delete();
}

// ── Running-state helpers (per user) ─────────────────────────────────────────
async function setGenerating(from, reqId) {
    await db.collection('generation_state').doc(from).set({ running: true, reqId, at: Date.now() });
}
async function clearGenerating(from) {
    await db.collection('generation_state').doc(from).delete();
}
async function isGenerating(from) {
    const doc = await db.collection('generation_state').doc(from).get();
    return !!(doc.exists && doc.data()?.running);
}

// If user types done while a run is active, we remember to auto-start the next queue.
async function setPendingNext(from) {
    await db.collection('pending_next').doc(from).set({ at: Date.now() });
}
async function claimPendingNext(from) {
    const ref = db.collection('pending_next').doc(from);
    let claimed = false;
    await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        if (doc.exists && (Date.now() - doc.data().at) < 60 * 60 * 1000) {
            t.delete(ref);
            claimed = true;
        }
    });
    return claimed;
}
async function hasPendingNext(from) {
    const ref = db.collection('pending_next').doc(from);
    const doc = await ref.get();
    if (!doc.exists) return false;
    if ((Date.now() - doc.data().at) > 60 * 60 * 1000) {
        await ref.delete().catch(() => {});
        return false;
    }
    return true;
}

// ── Live status tracking ──────────────────────────────────────────────────────
async function setStatus(from, step, detail) {
    await db.collection('status_log').doc(from).set({ step, detail, at: Date.now() });
}
async function clearStatus(from) {
    await db.collection('status_log').doc(from).delete();
}

function getSceneLabel(scene) {
    if (!scene || scene === SCENES.model)     return 'model shot';
    if (scene === SCENES.flat)                return 'flat lay';
    if (scene === SCENES.white)               return 'white background';
    if (scene === SCENES.mannequin)           return 'mannequin';
    return scene.replace(/^Place the jewelry in this scene:\s*/i, '').replace(/\.$/, '');
}

// ── Deduplication helpers ─────────────────────────────────────────────────────
async function isDuplicate(msgId) {
    if (!msgId) return false;
    const doc = await db.collection('processed_msgs').doc(msgId).get();
    if (!doc.exists) return false;
    return (Date.now() - doc.data().processedAt) < DEDUP_TTL_MS;
}

async function markProcessed(msgId) {
    if (!msgId) return;
    await db.collection('processed_msgs').doc(msgId).set({ processedAt: Date.now() });
}

// ── Mark message as read (shows blue ticks to user) ──────────────────────────
async function markAsRead(msgId, phoneNumberId, token) {
    if (!msgId || !token) return;
    await axios.post(
        `${GRAPH_API}/${phoneNumberId}/messages`,
        { messaging_product: 'whatsapp', status: 'read', message_id: msgId },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    ).catch(() => {}); // non-critical
}

// ── Image quality pre-check ───────────────────────────────────────────────────
async function checkImageQuality(base64) {
    try {
        const buf = Buffer.from(base64, 'base64');
        const { width, height } = await sharp(buf).metadata();
        if (width < 300 || height < 300) {
            return { ok: false, reason: `Too small (${width}×${height}px) — send a higher-res photo` };
        }
        const { data, info } = await sharp(buf)
            .resize(80, 80, { fit: 'inside' })
            .raw()
            .toBuffer({ resolveWithObject: true });
        let sum = 0;
        const pixels = info.width * info.height;
        for (let i = 0; i < data.length; i += info.channels) {
            sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        if (sum / pixels < 25) {
            return { ok: false, reason: 'Too dark — send a well-lit photo' };
        }
        return { ok: true };
    } catch {
        return { ok: true }; // don't block on check errors
    }
}

// ── Shoulder/basket crops for geometry analysis ─────────────────────────────
async function generateShoulderCrops(imageInputs) {
    const originals = imageInputs.filter(img => img.mimeType === 'image/jpeg');
    const crops = [];
    for (const img of originals) {
        try {
            const buf = Buffer.from(img.base64, 'base64');
            const { width, height } = await sharp(buf).metadata();

            // Crop 1 — shoulder zone: bottom 60% of image (band + junction area)
            const shoulderBuf = await sharp(buf)
                .extract({
                    left: Math.floor(width * 0.1),
                    top:  Math.floor(height * 0.4),
                    width:  Math.floor(width * 0.8),
                    height: Math.floor(height * 0.6),
                })
                .jpeg({ quality: 95 })
                .toBuffer();
            crops.push({ base64: shoulderBuf.toString('base64'), mimeType: 'image/jpeg' });

            // Crop 2 — basket zone: top 55% of image (setting + basket walls)
            const basketBuf = await sharp(buf)
                .extract({
                    left: Math.floor(width * 0.15),
                    top:  Math.floor(height * 0.05),
                    width:  Math.floor(width * 0.7),
                    height: Math.floor(height * 0.55),
                })
                .jpeg({ quality: 95 })
                .toBuffer();
            crops.push({ base64: basketBuf.toString('base64'), mimeType: 'image/jpeg' });
        } catch (err) {
            console.warn('[Crop] Failed for one image, skipping:', err.message);
        }
    }
    return crops;
}

// ── Geometry note via Gemini text ───────────────────────────────────────────
async function generateGeometryNote(originals, crops, ai) {
    const allRefs = [...originals, ...crops];
    const parts = [
        ...allRefs.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
        { text: `You are a jewelry technical analyst. Study these reference photos (full ring views and zoomed close-ups) and write 2\u20134 plain English sentences describing:

1. SHOULDER: Where the shank meets the basket \u2014 does it taper smoothly? Step abruptly? Flare outward? Curve inward? Visible ledge, undercut, or decorative sweep? Symmetrical?
2. BASKET: Wall shape \u2014 straight vertical, tapered cone, tulip, cathedral arch? Cut-outs, windows, or solid walls? Height relative to stone?
3. GALLERY (if visible): Any scrollwork, milgrain, open or closed gallery visible through the side?

Write 2\u20134 plain sentences. Be specific about shapes, angles, and structures. Example: "The shank rises into two curved cathedral arches that sweep upward into the basket base on both sides. The basket is a four-prong setting with thin pointed claw prongs and open walls between the prongs." Respond with ONLY the description sentences, nothing else.` },
    ];
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [{ parts }],
        });
        return response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim() || null;
    } catch (err) {
        console.warn('[GeometryNote] Failed, skipping:', err.message);
        return null;
    }
}

// ── Ecommerce shot generation ───────────────────────────────────────────────
async function generateEcommerceShot(imageInputs, customInstruction, angle, ai) {
    const isDetail   = angle.id === 'detail';
    const isElevated = angle.id === 'elevated';
    const isBand     = angle.id === 'band';

    const promptInputs = imageInputs;
    let hasFrontRef = angle.id !== 'front'
        && promptInputs.length > 1
        && promptInputs[promptInputs.length - 1]?.mimeType === 'image/png';
    const numOriginalRefs = hasFrontRef ? promptInputs.length - 1 : promptInputs.length;
    const contextNote = hasFrontRef
        ? `You have ${promptInputs.length} images. The first ${numOriginalRefs} are original reference photo(s) of the jewelry \u2014 these may be DIFFERENT ANGLES of the same piece (front, side, top, close-up, etc.). Study EVERY reference image carefully: each angle reveals details that other angles may hide (e.g., a side view shows band profile, a top view shows stone arrangement, a close-up shows prong details). Build a COMPLETE mental model of the piece by combining information from ALL angles before generating. The LAST image is the APPROVED RENDERED FRONT VIEW of this exact piece \u2014 match its design exactly.`
        : numOriginalRefs > 1
            ? `You have ${numOriginalRefs} reference photos of the jewelry piece. These are DIFFERENT ANGLES of the SAME piece \u2014 front, side, top, close-up, etc. BEFORE generating anything, study EVERY single reference image and combine the information: each angle reveals details hidden in the others. A side view shows the band profile and gallery. A top view shows stone arrangement. A close-up shows prong count and texture. Build a COMPLETE mental model of the piece from ALL angles, then generate.`
            : 'You have been given one reference photo of the jewelry piece. Study every detail carefully.';

    const sceneBlock = isDetail ? [
        'SCENE \u2014 MACRO CLOSE-UP:',
        '- THIS IS AN EXTREME MAGNIFICATION SHOT. Do NOT show the full product.',
        '- Camera positioned 1\u20132 cm from the surface, filling the entire frame with a single small region.',
        '- Default subject: the primary center stone and its immediate setting. If there is no center stone, focus on the most intricate area (detailed setting, engraving, or surface texture).',
        '- The chosen fragment should fill at least 80% of the frame \u2014 crop aggressively.',
        '- Razor-sharp focus on the closest surface; gentle natural bokeh softens the background.',
        '- Jewelry rests on clean white surface; slight micro-shadow beneath the piece.',
        '- No full-product silhouette visible \u2014 this is not a product overview shot.',
        '- Square 1:1 frame.',
    ] : isElevated ? [
        'SCENE \u2014 3/4 ELEVATED:',
        '- IMPORTANT: This is the SAME ring from the front view, now shown from a 3/4 angle. Do NOT create a different ring.',
        '- Ring stands UPRIGHT on its shank on a clean white surface \u2014 NOT lying flat.',
        '- Camera is at roughly the same height as the ring (near table level), angled about 30\u201340 degrees to the side.',
        '- This is the classic jewelry-store display angle: you see the stone face AND the side profile of the setting simultaneously.',
        '- ORIGINAL REFERENCES OVERRIDE: For the basket walls, gallery, and shoulder junction, trust the original reference photo(s) over any rendered front view. Those side-geometry details must come from the real photos, not from generic ring priors.',
        '- The side of the setting, prongs, basket walls, gallery, and upper band are clearly visible \u2014 this shot reveals the 3D architecture that a front view hides.',
        '- BASKET FIDELITY: Reproduce the exact basket/setting side profile from the reference \u2014 its height, wall angle, any side decorations or cut-outs. Do NOT simplify or round off the basket.',
        '- SHOULDER FIDELITY: Reproduce the exact shoulder-to-basket junction from the reference \u2014 the same curve, step, taper break, undercut, or decorative sweep. Do NOT replace it with a generic cathedral shoulder or smooth taper.',
        '- DO NOT shoot from above. The camera must be near the ring\'s eye-level, NOT looking down at it.',
        '- Every design detail from the front view (stone count, band pattern, basket shape, setting type, metal color) MUST be visible and identical.',
        '- Soft, natural drop shadow directly beneath the piece.',
        '- Background fades to pure white at the edges.',
        '- No reflections, no gradients, no artificial glow.',
        '- Square 1:1 frame. White fill any empty areas.',
    ] : isBand ? [
        'SCENE \u2014 BAND & BASKET SIDE PROFILE:',
        hasFrontRef
            ? `- REFERENCE USAGE: You have ${numOriginalRefs} ORIGINAL reference photo(s) plus one approved rendered front view (the last image). Use the ORIGINAL reference photo(s) as the primary authority for the shoulder shape, band profile, basket structure, and gallery geometry. Use the rendered front view as an additional consistency reference for the approved front-facing design, stone layout, metal color, and finish.`
            : `- REFERENCE USAGE: Use the ${numOriginalRefs} ORIGINAL reference photo(s) as the authority for the shoulder shape, band profile, basket structure, and gallery geometry in this shot.`,
        '- The ring stands UPRIGHT on its shank, positioned so the camera sees the SIDE PROFILE of the band AND basket.',
        '- Specifically: rotate the ring so the camera is looking at the LEFT (or OUTER-LEFT) edge of the band shank.',
        '- Camera is at TABLE-SURFACE LEVEL (0\u20135 degrees elevation), looking HORIZONTALLY at the SIDE of the ring.',
        '- BASKET FIDELITY: The basket/setting side wall is clearly visible in this shot. Reproduce its EXACT profile from the reference: its height, the angle of its walls, any decorative cut-outs, claws, or architectural details on the side. Do NOT simplify or invent the basket shape.',
        '- BAND FIDELITY: Reproduce the exact band profile: width, thickness, taper, shank shape (flat, rounded, knife-edge, etc.), and any surface details (milgrain, channel stones, engravings) visible on the side face.',
        '- SHOULDER JUNCTION (CRITICAL): The exact point where the shank meets the base of the basket is UNIQUE to this ring. In the reference image(s), locate both shoulders and study their shape precisely. Reproduce them identically \u2014 the curve, the angle, any step or undercut, any decorative sweep. Do NOT invent, smooth, or generalize.',
        '- NEGATIVE CONSTRAINT: Do NOT default to a generic cathedral shoulder, donut gallery, peg-head, tulip basket, cone basket, or smooth solitaire taper unless the reference explicitly shows that exact structure.',
        '- The band and lower basket fill the frame. The stone appears at the TOP partially visible but is NOT the focus.',
        '- CRITICAL: Do NOT show the INTERIOR or UNDERSIDE of the basket \u2014 only the EXTERIOR SIDE WALL is visible from this angle.',
        '- STRICT: Do NOT invent decorative elements not present in the reference image.',
        '- Clean white surface with soft micro-shadow beneath the piece.',
        '- No reflections, no gradients.',
        '- Square 1:1 frame. White fill any empty areas.',
    ] : [
        'SCENE \u2014 TOP-DOWN 45\u00b0:',
        '- The ring lies FLAT on a clean white surface with the FRONT of the ring facing the camera \u2014 the stone/setting is the focal point, fully visible from above.',
        '- Camera is positioned above and slightly in front, at roughly 45 degrees from overhead, angled to look down at the FRONT FACE of the ring.',
        '- The stone face, prongs, and setting must be clearly visible and dominate the frame \u2014 this is a top-down view of the FRONT of the ring, not the back.',
        '- DO NOT show the back or underside of the ring. The camera must see the same front face as the standard front view, just from a higher angle.',
        '- The band should be visible curving away from the camera, providing context but not dominating.',
        '- Clean, minimal e-commerce shot \u2014 soft, natural drop shadow directly beneath the piece.',
        '- No reflections, no gradients, no artificial glow.',
        '- Square 1:1 frame. White fill any empty areas.',
    ];

    const lightingBlock = isDetail ? [
        'LIGHTING \u2014 MACRO:',
        '- Single narrow spotlight or ring flash aimed directly at the featured area',
        '- Every facet, prong, and micro-texture must be crisply lit',
        '- Diamonds: intense prismatic fire and sharp sparkle points. Gold: warm micro-reflections. Silver: cool crisp glint.',
        '- No fill lights \u2014 hard light that reveals micro-detail',
    ] : [
        'LIGHTING:',
        '- Single overhead softbox \u2014 bright but natural, not clinical',
        '- Clean specular highlights on metal and gemstones showing their exact material properties',
        '- Diamonds: sharp prismatic sparkle. Gold: warm reflection. Silver: cool crisp gleam.',
        '- No fill lights, no rim lights \u2014 one source only',
    ];

    // ── Nano Banana v3 band shot ─────────────────────────────────────────────
    let bandParts = null;
    if (isBand) {
        const originals  = promptInputs.filter(img => img.mimeType === 'image/jpeg');
        const frontRef   = hasFrontRef ? [promptInputs[promptInputs.length - 1]] : [];
        const crops      = await generateShoulderCrops(originals);
        const geometryNote = await generateGeometryNote(originals, crops, ai);
        const orderedImages = [...originals, ...crops, ...frontRef];

        const bandPrompt = [
            'Use the uploaded image(s) as the EXACT reference of the jewelry piece.',
            contextNote,
            '',
            `You have ${originals.length} original reference photo(s) and${hasFrontRef ? ' one approved rendered front view (the last image). The originals are your primary authority for every physical detail. The rendered front view is a secondary check for stone layout, metal color, and finish.' : ' no rendered front view. The originals are your primary authority for every physical detail.'}`,
            '',
            'TASK: Extract this jewelry piece from its background and generate a professional luxury product photograph for a high-end e-commerce listing.',
            '',
            ...(geometryNote ? [
                'GEOMETRY ANCHOR \u2014 read this first, then cross-check against reference images:',
                geometryNote,
                '',
            ] : []),
            'SUBJECT FIDELITY:',
            'Reproduce every physical detail from the reference with zero deviation. Count prongs exactly \u2014 cross-check against the basket structure to confirm count and arrangement. Reproduce the basket (height, wall thickness, side profile, cut-outs, milgrain, architectural details), the shoulder junction (the exact curve, angle, step, undercut, or sweep where the shank meets the basket base), and the band profile (width, thickness, taper, shank shape, surface details). Preserve exact metal color, texture, gemstone shape, cut, color, and setting type. If any detail is ambiguous, preserve the visible silhouette from the reference \u2014 hidden areas stay hidden.',
            '',
            'SCENE \u2014 SIDE PROFILE VIEW:',
            'Ring stands upright on its shank. Camera at table-surface level (0\u20135\u00b0 elevation), looking horizontally at the left (outer-left) edge of the band. Band and lower basket fill the frame. Stone at top, partially visible, secondary focus. Only the exterior side wall of the basket is visible. Clean white (#FFFFFF) surface, soft micro-shadow beneath. Square 1:1, piece at ~65% of frame, centered, white fill.',
            '',
            'LIGHTING:',
            'Single overhead softbox. Bright, natural. Clean specular highlights \u2014 sharp prismatic sparkle on diamonds, warm reflection on gold, cool crisp gleam on silver. Subtle shadow beneath. DSLR macro lens quality: sharp focus across entire piece.',
            '',
            'CONSTRAINTS:',
            'Reproduce only what exists in the reference. Add nothing, remove nothing. The shoulder junction, basket walls, and gallery architecture are locked geometry from the reference, not open to interpretation.',
            ...(customInstruction ? ['', customInstruction] : []),
        ].join('\n');

        bandParts = [
            { text: bandPrompt },
            ...orderedImages.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
        ];
    }

    const prompt = isBand ? null : [
        'Use the uploaded image(s) as the EXACT reference of the jewelry piece.',
        contextNote,
        '',
        'Extract the jewelry from whatever background or hand is in the reference and generate a professional luxury product photoshoot of the EXACT SAME piece.',
        'The jewelry must remain 100% identical to the original image(s) \u2014 do NOT change the design, shape, gemstones, metal color, texture, proportions, prong count, prong style, setting type, shank profile, or ANY details whatsoever.',
        'Do NOT add features not in the reference: no extra stones, no split shanks unless the reference has one, no decorative elements, no design "improvements."',
        'Do NOT remove, simplify, or merge any element from the reference.',
        '',
        'ZERO-TOLERANCE GEOMETRY CHECK FOR RINGS:',
        '- Basket/setting shape and the shoulder junction are LOCKED physical geometry, not stylistic interpretation.',
        '- Use the ORIGINAL reference photo(s) as the authority for basket height, basket wall angle, gallery architecture, and the exact point where the shank meets the basket.',
        '- Do NOT replace those areas with a generic ring archetype such as a cathedral shoulder, smooth taper, donut gallery, cone basket, peg-head, or tulip setting.',
        '- If the chosen camera angle would naturally hide part of the basket or shoulder, keep that area hidden or only as visible as the real reference supports. Do NOT reveal invented side geometry.',
        '- If any basket or shoulder detail is ambiguous, stay conservative and preserve the visible silhouette from the reference instead of guessing.',
        '',
        'PRONG COUNT: Count the EXACT number of prongs in the reference image. Then cross-check by studying the basket and gallery structure \u2014 the prongs connect to the basket, so the basket shape confirms the prong count and arrangement. Reproduce that EXACT number. Do NOT default to 4 prongs \u2014 if the reference has 6, 8, 12, or any other count, match it precisely. The prong count is a fixed physical property of the ring.',
        'BASKET/SETTING: Reproduce the basket exactly \u2014 its height, wall thickness, side profile shape, any decorative cut-outs, milgrain, or architectural details. The basket is as much a design element as the stone. Do NOT simplify it into a plain cone or cylinder.',
        'SHOULDER (where band meets basket): HIGHEST PRIORITY. The shoulder is the exact point where the shank widens or transitions into the base of the setting. Look at the reference and find this junction on BOTH sides of the ring. It may have a specific curve, step, undercut, cut-out, swept wing, or decorative shape. You MUST reproduce it exactly \u2014 do NOT smooth it, simplify it, or replace it with a generic taper. If you cannot see both shoulders clearly in a single reference image, look at ALL reference images provided and piece together the full picture. Inventing or guessing the shoulder shape is not acceptable.',
        '',
        ...sceneBlock,
        '',
        'Place the jewelry alone on a clean, minimal pure white (#FFFFFF) background.',
        '',
        ...lightingBlock,
        '- Subtle, realistic shadows and reflections for a high-end jewelry product shoot look.',
        '- The image should appear as if photographed using a professional DSLR with a macro lens: extremely sharp focus across the entire piece, high resolution, luxury commercial photography quality.',
        '',
        'WHITESPACE: The piece should occupy roughly 65% of the frame, centered, with equal breathing room on all sides.',
        '',
        'Do NOT modify the jewelry in ANY way. Only improve the presentation, lighting, and background.',
        'The reference image is the ONLY source of truth. If a detail is not visible in the reference, do NOT invent it.',
        '',
        'Square 1:1 output.',
        ...(customInstruction ? ['', `CUSTOM SCENE OVERRIDE: ${customInstruction}`] : []),
    ].join('\n');

    const parts = bandParts ?? [
        { text: prompt },
        ...promptInputs.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
    ];

    const raw = await callGemini(parts, ai);
    return makeSquareBase64(raw);
}

// ── Shared Gemini caller with retry + concurrency limiting ──────────────────
const ECOM_MAX_RETRIES = 3;
const ECOM_RETRY_DELAYS = [2000, 5000, 10000];

const MAX_CONCURRENT = 3;
let activeGeminiCalls = 0;
const geminiQueue = [];

function acquireGeminiSlot() {
    return new Promise(resolve => {
        if (activeGeminiCalls < MAX_CONCURRENT) {
            activeGeminiCalls++;
            resolve();
        } else {
            geminiQueue.push(resolve);
        }
    });
}

function releaseGeminiSlot() {
    activeGeminiCalls--;
    if (geminiQueue.length > 0) {
        activeGeminiCalls++;
        geminiQueue.shift()();
    }
}

async function callGemini(parts, ai, attempt = 0) {
    await acquireGeminiSlot();
    try {
        console.log(`[Gemini] calling... (${parts.filter(p => p.inlineData).length} image(s))${attempt > 0 ? ` [retry ${attempt}]` : ''}`);
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            contents: [{ parts }],
            config: { responseModalities: ['TEXT', 'IMAGE'] },
        });

        const resParts  = response.candidates?.[0]?.content?.parts || [];
        const imagePart = resParts.find(p => p.inlineData?.data && !p.thought);
        if (!imagePart) {
            const text = resParts.find(p => p.text)?.text || 'none';
            console.error('[Gemini] No image. Response text:', text.slice(0, 300));
            throw new Error('Gemini returned no image \u2014 ' + text.slice(0, 120));
        }

        // Validate the returned image
        try {
            const buf = Buffer.from(imagePart.inlineData.data, 'base64');
            const meta = await sharp(buf).metadata();
            if (!meta.width || !meta.height) throw new Error('Invalid image dimensions');
        } catch (valErr) {
            throw new Error('Gemini returned invalid image data');
        }

        console.log('[Gemini] image OK');
        return imagePart.inlineData.data;
    } catch (err) {
        if (attempt < ECOM_MAX_RETRIES - 1) {
            const delay = ECOM_RETRY_DELAYS[attempt] || 5000;
            console.log(`[Gemini] retry ${attempt + 1}/${ECOM_MAX_RETRIES} in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
            return callGemini(parts, ai, attempt + 1);
        }
        throw err;
    } finally {
        releaseGeminiSlot();
    }
}

// ── Image helpers (square padding) ──────────────────────────────────────────
async function makeSquareBase64(base64) {
    const buf = Buffer.from(base64, 'base64');
    const out = await makeSquare(buf);
    return out.toString('base64');
}

async function makeSquare(buffer) {
    const meta = await sharp(buffer).metadata();
    const size = Math.max(meta.width, meta.height);
    return sharp(buffer)
        .resize({ width: size, height: size, fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();
}

// ── Core image generation pipeline ───────────────────────────────────────────
async function processImages(mediaIds, scene, label, from, phoneNumberId, secrets, ai, reqId, outputType) {
    // Default to 'model' if no outputType specified
    const mode = outputType || 'model';
    const doEcommerce = mode === 'ecommerce' || mode === 'both';
    const doModel     = mode === 'model'     || mode === 'both';
    const totalSteps  = mode === 'both' ? 8 : (mode === 'ecommerce' ? 7 : 4);

    const log = async (text) => {
        console.log(`[${reqId}] ${text}`);
        await sendText(from, secrets, `[${reqId}] ${text}`).catch(() => {});
    };

    // Helper: upload + send a single generated image, fire-and-forget safe
    const sendGeneratedImage = async (base64, caption) => {
        const uploaded = await uploadMediaToMeta(base64, phoneNumberId, secrets);
        await sendImage(from, uploaded, caption, secrets);
    };

    try {
        await setGenerating(from, reqId);
        await saveRetryJob(from, mediaIds, scene, label);
        const startTime = Date.now();
        let step = 1;

        await setStatus(from, step, `Downloading ${mediaIds.length} image${mediaIds.length > 1 ? 's' : ''} from WhatsApp`);
        await log(`\u23f3 Step ${step}/${totalSteps} \u2014 Downloading ${mediaIds.length} image${mediaIds.length > 1 ? 's' : ''} from WhatsApp...`);
        const images = await Promise.all(mediaIds.map(id => downloadWhatsAppMedia(id, secrets)));

        // Quality check \u2014 warn but don't block
        const warnings = [];
        for (let i = 0; i < images.length; i++) {
            const qc = await checkImageQuality(images[i].base64);
            if (!qc.ok) warnings.push(`Image ${i + 1}: ${qc.reason}`);
        }
        if (warnings.length) {
            await sendText(from, secrets, `\u26a0\ufe0f Quality note${warnings.length > 1 ? 's' : ''}:\n${warnings.join('\n')}\nAttempting anyway...`);
        }
        await log(`\u2705 Step ${step}/${totalSteps} \u2014 Downloaded`);
        step++;

        // Silently enhance any custom scene description before generation (model shots)
        let finalScene = scene;
        if (doModel && scene.startsWith('Place the jewelry in this scene:')) {
            const rawCaption = scene.replace(/^Place the jewelry in this scene:\s*/i, '').replace(/\.$/, '');
            console.log(`[${reqId}] Enhancing custom scene: "${rawCaption}"`);
            await setStatus(from, step, `Enhancing scene description for "${rawCaption}"`);
            finalScene = await enhanceScene(rawCaption, ai);
            console.log(`[${reqId}] Enhanced scene: "${finalScene}"`);
        }

        // ── Ecommerce shots ──
        if (doEcommerce) {
            // Step: generate front view first
            await setStatus(from, step, 'Generating Front View (1 of 4 e-commerce angles)');
            await log(`\u23f3 Step ${step}/${totalSteps} \u2014 Generating *Front View*...`);
            const frontBase64 = await generateEcommerceShot(images, null, ANGLES[0], ai);
            const frontWatermarked = await addWatermark(frontBase64);
            sendGeneratedImage(frontWatermarked, `\u2728 Front View \u2014 e-commerce`).catch(e => console.error(`[${reqId}] Send front failed:`, e.message));
            await log(`\u2705 Step ${step}/${totalSteps} \u2014 Front View done`);
            step++;

            // Step: generate elevated + band + detail in parallel (with front as reference)
            const frontRef = { base64: frontBase64, mimeType: 'image/png' };
            const refsForAngles = [...images, frontRef];

            await setStatus(from, step, 'Generating 3 more e-commerce angles in parallel');
            await log(`\u23f3 Step ${step}/${totalSteps} \u2014 Generating *Elevated + Band + Detail* in parallel...`);

            const parallelEcom = [
                generateEcommerceShot(refsForAngles, null, ANGLES[1], ai)
                    .then(async (b64) => {
                        const wm = await addWatermark(b64);
                        sendGeneratedImage(wm, `\u2728 ${ANGLES[1].label} \u2014 e-commerce`).catch(e => console.error(`[${reqId}] Send elevated failed:`, e.message));
                    })
                    .catch(err => { console.error(`[${reqId}] Elevated failed:`, err.message); return null; }),
                generateEcommerceShot(refsForAngles, null, ANGLES[2], ai)
                    .then(async (b64) => {
                        const wm = await addWatermark(b64);
                        sendGeneratedImage(wm, `\u2728 ${ANGLES[2].label} \u2014 e-commerce`).catch(e => console.error(`[${reqId}] Send band failed:`, e.message));
                    })
                    .catch(err => { console.error(`[${reqId}] Band failed:`, err.message); return null; }),
                generateEcommerceShot(refsForAngles, null, ANGLES[3], ai)
                    .then(async (b64) => {
                        const wm = await addWatermark(b64);
                        sendGeneratedImage(wm, `\u2728 ${ANGLES[3].label} \u2014 e-commerce`).catch(e => console.error(`[${reqId}] Send detail failed:`, e.message));
                    })
                    .catch(err => { console.error(`[${reqId}] Detail failed:`, err.message); return null; }),
            ];

            // If mode is 'both', also fire model shot in parallel with the 3 ecommerce angles
            if (doModel) {
                parallelEcom.push(
                    generateModelShot(images, finalScene, ai)
                        .then(async (modelB64) => {
                            sendGeneratedImage(modelB64, `\u2728 ${label} \u2014 model shot`).catch(e => console.error(`[${reqId}] Send model failed:`, e.message));
                        })
                        .catch(err => { console.error(`[${reqId}] Model failed:`, err.message); return null; })
                );
            }

            await Promise.all(parallelEcom);
            await log(`\u2705 Step ${step}/${totalSteps} \u2014 All parallel shots done (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);
            step++;
        } else {
            // ── Model shot only (original behavior) ──
            await setStatus(from, step, `Generating ${label} from ${images.length} angle${images.length > 1 ? 's' : ''} \u2014 this takes 1\u20135 mins`);
            await log(`\u23f3 Step ${step}/${totalSteps} \u2014 Generating *${label}* from ${images.length} angle${images.length > 1 ? 's' : ''}...`);
            const imageBase64 = await generateModelShot(images, finalScene, ai);
            await log(`\u2705 Step ${step}/${totalSteps} \u2014 Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            step++;

            await setStatus(from, step, 'Uploading generated image to WhatsApp');
            await log(`\u23f3 Step ${step}/${totalSteps} \u2014 Uploading to WhatsApp...`);
            const uploadedMediaId = await uploadMediaToMeta(imageBase64, phoneNumberId, secrets);
            await log(`\u2705 Step ${step}/${totalSteps} \u2014 Uploaded`);
            step++;

            await setStatus(from, step, 'Sending image to you');
            await log(`\u23f3 Step ${step}/${totalSteps} \u2014 Sending your image...`);
            await sendImage(from, uploadedMediaId, `\u2728 ${label} \u2014 generated with Gemini`, secrets);
            step++;
        }

        // Auto-write product copy for every generated output, based on the same reference photos.
        try {
            const autoDescription = await generateDescription('', ai, images);
            await sendText(from, secrets, autoDescription);
            console.log(`[${reqId}] Auto description sent.`);
        } catch (descErr) {
            console.error(`[${reqId}] Auto description failed:`, descErr.message);
            await sendText(from, secrets, '\u26a0\ufe0f Image sent, but auto-description failed. Type *desc* to generate it manually.').catch(() => {});
        }

        await log(`\ud83c\udf89 Done! Total: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        await sendButtons(
            from, secrets,
            'What would you like to do next?',
            [
                { id: 'btn_new',   title: '\ud83d\udcf8 New Photo' },
                { id: 'btn_retry', title: '\ud83d\udd04 Regenerate' },
                { id: 'btn_help',  title: '\ud83d\udccb Menu' },
            ],
        ).catch(() => {});
        await clearRetryJob(from);
        await clearStatus(from);
    } catch (err) {
        const detail = err?.response?.data ?? err.message;
        console.error(`[${reqId}] \u274c FAILED \u2014 ${JSON.stringify(detail)}`);
        const errMsg = err?.message?.includes('safety')
            ? '\u26a0\ufe0f Blocked by safety filters. Try a different photo.'
            : `\u274c Error: ${JSON.stringify(detail)}`;
        await sendText(from, secrets, `[${reqId}] ${errMsg}`).catch(() => {});
        await sendButtons(
            from, secrets,
            'Generation failed. What would you like to do?',
            [
                { id: 'btn_retry', title: '\ud83d\udd04 Retry' },
                { id: 'btn_new',   title: '\ud83d\udcf8 New Photo' },
                { id: 'btn_help',  title: '\ud83d\udccb Menu' },
            ],
        ).catch(() => {});
        await clearStatus(from);
    } finally {
        await clearGenerating(from).catch(() => {});

        // Auto-start the next queued batch if user requested "done" during this run.
        const shouldStartNext = await claimPendingNext(from).catch(() => false);
        if (shouldStartNext) {
            const session = await getSession(from).catch(() => null);
            if (session?.mediaIds?.length) {
                const { mediaIds, scene: nextScene } = session;
                const nextLabel = getSceneLabel(nextScene);
                await clearSession(from).catch(() => {});
                const nextReqId = Math.random().toString(36).slice(2, 8).toUpperCase();
                console.log(`[${reqId}] Starting queued next batch \u2014 ${mediaIds.length} image(s)`);
                await processImages(mediaIds, nextScene, nextLabel, from, phoneNumberId, secrets, ai, nextReqId);
            }
        }
    }
}

// ── Message handler ────────────────────────────────────────────────────────────
async function handleMessage(msg, phoneNumberId, secrets, ai, reqId) {
    const from = msg.from;
    console.log(`[${reqId}] From: ${from} | Type: ${msg.type}`);

    // ── Interactive replies (button taps & list selections) ──
    if (msg.type === 'interactive') {
        const interactiveType = msg.interactive?.type;
        const replyId = interactiveType === 'button_reply'
            ? msg.interactive.button_reply?.id
            : msg.interactive.list_reply?.id;
        console.log(`[${reqId}] Interactive: ${interactiveType} → ${replyId}`);

        // ── Main menu flow selections ──
        // "Put Jewellery on Model" → show jewelry type sub-menu
        if (replyId === 'flow_model') {
            await setFlowState(from, 'picking_jewelry', SCENES.model, undefined, 'model');
            await sendJewelryTypeMenu(from, secrets);
            return;
        }

        // "E-commerce Shots" → ask for image directly
        if (replyId === 'flow_ecommerce') {
            await setFlowState(from, 'awaiting_image', SCENES.model, undefined, 'ecommerce');
            await sendText(from, secrets, 'Please upload an image to continue \ud83d\udd17\ud83d\udcf8\n\n_Mode: 4 e-commerce product angles_');
            return;
        }

        // "Model + E-commerce" → ask for image directly
        if (replyId === 'flow_both') {
            await setFlowState(from, 'awaiting_image', SCENES.model, undefined, 'both');
            await sendText(from, secrets, 'Please upload an image to continue \ud83d\udd17\ud83d\udcf8\n\n_Mode: Model shot + 4 e-commerce angles (5 images total)_');
            return;
        }

        // "Give your own prompt" → ask for prompt text
        if (replyId === 'flow_custom') {
            await setFlowState(from, 'awaiting_prompt', undefined, undefined);
            await sendText(from, secrets, 'Type your scene description below.\n\nExample: _on a velvet cushion with rose petals and warm candlelight_');
            return;
        }

        // "Product Description" → explain and wait
        if (replyId === 'flow_desc') {
            await sendText(from, secrets, '✍️ Send your jewelry photos, then type *desc* to generate WhatsApp product copy.\n\nOr type _desc: gold ring with emerald_ for text-only.');
            return;
        }

        // "Bulk Generation" → explain batch mode
        if (replyId === 'flow_bulk') {
            await sendText(from, secrets, '📸 *Bulk generation:*\n1. Send multiple jewelry photos\n2. Each photo is queued with the same scene\n3. Type *done* to generate all at once\n\n_Send your first photo to get started!_');
            return;
        }

        // "Check Status" → fall through to text handler
        if (replyId === 'flow_status') {
            msg.type = 'text';
            msg.text = { body: '?' };
        }

        // ── Jewelry type sub-menu selections ──
        if (replyId?.startsWith('jewel_')) {
            const typeMap = {
                jewel_set:      'jewellery set',
                jewel_necklace: 'necklace',
                jewel_earrings: 'earrings',
                jewel_ring:     'ring',
                jewel_bracelet: 'bracelet',
                jewel_tikka:    'maang tikka',
                jewel_brooch:   'brooch',
            };
            const jewelryType = typeMap[replyId] || 'jewelry';
            await setFlowState(from, 'awaiting_image', undefined, jewelryType);
            await sendText(from, secrets, `Please upload an image to continue 🔗📸\n\n_Jewellery: ${jewelryType}_`);
            return;
        }

        // "Go Back" → main menu
        if (replyId === 'menu_goback') {
            await clearFlowState(from);
            await sendMainMenu(from, secrets);
            return;
        }

        // ── Action buttons (on queued images) ──
        if (replyId === 'btn_done') {
            if (await isGenerating(from)) {
                const session = await getSession(from);
                if (!session || !session.mediaIds?.length) {
                    await sendText(from, secrets, '⏳ A generation is already running. Send your next photos and I\'ll run them right after.');
                    return;
                }
                await setPendingNext(from);
                const label = getSceneLabel(session.scene);
                await sendText(from, secrets, `🧾 Next batch queued: ${session.mediaIds.length} image${session.mediaIds.length > 1 ? 's' : ''} — *${label}*.\nI'll start it automatically when the current one finishes.`);
                return;
            }
            const session = await getSession(from);
            if (!session || !session.mediaIds?.length) {
                await setPendingDone(from);
                return;
            }
            const age = Date.now() - (session.queuedAt || session.updatedAt || 0);
            if (age > QUEUE_REJECT_MS) {
                await clearSession(from);
                await sendText(from, secrets, '⏰ Queued images expired (>60 min). Please resend the photos.');
                return;
            }
            if (age > QUEUE_WARN_MS) {
                await sendText(from, secrets, '⚠️ Images are >30 min old — they may have expired. Attempting anyway...');
            }
            const { mediaIds, scene } = session;
            const label = getSceneLabel(scene);
            await clearSession(from);
            await processImages(mediaIds, scene, label, from, phoneNumberId, secrets, ai, reqId);
            return;
        }

        if (replyId === 'btn_cancel') {
            await Promise.all([clearSession(from), clearPendingDone(from)]);
            await sendText(from, secrets, '🗑️ Queue cleared.');
            await sendMainMenu(from, secrets);
            return;
        }

        if (replyId === 'btn_retry') {
            if (await isGenerating(from)) {
                await sendText(from, secrets, '⏳ A generation is already running. Please wait, then try again.');
                return;
            }
            const job = await getRetryJob(from);
            if (!job) {
                await sendText(from, secrets, '🤷 No failed job to retry.');
                await sendMainMenu(from, secrets);
                return;
            }
            await processImages(job.mediaIds, job.scene, job.label, from, phoneNumberId, secrets, ai, reqId);
            return;
        }

        if (replyId === 'btn_scene_menu') {
            const session = await getSession(from);
            if (!session || !session.mediaIds?.length) {
                await sendText(from, secrets, '📭 No active queue. Send some images first.');
                return;
            }
            await sendList(
                from, secrets,
                `📸 ${session.mediaIds.length} image${session.mediaIds.length > 1 ? 's' : ''} in queue.\nPick a scene style below:`,
                'Choose Scene',
                [{
                    title: 'Scene Styles',
                    rows: [
                        { id: 'scene_model',     title: 'Model Shot',       description: 'Elegant woman wearing your jewelry' },
                        { id: 'scene_flat',      title: 'Flat Lay',         description: 'On white Carrara marble, overhead' },
                        { id: 'scene_white',     title: 'White Background', description: 'Clean minimal e-commerce style' },
                        { id: 'scene_mannequin', title: 'Mannequin',        description: 'On a ceramic display form' },
                    ],
                }],
                'Change Scene'
            );
            return;
        }

        if (replyId === 'btn_new') {
            await sendMainMenu(from, secrets);
            return;
        }

        if (replyId === 'btn_help') {
            await sendMainMenu(from, secrets);
            return;
        }

        // Scene change from within a queued session
        if (replyId?.startsWith('scene_')) {
            const sceneKey = replyId.replace('scene_', '');
            const session = await getSession(from);
            if (!session || !session.mediaIds?.length) {
                await sendText(from, secrets, '📭 No active queue. Send some images first.');
                return;
            }
            const { scene, label } = resolveScene(sceneKey);
            await db.runTransaction(async (t) => {
                const ref = db.collection('sessions').doc(from);
                const doc = await t.get(ref);
                if (doc.exists) t.update(ref, { scene });
            });
            await sendButtons(
                from, secrets,
                `✅ Scene changed to *${label}*`,
                [
                    { id: 'btn_done',   title: '✅ Generate' },
                    { id: 'btn_cancel', title: '🗑️ Cancel' },
                ],
            );
            return;
        }

        // If we didn't handle it, ignore
        if (msg.type === 'interactive') return;
    }

    // ── Text commands ──
    if (msg.type === 'text') {
        const userText = msg.text?.body?.trim() || '';
        const lower = userText.toLowerCase();

        // Check flow state — if user is mid-flow, intercept their text
        const flowSession = await getSession(from);
        if (flowSession?.flowState === 'awaiting_prompt' && userText && !['help','hi','menu','start','cancel','clear','reset'].includes(lower)) {
            // User typed their custom scene description
            const { scene } = resolveScene(userText);
            await setFlowState(from, 'awaiting_image', scene, flowSession.jewelryType);
            await sendText(from, secrets, `Please upload an image to continue 🔗📸\n\n_Scene: ${userText}_`);
            return;
        }

        if (!userText || lower === 'help' || lower === 'hi' || lower === 'menu' || lower === 'start') {
            await clearFlowState(from).catch(() => {});
            await sendMainMenu(from, secrets);
            return;
        }

        // ? → live status check
        if (lower === '?') {
            const [statusDoc, session, nextQueued] = await Promise.all([
                db.collection('status_log').doc(from).get(),
                getSession(from),
                hasPendingNext(from),
            ]);
            if (statusDoc.exists) {
                const { step, detail, at } = statusDoc.data();
                const elapsedSec = Math.round((Date.now() - at) / 1000);
                const elapsedStr = elapsedSec < 60 ? `${elapsedSec}s ago` : `${Math.round(elapsedSec / 60)}m ago`;
                let nextBlock = '';
                if (nextQueued && session?.mediaIds?.length) {
                    const nextLabel = getSceneLabel(session.scene);
                    nextBlock = `\n\n🧾 *Next batch queued*\n📸 ${session.mediaIds.length} image${session.mediaIds.length > 1 ? 's' : ''}\n🎬 Scene: *${nextLabel}*`;
                }
                await sendText(from, secrets,
                    `🔄 *Currently running — Step ${step}/4*\n${detail}\n\n_Started ${elapsedStr}_${nextBlock}`);
            } else if (session?.mediaIds?.length) {
                const label = getSceneLabel(session.scene);
                await sendText(from, secrets,
                    `📋 *Queue ready*\n📸 ${session.mediaIds.length} image${session.mediaIds.length > 1 ? 's' : ''} queued — scene: *${label}*\nType *done* to generate.`);
            } else {
                await sendText(from, secrets, '💤 Nothing running. Send jewelry photos to get started.');
            }
            return;
        }

        // status / queue → show what's in the queue
        if (lower === 'status' || lower === 'queue') {
            const [session, statusDoc, nextQueued] = await Promise.all([
                getSession(from),
                db.collection('status_log').doc(from).get(),
                hasPendingNext(from),
            ]);
            if (statusDoc.exists) {
                const { step, detail, at } = statusDoc.data();
                const elapsedSec = Math.round((Date.now() - at) / 1000);
                const elapsedStr = elapsedSec < 60 ? `${elapsedSec}s ago` : `${Math.round(elapsedSec / 60)}m ago`;
                let message = `🔄 *Currently running — Step ${step}/4*\n${detail}\n\n_Started ${elapsedStr}_`;
                if (nextQueued && session?.mediaIds?.length) {
                    const ageMin = Math.round((Date.now() - (session.queuedAt || session.updatedAt)) / 60000);
                    const label  = getSceneLabel(session.scene);
                    message += `\n\n🧾 *Next batch queued*\n📸 ${session.mediaIds.length} image${session.mediaIds.length > 1 ? 's' : ''}\n🎬 Scene: *${label}*\n🕒 Queued ${ageMin} min ago`;
                }
                await sendText(from, secrets, message);
            } else if (!session || !session.mediaIds?.length) {
                await sendText(from, secrets, '📭 Queue is empty. Send jewelry photos to get started.');
            } else {
                const ageMin = Math.round((Date.now() - (session.queuedAt || session.updatedAt)) / 60000);
                const label  = getSceneLabel(session.scene);
                await sendButtons(
                    from, secrets,
                    `📋 *Queue status*\n📸 ${session.mediaIds.length} image${session.mediaIds.length > 1 ? 's' : ''} queued\n🎬 Scene: *${label}*\n🕒 Queued ${ageMin} min ago`,
                    [
                        { id: 'btn_done',       title: '✅ Generate' },
                        { id: 'btn_scene_menu', title: '🎬 Change Scene' },
                        { id: 'btn_cancel',     title: '🗑️ Cancel' },
                    ],
                );
            }
            return;
        }

        // scene [type] OR bare keyword (model/flat/white/mannequin/bg:...) → update session scene
        const sceneMatch = lower.match(/^scene\s+(.+)/);
        const bareSceneKeyword = /^(model|flat|white|mannequin)$/.test(lower) || /^bg:/i.test(lower);
        const sceneInput = sceneMatch ? sceneMatch[1].trim() : (bareSceneKeyword ? lower : null);
        if (sceneInput) {
            const session = await getSession(from);
            if (!session || !session.mediaIds?.length) {
                await sendText(from, secrets, '📭 No active queue. Send some images first.');
                return;
            }
            const { scene, label } = resolveScene(sceneInput);
            await db.runTransaction(async (t) => {
                const ref = db.collection('sessions').doc(from);
                const doc = await t.get(ref);
                if (doc.exists) t.update(ref, { scene });
            });
            await sendButtons(
                from, secrets,
                `✅ Scene changed to *${label}*`,
                [
                    { id: 'btn_done',   title: '✅ Generate' },
                    { id: 'btn_cancel', title: '🗑️ Cancel' },
                ],
            );
            return;
        }

        // done / go / generate → process queue
        if (lower === 'done' || lower === 'go' || lower === 'generate') {
            if (await isGenerating(from)) {
                const session = await getSession(from);
                if (!session || !session.mediaIds?.length) {
                    await sendText(from, secrets, '⏳ A generation is already running. Send your next product photos now, then type *done* and I will run them right after this one.');
                    return;
                }
                await setPendingNext(from);
                const label = getSceneLabel(session.scene);
                await sendText(from, secrets, `🧾 Next batch queued: ${session.mediaIds.length} image${session.mediaIds.length > 1 ? 's' : ''} — *${label}*.\nI’ll start it automatically when the current generation finishes.`);
                return;
            }

            const session = await getSession(from);
            if (!session || !session.mediaIds?.length) {
                // Images haven't landed yet — set a flag so the image handler auto-triggers
                await setPendingDone(from);
                console.log(`[${reqId}] done received with empty queue — pending_done flag set for ${from}`);
                return; // silent — image handler will confirm and process
            }
            const age = Date.now() - (session.queuedAt || session.updatedAt || 0);
            if (age > QUEUE_REJECT_MS) {
                await clearSession(from);
                await sendText(from, secrets, '⏰ Queued images expired (>60 min — WhatsApp links expire after an hour). Please resend the photos and try again.');
                return;
            }
            if (age > QUEUE_WARN_MS) {
                await sendText(from, secrets, '⚠️ Images are >30 min old — they may have expired. Attempting anyway...');
            }
            const { mediaIds, scene } = session;
            const label = getSceneLabel(scene);
            await clearSession(from);
            await processImages(mediaIds, scene, label, from, phoneNumberId, secrets, ai, reqId);
            return;
        }

        // retry → re-run last failed job
        if (/^retry[.!?]?$/.test(lower)) {
            if (await isGenerating(from)) {
                await sendText(from, secrets, '⏳ A generation is already running. Please wait for it to finish, then type *retry*.');
                return;
            }
            const job = await getRetryJob(from);
            if (!job) {
                await sendText(from, secrets, '🤷 No failed job to retry. Send images and type *done* to generate.');
                return;
            }
            await processImages(job.mediaIds, job.scene, job.label, from, phoneNumberId, secrets, ai, reqId);
            return;
        }

        // cancel / clear / reset → wipe queue
        if (/^(cancel|clear|reset)[.!?]?$/.test(lower)) {
            console.log(`[${reqId}] Cancel command received — clearing session for ${from}`);
            await Promise.all([clearSession(from), clearPendingDone(from)]);
            console.log(`[${reqId}] Session cleared. Sending confirmation...`);
            await sendText(from, secrets, '🗑️ Queue cleared. Send new images whenever you\'re ready.');
            console.log(`[${reqId}] Cancel confirmation sent.`);
            return;
        }

        // desc: [details] → description generator
        // Guard: bare "desc" with no product details → use queued images if available
        const descMatch = userText.match(/^desc(?:ribe)?[:\s]+(.+)/is);
        const isBareDesc = /^desc(?:ribe)?[.!?]?$/i.test(userText.trim());
        if (isBareDesc) {
            // Try queued session images first, then last retry job
            const session = await getSession(from);
            const retryJob = !session?.mediaIds?.length ? await getRetryJob(from) : null;
            const mediaIds = session?.mediaIds?.length ? session.mediaIds : retryJob?.mediaIds;
            if (!mediaIds?.length) {
                await sendText(from, secrets, '✍️ No product in queue. Either send photos first, or type:\n_desc: gold ring with emerald, 925 silver_');
                return;
            }
            await sendText(from, secrets, '⏳ Writing your House of Mina description...');
            try {
                const images = await Promise.all(mediaIds.map(id => downloadWhatsAppMedia(id, secrets)));
                const description = await generateDescription('', ai, images);
                await sendText(from, secrets, description);
                console.log(`[${reqId}] Vision description sent.`);
            } catch (err) {
                console.error(`[${reqId}] Description error:`, err.message);
                await sendText(from, secrets, '❌ Failed to generate description. Try again or type _desc: [product details]_');
            }
            return;
        }
        const productDetails = descMatch ? descMatch[1].trim() : userText;
        console.log(`[${reqId}] Generating description for: ${productDetails}`);
        await sendText(from, secrets, '⏳ Writing your House of Mina description...');
        try {
            const description = await generateDescription(productDetails, ai);
            await sendText(from, secrets, description);
            console.log(`[${reqId}] Description sent.`);
        } catch (err) {
            console.error(`[${reqId}] Description error:`, err.message);
            await sendText(from, secrets, '❌ Failed to generate description. Try again.');
        }
        return;
    }

    // ── Photo handler ──
    if (msg.type !== 'image') return;

    const mediaId = msg.image.id;
    const caption = (msg.image.caption || '').trim() || null;

    // ── Flow-driven: user came through the menu flow → auto-process immediately ──
    const imgSession = await getSession(from);
    if (imgSession?.flowState === 'awaiting_image') {
        const scene = imgSession.scene || SCENES.model;
        const label = getSceneLabel(scene);
        const jewelryType = imgSession.jewelryType;
        const sessionOutputType = imgSession.outputType || 'model';
        await clearSession(from);

        const modeLabel = sessionOutputType === 'both' ? 'model + 4 e-commerce angles'
            : sessionOutputType === 'ecommerce' ? '4 e-commerce angles'
            : label;
        await sendText(from, secrets, `Processing your image \u2728\n\n_Mode: ${modeLabel}_\nPlease wait for the magic to happen \u23f3`);

        // If a jewelry type was selected, inject it into the scene prompt
        let finalScene = scene;
        if (jewelryType) {
            finalScene = scene.replace(/the jewelry/gi, `the ${jewelryType}`);
        }
        await processImages([mediaId], finalScene, label, from, phoneNumberId, secrets, ai, reqId, sessionOutputType);
        return;
    }

    // caption contains "quick" or "now" → skip queue, process immediately
    if (caption && /\b(quick|now)\b/i.test(caption)) {
        const cleanCaption = caption.replace(/\b(quick|now)\b/gi, '').trim() || null;
        const { scene, label } = resolveScene(cleanCaption);
        await processImages([mediaId], scene, label, from, phoneNumberId, secrets, ai, reqId);
        return;
    }

    // Standard: queue the media ID
    try {
        const { count, sceneLabel, showMenu, flowState } = await addMediaIdToSession(from, mediaId, caption);
        if (showMenu) {
            await sendButtons(
                from, secrets,
                `📸 *Photo ${count} queued*\n🎬 Scene: *${sceneLabel}*\n\nSend more angles or tap Generate.`,
                [
                    { id: 'btn_done',       title: '✅ Generate' },
                    { id: 'btn_scene_menu', title: '🎬 Change Scene' },
                    { id: 'btn_cancel',     title: '🗑️ Cancel' },
                ],
                'Photo Queued'
            );
        } else {
            await sendButtons(
                from, secrets,
                `📸 *Photo ${count} queued* — scene: *${sceneLabel}*\n\nSend more angles or tap Generate.`,
                [
                    { id: 'btn_done',       title: '✅ Generate' },
                    { id: 'btn_scene_menu', title: '🎬 Change Scene' },
                    { id: 'btn_cancel',     title: '🗑️ Cancel' },
                ],
            );
        }
        console.log(`[${reqId}] Image ${count} queued for ${from}`);

        // If user already typed "done" before images landed, auto-trigger processing
        const claimed = await claimPendingDone(from);
        if (claimed) {
            if (await isGenerating(from)) {
                await setPendingNext(from);
                console.log(`[${reqId}] pending_done claimed while running — deferred to pending_next for ${from}`);
                return;
            }
            // Poll until image count is stable for 2 consecutive seconds (max 15s)
            // This handles batches of 2, 3, 4 images arriving at different times
            let prevCount = count; // we already know at least 1 landed
            let stableRounds = 0;
            for (let i = 0; i < 15 && stableRounds < 2; i++) {
                await new Promise(r => setTimeout(r, 1000));
                const s = await getSession(from);
                const c = s?.mediaIds?.length || 0;
                if (c > 0 && c === prevCount) {
                    stableRounds++;
                } else {
                    stableRounds = 0;
                    prevCount = c;
                }
            }
            const session = await getSession(from);
            if (session?.mediaIds?.length) {
                const { mediaIds, scene } = session;
                const label = getSceneLabel(scene);
                await clearSession(from);
                console.log(`[${reqId}] Auto-triggering from pending_done — ${mediaIds.length} image(s)`);
                await processImages(mediaIds, scene, label, from, phoneNumberId, secrets, ai, reqId);
            }
        }
    } catch (err) {
        const detail = err?.response?.data ?? err.message;
        console.error(`[${reqId}] ❌ Queue FAILED — ${JSON.stringify(detail)}`);
        await sendText(from, secrets, `[${reqId}] ❌ Failed to queue image. Try again.`).catch(() => {});
    }
}

// ── Download media from Meta ───────────────────────────────────────────────────
async function downloadWhatsAppMedia(mediaId, secrets) {
    const { data: mediaInfo } = await axios.get(`${GRAPH_API}/${mediaId}`, {
        headers: { Authorization: `Bearer ${secrets.whatsappToken}` },
        timeout: 60000,
    });
    const { data: imageBuffer } = await axios.get(mediaInfo.url, {
        headers: { Authorization: `Bearer ${secrets.whatsappToken}` },
        responseType: 'arraybuffer',
        timeout: 120000,
    });
    return {
        base64: Buffer.from(imageBuffer).toString('base64'),
        mimeType: mediaInfo.mime_type || 'image/jpeg',
    };
}

// ── Upload generated image to Meta ────────────────────────────────────────────
async function uploadMediaToMeta(base64Image, phoneNumberId, secrets) {
    const form       = new FormData();
    const imageBuffer = Buffer.from(base64Image, 'base64');

    form.append('file', imageBuffer, { filename: 'jewelry.jpeg', contentType: 'image/jpeg' });
    form.append('type', 'image/jpeg');
    form.append('messaging_product', 'whatsapp');

    const { data } = await axios.post(
        `${GRAPH_API}/${phoneNumberId}/media`,
        form,
        { headers: { ...form.getHeaders(), Authorization: `Bearer ${secrets.whatsappToken}` } }
    );
    return data.id;
}

// ── Send helpers ──────────────────────────────────────────────────────────────
async function sendText(to, secrets, text) {
    await axios.post(
        `${GRAPH_API}/${secrets.whatsappPhoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
        { headers: { Authorization: `Bearer ${secrets.whatsappToken}`, 'Content-Type': 'application/json' } }
    );
}

async function sendImage(to, mediaId, caption, secrets) {
    await axios.post(
        `${GRAPH_API}/${secrets.whatsappPhoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption } },
        { headers: { Authorization: `Bearer ${secrets.whatsappToken}`, 'Content-Type': 'application/json' } }
    );
}

// ── Interactive message helpers (native WhatsApp menus) ─────────────────────
async function sendButtons(to, secrets, body, buttons, header, footer) {
    const interactive = {
        type: 'button',
        body: { text: body },
        action: {
            buttons: buttons.map(b => ({
                type: 'reply',
                reply: { id: b.id, title: b.title },
            })),
        },
    };
    if (header) interactive.header = { type: 'text', text: header };
    if (footer) interactive.footer = { text: footer };
    await axios.post(
        `${GRAPH_API}/${secrets.whatsappPhoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
        { headers: { Authorization: `Bearer ${secrets.whatsappToken}`, 'Content-Type': 'application/json' } }
    );
}

async function sendList(to, secrets, body, buttonText, sections, header, footer) {
    const interactive = {
        type: 'list',
        body: { text: body },
        action: {
            button: buttonText,
            sections,
        },
    };
    if (header) interactive.header = { type: 'text', text: header };
    if (footer) interactive.footer = { text: footer };
    await axios.post(
        `${GRAPH_API}/${secrets.whatsappPhoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
        { headers: { Authorization: `Bearer ${secrets.whatsappToken}`, 'Content-Type': 'application/json' } }
    );
}

// ── Menu flows (Jewel IA-style multi-step menus) ────────────────────────────
async function sendMainMenu(to, secrets) {
    await sendList(
        to, secrets,
        'Please select an option below 👇',
        'Click here',
        [{
            title: 'Services',
            rows: [
                { id: 'flow_model',      title: 'Put Jewellery on Model', description: 'AI model wearing your jewelry' },
                { id: 'flow_ecommerce',  title: 'E-commerce Shots',       description: '4 professional product angles' },
                { id: 'flow_both',       title: 'Model + E-commerce',     description: 'All 5 shots (model + 4 angles)' },
                { id: 'flow_custom',     title: 'Give Your Own Prompt',   description: 'Describe any custom scene' },
                { id: 'flow_desc',       title: 'Product Description',    description: 'Generate WhatsApp product copy' },
                { id: 'flow_bulk',       title: 'Bulk Generation',        description: 'Queue multiple images at once' },
                { id: 'flow_status',     title: 'Check Status',           description: 'See queue & generation progress' },
            ],
        }],
        'House of Mina',
    );
}

async function sendJewelryTypeMenu(to, secrets) {
    await sendList(
        to, secrets,
        'What kind of jewellery?',
        'Select Jewellery',
        [{
            title: 'Jewellery Type',
            rows: [
                { id: 'jewel_set',       title: 'Jewellery Set',          description: 'Full matching set' },
                { id: 'jewel_necklace',  title: 'Necklace',              description: 'Necklace or pendant' },
                { id: 'jewel_earrings',  title: 'Earrings',              description: 'Studs, drops, or chandeliers' },
                { id: 'jewel_ring',      title: 'Ring',                  description: 'Solitaire, band, or cocktail' },
                { id: 'jewel_bracelet',  title: 'Bracelet / Bangle',     description: 'Bracelet, bangle, or kada' },
                { id: 'jewel_tikka',     title: 'Maang Tikka',           description: 'Forehead jewelry' },
                { id: 'jewel_brooch',    title: 'Brooch / Hair Clip',    description: 'Brooch or hair accessory' },
                { id: 'menu_goback',     title: 'Go Back',               description: 'Return to main menu' },
            ],
        }],
        'Select Jewellery',
    );
}

// ── Enhance a raw custom scene description with AI ──────────────────────────
async function enhanceScene(rawDescription, ai) {
    const prompt = `You are a professional photography art director for luxury jewelry editorial campaigns (Vogue, Harper's Bazaar).

A user wants this background/scene for their jewelry product photo: "${rawDescription}"

Write a vivid, specific scene description (3–4 sentences) that:
- Starts with "The jewelry is" or "The jewelry sits/hangs/rests"
- Specifies ONE clear directional light source (window from left, overhead softbox, etc.) and where shadows fall
- Describes exact surfaces, textures, colors, and materials — no vague words like "beautiful" or "elegant"
- Includes one specific detail that makes it feel real and non-staged (a wrinkle in fabric, a wood grain, a leaf, an imperfect surface)
- Describes the camera angle and framing (overhead, slight angle, close-up, etc.)
- Avoids perfectly symmetrical staging — off-center, slightly angled, natural

Return ONLY the scene description, no preamble or explanation.`;
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: [{ parts: [{ text: prompt }] }],
        });
        const text = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
        return text?.trim() || `Place the jewelry in this scene: ${rawDescription}.`;
    } catch {
        return `Place the jewelry in this scene: ${rawDescription}.`;
    }
}

// ── Generate House of Mina WhatsApp product description ─────────────────────
async function generateDescription(productDetails, ai, images = []) {
    const systemPrompt = `You are a WhatsApp product description writer for *House of Mina*, a premium sterling silver jewelry brand based in Pakistan.

Your writing style:
- Open with a short, punchy hook that creates desire or intrigue (1 line)
- List key product specs in bold using WhatsApp formatting (*like this*), keeping it concise
- Use em dashes (—) for dramatic pauses and flow
- Weave in subtle scarcity or exclusivity
- Drop the brand name naturally once
- End with a short CTA block using line breaks

WhatsApp formatting rules:
- Bold = *text* (single asterisk on each side)
- Italic = _text_
- Never use markdown like ** or ##
- Keep line breaks intentional — they affect how it reads on WhatsApp
- Use 1–2 emojis max, only in the CTA block

Default material assumptions (unless specified otherwise):
- Metal: 925 Sterling Silver with white rhodium OR gold plating (use whichever is specified)
- Stones: Cubic Zirconia (CZ)
- Coloured stones: Simulated (e.g. simulated emerald, simulated sapphire) — never call them real
- Only upgrade these if moissanite, certified stones, or real gems are explicitly mentioned

Reference sample (match this tone and structure exactly):
Meet your new obsession. *A certified yellow sapphire. Brilliant zircon accents. 925 sterling silver*. A combination this stunning doesn't come along often — and at *House of Mina*, it's entirely yours. We're celebrating our soft launch with special introductory pricing. These pieces won't wait forever.
📩 DM to order
🇵🇰 Nationwide Delivery`;

    let parts;
    if (images.length > 0) {
        // Vision mode: analyze the actual product photos
        const imageInstruction = productDetails
            ? `Study the jewelry in the attached photo(s) carefully. Identify the piece type, metal color, stone colors and types, and any notable design details. Then write the WhatsApp product description based on what you actually see.\n\nAdditional notes from the seller: ${productDetails}`
            : `Study the jewelry in the attached photo(s) carefully. Identify the piece type, metal color, stone colors and types, and any notable design details. Then write the WhatsApp product description based on what you actually see.`;
        parts = [
            { text: systemPrompt + '\n\n' + imageInstruction },
            ...images.map(img => ({ inlineData: { mimeType: img.mimeType, data: img.base64 } })),
        ];
    } else {
        parts = [{ text: systemPrompt + `\n\nNow write a WhatsApp product description for:\n${productDetails}` }];
    }

    const response = await ai.models.generateContent({
        model: 'gemini-3.1-pro-preview',
        contents: [{ parts }],
    });
    const text = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
    if (!text) throw new Error('No description generated');
    return text.trim();
}

// ── Generate model shot from one or more jewelry images ───────────────────────
async function generateModelShot(images, scene, ai) {
    const sceneInstruction = scene
        ? scene
        : 'Show the jewelry worn on a woman\'s hand \u2014 tight close-up cropped to ONLY the hand and wrist. No face, no body, no neck, no full arm. Just the hand. Natural, elegant hand with relaxed fingers in a graceful pose. Single soft key light from camera-left. Shallow depth of field with the jewelry in razor-sharp focus and the background gently blurred. Square 1:1 crop.';

    const refNote = images.length > 1
        ? `You have ${images.length} reference photos of the jewelry piece from different angles. Study ALL of them to build a complete understanding of the piece before generating.`
        : 'You have been given one reference photo of the jewelry piece.';

    const prompt = [
        'You are simulating a photograph taken by a professional jewelry photographer.',
        refNote,
        '',
        'CRITICAL \u2014 reproduce the jewelry with absolute fidelity:',
        '- Every gemstone: exact color, cut style, facet count, number of stones, their arrangement and size ratios',
        '- Metal: exact color and finish (yellow gold, rose gold, silver, oxidised, brushed, polished, matte)',
        '- Every design detail: prong count, setting style, engraving, filigree, milgrain, links, clasps, chain pattern',
        '- Proportions and scale must match the reference exactly \u2014 do not resize, idealise, or simplify any element',
        '- Do NOT add stones that are not in the reference. Do NOT remove or merge design elements. Do NOT change the metal color.',
        '- IF THE JEWELRY IS A RING: preserve the exact basket/setting profile and the exact shoulder junction where the shank meets the basket. Do NOT replace them with a generic cathedral shoulder, smooth taper, cone basket, donut gallery, peg-head, or tulip setting.',
        '- IF THE JEWELRY IS A RING: if the hand pose or camera angle partly hides the basket or shoulder, keep those areas hidden rather than inventing geometry that is not supported by the reference.',
        '',
        'PHOTOGRAPHIC REALISM \u2014 this must be indistinguishable from an editorial photo in Vogue or Harper\'s Bazaar:',
        '',
        'ANTI-AI CHECKLIST (every point is mandatory):',
        '- FRAMING: Show ONLY the hand and wrist. No face, no neck, no shoulders, no full arm. Crop tightly.',
        '- Hands: visible knuckle creases, slightly uneven nail lengths, natural skin tone variation across fingers. Subtle vein texture on the back of the hand. Realistic nail beds with natural cuticles.',
        '- Skin: real skin on a woman in her early 20s \u2014 fine pore texture on the fingers and back of hand, smooth healthy look, natural tonal variation between knuckles and palm side. NO porcelain-smooth AI skin. ABSOLUTELY NO signs of aging \u2014 no wrinkles, no visible bulging veins, no sun damage, no aged hands.',
        '- Fingers: natural finger proportions, realistic joint bends, fingertips with visible fingerprint texture. Nails should have a natural manicure (not glossy gel, not bare bitten nails).',
        '',
        'LIGHTING:',
        '- One dominant key light source with clear directionality (window light from camera-left, or a single softbox above-right)',
        '- The shadow side of the hand should be noticeably darker, not filled in evenly',
        '- Jewelry should have ONE bright specular highlight and natural shadow falloff \u2014 not glowing from all directions',
        '- Avoid flat, shadowless, "product listing" lighting',
        '',
        'COMPOSITION:',
        '- Shot on an 85mm f/1.4 lens',
        '- Frame it like a real photographer would: rule of thirds, slight negative space, the jewelry at a natural visual anchor point',
        '- Slight depth compression typical of a telephoto portrait lens \u2014 background elements slightly enlarged relative to subject',
        '',
        'BACKGROUND \u2014 STUDIO:',
        '- Professional photography studio with a seamless paper or muslin backdrop in a warm neutral tone (soft grey, warm taupe, or muted beige).',
        '- The backdrop must show subtle real-world imperfections: very faint creases or wrinkles in the paper/fabric, slight tonal unevenness where the light falls off toward the edges.',
        '- Light falloff: center slightly brighter from the key light, gentle natural darkening toward the corners. NOT a perfectly uniform flat tone.',
        '',
        'COLOR:',
        '- Warm, slightly desaturated tones as if shot on Kodak Portra 400 film \u2014 soft contrast, creamy highlights, natural shadow rolloff',
        '- Skin tones should lean warm and natural, never orange or pink-shifted',
        '- Avoid over-saturation \u2014 real editorial photos are usually more muted than you\'d expect',
        '',
        'CAMERA ARTIFACTS (these make it look REAL \u2014 do not skip):',
        '- Fine film grain or sensor noise visible across the entire image, especially in shadow areas and the backdrop. This is the single most important anti-AI signal.',
        '- Very subtle chromatic aberration (color fringing) at high-contrast edges like metal against backdrop.',
        '- Natural vignetting: corners of the frame slightly darker than center.',
        '- Micro-motion: the tiniest sense of life \u2014 not everything frozen perfectly sharp, as if shot at 1/200s.',
        '- Focus falloff should feel optical (gradual, with bokeh circles on specular highlights) not computational (uniform gaussian blur).',
        '',
        'WHAT TO AVOID (common AI tells):',
        '- Perfectly noise-free, grain-free image \u2014 this screams AI. Real cameras always have sensor noise.',
        '- Perfectly smooth skin on the hand \u2014 real hands have texture',
        '- Symmetrical studio lighting with no shadow',
        '- Hyper-sharp everything \u2014 real photos have a focal plane; things before and after it go soft',
        '- Showing any part of the body beyond the hand and wrist',
        '- Jewelry that glows or emits light rather than reflecting it',
        '',
        'JEWELRY LIGHT BEHAVIOR:',
        '- The jewelry must reflect light naturally from the single key source only \u2014 no omnidirectional glow, no self-illumination, no HDR bloom on the metal',
        '- Diamonds: sharp prismatic fire from the key light. Gold: warm single-source reflection. Silver: cool crisp glint.',
        '',
        sceneInstruction,
        '',
        'The jewelry must be the absolute focal point. Every surface facet and metal texture must be visible and physically correct.',
    ].join('\n');

    const imageParts = images.map(img => ({
        inlineData: { mimeType: img.mimeType, data: img.base64 },
    }));

    const requestPayload = {
        model: 'gemini-3-pro-image-preview',
        contents: [{
            parts: [
                { text: prompt },
                ...imageParts,
            ],
        }],
        config: { responseModalities: ['TEXT', 'IMAGE'] },
    };

    // Retry up to 2 times \u2014 abort after 60s per attempt to avoid Gemini hanging
    const GEMINI_TIMEOUT_MS = 60_000;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await ai.models.generateContent({
                ...requestPayload,
                config: {
                    ...requestPayload.config,
                    httpOptions: { timeout: GEMINI_TIMEOUT_MS },
                },
            });
            const parts = response.candidates?.[0]?.content?.parts || [];
            const imagePart = parts.find(p => p.inlineData?.data && !p.thought);
            if (imagePart) return addWatermark(imagePart.inlineData.data);
            console.log(`[Gemini] No image on attempt ${attempt} \u2014 retrying...`);
        } catch (err) {
            if (attempt < 2) {
                const isTimeout = err.name === 'AbortError';
                const delay = isTimeout ? 2000 : attempt * 5000;
                console.log(`[Gemini] ${isTimeout ? 'Timeout' : 'Error'} on attempt ${attempt} (${err.message}) \u2014 retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
    throw new Error('Gemini returned no image after 2 attempts');
}

// ── App bootstrap ────────────────────────────────────────────────────────────
let _cachedApp = null;
function getApp() {
    if (!_cachedApp) {
        const secrets = {
            googleApiKey:       process.env.GOOGLE_API_KEY,
            whatsappToken:      process.env.WHATSAPP_TOKEN,
            whatsappPhoneId:    process.env.WHATSAPP_PHONE_ID,
            webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
        };
        _cachedApp = createApp(secrets);
    }
    return _cachedApp;
}

// ── Firebase Cloud Function exports (always present) ─────────────────────────
exports.api = onRequest((req, res) => getApp()(req, res));

exports.tokenCheck = onSchedule('every 24 hours', async () => {
    const token      = process.env.WHATSAPP_TOKEN;
    const phoneId    = process.env.WHATSAPP_PHONE_ID;
    const ownerPhone = process.env.OWNER_PHONE;
    try {
        await axios.get(`${GRAPH_API}/${phoneId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        console.log('[TokenCheck] ✓ Token is valid');
    } catch (err) {
        const status = err?.response?.status;
        const msg    = err?.response?.data?.error?.message || err.message;
        console.error(`[TokenCheck] ✗ FAILED (${status}): ${msg}`);
        if (ownerPhone) {
            await axios.post(
                `${GRAPH_API}/${phoneId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: ownerPhone,
                    type: 'text',
                    text: { body: `🚨 *House of Mina Bot Alert*\n\nWhatsApp token EXPIRED (HTTP ${status}).\n\nFix:\n1. Get new token from developers.facebook.com\n2. Update WHATSAPP_TOKEN in functions/.env\n3. Run: firebase deploy --only functions --force` },
                },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
            ).catch(e => console.error('[TokenCheck] Could not send WhatsApp alert:', e.message));
        }
    }
});

// ── Standalone server (Railway) — only when RAILWAY=true ────────────────────
if (IS_STANDALONE) {
    try { require('dotenv').config(); } catch {}
    const PORT = process.env.PORT || 3000;
    getApp().listen(PORT, () => {
        console.log(`🚀 WhatsApp Jewelry Bot listening on port ${PORT}`);
    });
}
