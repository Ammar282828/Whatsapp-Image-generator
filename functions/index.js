const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');

const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const FormData = require('form-data');
const { GoogleGenAI } = require('@google/genai');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
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
    let count, sceneLabel, showMenu;
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
        t.set(ref, {
            mediaIds,
            scene,
            menuSent: true,
            updatedAt: now,
            queuedAt:  data.queuedAt || now,
            expiresAt: now + SESSION_EXPIRY_MS,
        });
    });
    return { count, sceneLabel, showMenu };
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

// ── Core image generation pipeline ───────────────────────────────────────────
const MAX_AUTO_QUEUE_DEPTH = 3;

async function processImages(mediaIds, scene, label, from, phoneNumberId, secrets, ai, reqId, _depth = 0) {
    const log = async (text) => {
        console.log(`[${reqId}] ${text}`);
        await sendText(from, secrets, `[${reqId}] ${text}`).catch(() => {});
    };
    try {
        await setGenerating(from, reqId);
        await saveRetryJob(from, mediaIds, scene, label);
        const startTime = Date.now();
        await setStatus(from, 1, `Downloading ${mediaIds.length} image${mediaIds.length > 1 ? 's' : ''} from WhatsApp`);
        await log(`⏳ Step 1/4 — Downloading ${mediaIds.length} image${mediaIds.length > 1 ? 's' : ''} from WhatsApp...`);
        const images = await Promise.all(mediaIds.map(id => downloadWhatsAppMedia(id, secrets)));

        // Quality check — warn but don't block
        const warnings = [];
        for (let i = 0; i < images.length; i++) {
            const qc = await checkImageQuality(images[i].base64);
            if (!qc.ok) warnings.push(`Image ${i + 1}: ${qc.reason}`);
        }
        if (warnings.length) {
            await sendText(from, secrets, `⚠️ Quality note${warnings.length > 1 ? 's' : ''}:\n${warnings.join('\n')}\nAttempting anyway...`);
        }
        await log(`✅ Step 1/4 — Downloaded`);

        // Silently enhance any custom scene description before generation
        let finalScene = scene;
        if (scene.startsWith('Place the jewelry in this scene:')) {
            const rawCaption = scene.replace(/^Place the jewelry in this scene:\s*/i, '').replace(/\.$/, '');
            console.log(`[${reqId}] Enhancing custom scene: "${rawCaption}"`);
            await setStatus(from, 2, `Enhancing scene description for "${rawCaption}"`);
            finalScene = await enhanceScene(rawCaption, ai);
            console.log(`[${reqId}] Enhanced scene: "${finalScene}"`);
        }

        await setStatus(from, 2, `Generating ${label} from ${images.length} angle${images.length > 1 ? 's' : ''} — this takes 1–5 mins`);
        await log(`⏳ Step 2/4 — Generating *${label}* from ${images.length} angle${images.length > 1 ? 's' : ''}...`);
        const imageBase64 = await generateModelShot(images, finalScene, ai);
        await log(`✅ Step 2/4 — Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

        await setStatus(from, 3, 'Uploading generated image to WhatsApp');
        await log(`⏳ Step 3/4 — Uploading to WhatsApp...`);
        const uploadedMediaId = await uploadMediaToMeta(imageBase64, phoneNumberId, secrets);
        await log(`✅ Step 3/4 — Uploaded`);

        await setStatus(from, 4, 'Sending image to you');
        await log(`⏳ Step 4/4 — Sending your image...`);
        await sendImage(from, uploadedMediaId, `✨ ${label} — generated with Gemini`, secrets);

        // Auto-write product copy for every generated output, based on the same reference photos.
        try {
            const autoDescription = await generateDescription('', ai, images);
            await sendText(from, secrets, autoDescription);
            console.log(`[${reqId}] Auto description sent.`);
        } catch (descErr) {
            console.error(`[${reqId}] Auto description failed:`, descErr.message);
            await sendText(from, secrets, '⚠️ Image sent, but auto-description failed. Type *desc* to generate it manually.').catch(() => {});
        }

        await log(`🎉 Done! Total: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        await clearRetryJob(from);
        await clearStatus(from);
    } catch (err) {
        const detail = err?.response?.data ?? err.message;
        console.error(`[${reqId}] ❌ FAILED — ${JSON.stringify(detail)}`);
        const errMsg = err?.message?.includes('safety')
            ? '⚠️ Blocked by safety filters. Try a different photo.'
            : `❌ Error: ${JSON.stringify(detail)}`;
        await sendText(from, secrets, `[${reqId}] ${errMsg}`).catch(() => {});
        await clearStatus(from);
    } finally {
        await clearGenerating(from).catch(() => {});

        // Auto-start the next queued batch if user requested "done" during this run.
        if (_depth >= MAX_AUTO_QUEUE_DEPTH) {
            console.log(`[${reqId}] Max auto-queue depth (${MAX_AUTO_QUEUE_DEPTH}) reached — skipping next batch`);
        } else {
            const shouldStartNext = await claimPendingNext(from).catch(() => false);
            if (shouldStartNext) {
                const session = await getSession(from).catch(() => null);
                if (session?.mediaIds?.length) {
                    const { mediaIds, scene: nextScene } = session;
                    const nextLabel = getSceneLabel(nextScene);
                    await clearSession(from).catch(() => {});
                    const nextReqId = Math.random().toString(36).slice(2, 8).toUpperCase();
                    console.log(`[${reqId}] Starting queued next batch — ${mediaIds.length} image(s)`);
                    await processImages(mediaIds, nextScene, nextLabel, from, phoneNumberId, secrets, ai, nextReqId, _depth + 1);
                }
            }
        }
    }
}

// ── Message handler ────────────────────────────────────────────────────────────
async function handleMessage(msg, phoneNumberId, secrets, ai, reqId) {
    const from = msg.from;
    console.log(`[${reqId}] From: ${from} | Type: ${msg.type}`);

    // ── Text commands ──
    if (msg.type === 'text') {
        const userText = msg.text?.body?.trim() || '';
        const lower = userText.toLowerCase();

        if (!userText || lower === 'help' || lower === 'hi' || lower === 'menu' || lower === 'start') {
            await sendText(from, secrets, HELP_MESSAGE);
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
                await sendText(from, secrets,
                    `📋 *Queue status*\n📸 ${session.mediaIds.length} image${session.mediaIds.length > 1 ? 's' : ''} queued\n🎬 Scene: *${label}*\n🕒 Queued ${ageMin} min ago\n\nType *done* to generate or *cancel* to clear.`);
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
            await sendText(from, secrets, `✅ Scene set to *${label}*. Type *done* to generate.`);
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

    // caption contains "quick" or "now" → skip queue, process immediately
    if (caption && /\b(quick|now)\b/i.test(caption)) {
        const cleanCaption = caption.replace(/\b(quick|now)\b/gi, '').trim() || null;
        const { scene, label } = resolveScene(cleanCaption);
        await processImages([mediaId], scene, label, from, phoneNumberId, secrets, ai, reqId);
        return;
    }

    // Standard: queue the media ID
    try {
        const { count, sceneLabel, showMenu } = await addMediaIdToSession(from, mediaId, caption);
        const sceneHint = showMenu
            ? [
                `🎬 Scene: *${sceneLabel}*`,
                'To change, type *scene* followed by:',
                '• _model_ — fashion model shot',
                '• _flat_ — flat lay on marble',
                '• _white_ — clean white background',
                '• _mannequin_ — on a mannequin',
                '• _bg: [anything]_ — fully custom scene',
              ].join('\n')
            : `🎬 Scene: *${sceneLabel}*`;
        const reply = `📸 *Photo queued* — send more angles or type *done* to generate.\n\n${sceneHint}`;
        await sendText(from, secrets, reply);
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
        { headers: { ...form.getHeaders(), Authorization: `Bearer ${secrets.whatsappToken}` }, timeout: 60_000 }
    );
    return data.id;
}

// ── Send helpers ──────────────────────────────────────────────────────────────
async function sendText(to, secrets, text) {
    await axios.post(
        `${GRAPH_API}/${secrets.whatsappPhoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
        { headers: { Authorization: `Bearer ${secrets.whatsappToken}`, 'Content-Type': 'application/json' }, timeout: 30_000 }
    );
}

async function sendImage(to, mediaId, caption, secrets) {
    await axios.post(
        `${GRAPH_API}/${secrets.whatsappPhoneId}/messages`,
        { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption } },
        { headers: { Authorization: `Bearer ${secrets.whatsappToken}`, 'Content-Type': 'application/json' }, timeout: 30_000 }
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
            config: { httpOptions: { timeout: 30_000 } },
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
        config: { httpOptions: { timeout: 60_000 } },
    });
    const text = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
    if (!text) throw new Error('No description generated');
    return text.trim();
}

// ── Generate model shot from one or more jewelry images ───────────────────────
async function generateModelShot(images, scene, ai) {
    const angleDesc = images.length > 1
        ? `${images.length} reference photos showing different angles of the same jewelry piece`
        : 'reference photo';

    const prompt = [
        `You are simulating a photograph taken by a professional jewelry photographer. You have been given ${angleDesc}.`,
        '',
        'CRITICAL — reproduce the jewelry with absolute fidelity:',
        '- Every gemstone: exact color, cut style, facet count, number of stones, their arrangement and size ratios',
        '- Metal: exact color and finish (yellow gold, rose gold, silver, oxidised, brushed, polished, matte)',
        '- Every design detail: prong count, setting style, engraving, filigree, milgrain, links, clasps, chain pattern',
        '- Proportions and scale must match the reference exactly — do not resize, idealise, or simplify any element',
        '- Do NOT add stones that are not in the reference. Do NOT remove or merge design elements. Do NOT change the metal color.',
        '',
        'PHOTOGRAPHIC REALISM — this must be indistinguishable from an editorial photo in Vogue or Harper\'s Bazaar:',
        '',
        'ANTI-AI CHECKLIST (every point is mandatory):',
        '- Asymmetry: the model\'s pose must NOT be perfectly symmetrical. One shoulder slightly higher, head tilted, weight shifted to one hip',
        '- Hands: if visible, they must have visible knuckle creases, slightly uneven nail lengths, natural skin tone variation across fingers. If you cannot render hands convincingly, crop or pose to hide them',
        '- Skin: real editorial skin on a woman in her mid-20s — fine pore texture, smooth healthy collagen-rich look, very subtle natural tonal variation, and only mild under-eye depth. Keep it youthful and fresh (not aged, crepey, or deeply lined). NO porcelain-smooth AI skin. Think "great skin on a real person" not "skin replaced by smooth plastic"',
        '- Hair: individual flyaway strands catching light, slight frizz near the hairline, not every strand perfectly placed. Hair should interact with jewelry naturally (catching on a necklace clasp, brushing against an earring)',
        '- Eyes: slight moisture/reflection, visible blood vessels in the sclera if close enough, catch-light must come from a single consistent light source — NOT the generic two-dot AI catchlight',
        '- Fabric/clothing: visible weave texture, natural creasing at joints, slight texture variation. Not smooth CG cloth',
        '',
        'LIGHTING:',
        '- One dominant key light source with clear directionality (window light from camera-left, or a single softbox above-right)',
        '- The shadow side of the face/body should be noticeably darker, not filled in evenly',
        '- Jewelry should have ONE bright specular highlight and natural shadow falloff — not glowing from all directions',
        '- Avoid flat, shadowless, "product listing" lighting',
        '',
        'COMPOSITION:',
        '- Frame TIGHT on the jewelry — it should fill at least 40-50% of the image area. Crop in close so every detail is clearly visible',
        '- Use a close-up or macro-style framing: the jewelry and the body part wearing it (hand, neck, ear, wrist) should dominate the frame',
        '- Minimal negative space — do NOT pull back to show full body or wide scenery',
        '- Slight depth compression typical of a telephoto portrait lens — background elements slightly enlarged relative to subject',
        '- Background should have genuine optical bokeh with slight chromatic fringing at high-contrast edges, not gaussian blur',
        '',
        'COLOR:',
        '- Muted, slightly desaturated warmth of film-emulation color grading (like VSCO Portra 400 or Fuji Pro 400H)',
        '- Skin tones should lean warm and natural, never orange or pink-shifted',
        '- Avoid over-saturation — real editorial photos are usually more muted than you\'d expect',
        '',
        'WHAT TO AVOID (common AI tells):',
        '- Perfectly smooth gradients on skin or backgrounds',
        '- Symmetrical studio lighting with no shadow',
        '- Overly glossy or "wet look" skin',
        '- Visible age progression cues: deep nasolabial folds, pronounced crow\'s feet, forehead creases, sagging jawline texture',
        '- Perfect teeth if mouth is open',
        '- Generic "fashion pose" with no personality',
        '- Background that looks painted or digitally composited',
        '- Jewelry that glows or emits light rather than reflecting it',
        '',
        scene,
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

    // Retry up to 2 times — abort after 60s per attempt to avoid Gemini hanging
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

// ── Export as Firebase Cloud Function ─────────────────────────────────────────
// Cache the Express app per instance — avoids rebuilding routes/AI client on every request
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

exports.api = onRequest((req, res) => getApp()(req, res));

// ── Daily token health check ───────────────────────────────────────────────────
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
