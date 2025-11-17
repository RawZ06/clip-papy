import express from "express";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import cron from "node-cron";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const username = process.env.TWITCH_USERNAME;
const webhookSecret = process.env.TWITCH_WEBHOOK_SECRET || crypto.randomBytes(32).toString("hex");
const webhookCallbackUrl = process.env.WEBHOOK_CALLBACK_URL;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;

if (!clientId || !clientSecret || !username) {
  console.error("❌ Variables d'environnement manquantes (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_USERNAME)");
  process.exit(1);
}

let accessToken = null;
let db = null;

// --- DB ---
function initDb() {
  if (db) return db;
  const dbPath = process.env.DB_PATH || "./clips.db";
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      url TEXT,
      title TEXT,
      game_name TEXT,
      broadcaster_name TEXT,
      created_at TEXT,
      view_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_game ON clips (game_name);
    CREATE INDEX IF NOT EXISTS idx_created ON clips (created_at);
  `);
  return db;
}

// --- Twitch API helpers ---
async function getAccessToken() {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Impossible d'obtenir un token");
  accessToken = data.access_token;
}

async function getBroadcasterId() {
  const res = await fetch(`https://api.twitch.tv/helix/users?login=${username}`, {
    headers: { "Client-ID": clientId, "Authorization": `Bearer ${accessToken}` }
  });
  const data = await res.json();
  return data.data?.[0]?.id;
}

// --- Fetch clips from Twitch and store ---
async function updateClips() {
  const database = initDb();
  if (!accessToken) await getAccessToken();

  const broadcasterId = await getBroadcasterId();
  if (!broadcasterId) throw new Error("Streamer introuvable");

  let cursor = null;
  let pages = 0;
  let inserted = 0;

  console.log("[Cron] Mise à jour des clips Twitch...");

  const insertStmt = database.prepare(`
    INSERT OR IGNORE INTO clips (id,url,title,game_name,broadcaster_name,created_at,view_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  do {
    const params = new URLSearchParams({ broadcaster_id: broadcasterId, first: "50" });
    if (cursor) params.set("after", cursor);

    const res = await fetch(`https://api.twitch.tv/helix/clips?${params}`, {
      headers: { "Client-ID": clientId, "Authorization": `Bearer ${accessToken}` }
    });

    if (res.status === 401) {
      await getAccessToken();
      continue;
    }

    const data = await res.json();

    for (const c of data.data || []) {
      const result = insertStmt.run(
        c.id,
        c.url,
        c.title,
        c.game_name || "",
        c.broadcaster_name,
        c.created_at,
        c.view_count
      );
      if (result.changes > 0) inserted++;
    }

    cursor = data.pagination?.cursor;
    pages++;
    console.log(`[Cron] Clips en cours, (${inserted} nouveaux).`);
  } while (cursor);

  console.log(`[Cron] Clips mis à jour (${inserted} nouveaux).`);
}

// --- Sync a specific clip by ID ---
async function syncClipById(clipId) {
  const database = initDb();
  if (!accessToken) await getAccessToken();

  const res = await fetch(`https://api.twitch.tv/helix/clips?id=${clipId}`, {
    headers: { "Client-ID": clientId, "Authorization": `Bearer ${accessToken}` }
  });

  if (res.status === 401) {
    await getAccessToken();
    return syncClipById(clipId);
  }

  const data = await res.json();

  if (!data.data || data.data.length === 0) {
    throw new Error("Clip non trouvé");
  }

  const c = data.data[0];
  const insertStmt = database.prepare(`
    INSERT OR REPLACE INTO clips (id,url,title,game_name,broadcaster_name,created_at,view_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    c.id,
    c.url,
    c.title,
    c.game_name || "",
    c.broadcaster_name,
    c.created_at,
    c.view_count
  );

  return c;
}

// --- Discord notification ---
async function sendClipToDiscord(clip) {
  if (!discordWebhookUrl) {
    return;
  }

  try {
    const embed = {
      title: clip.title || "Nouveau clip !",
      url: clip.url,
      color: 0x9146FF,
      thumbnail: {
        url: clip.thumbnail_url || ""
      },
      fields: [
        {
          name: "Créateur",
          value: clip.creator_name || "Inconnu",
          inline: true
        },
        {
          name: "Vues",
          value: String(clip.view_count || 0),
          inline: true
        },
        {
          name: "Durée",
          value: `${clip.duration || 0}s`,
          inline: true
        }
      ],
      timestamp: clip.created_at,
      footer: {
        text: `${clip.broadcaster_name} • Twitch`,
        icon_url: "https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png"
      }
    };

    if (clip.game_name) {
      embed.fields.push({
        name: "Jeu",
        value: clip.game_name,
        inline: true
      });
    }

    await fetch(discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `🎬 **Nouveau clip créé !**`,
        embeds: [embed]
      })
    });

    console.log(`[Discord] Clip ${clip.id} envoyé sur Discord`);
  } catch (err) {
    console.error(`[Discord] Erreur lors de l'envoi:`, err.message);
  }
}

// --- EventSub Webhook ---
async function subscribeToClipCreated(broadcasterId) {
  if (!webhookCallbackUrl) {
    console.log("⚠️  WEBHOOK_CALLBACK_URL non défini, webhook non activé");
    return;
  }

  if (!accessToken) await getAccessToken();

  const body = {
    type: "clip.create",
    version: "1",
    condition: {
      broadcaster_user_id: broadcasterId
    },
    transport: {
      method: "webhook",
      callback: webhookCallbackUrl,
      secret: webhookSecret
    }
  };

  const res = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
    method: "POST",
    headers: {
      "Client-ID": clientId,
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (res.status === 202) {
    console.log("✅ Webhook EventSub enregistré pour clip.create");
  } else if (res.status === 409) {
    console.log("ℹ️  Webhook EventSub déjà enregistré");
  } else {
    console.error("❌ Erreur webhook:", data);
  }
}

function verifyTwitchSignature(req) {
  const messageId = req.headers["twitch-eventsub-message-id"];
  const timestamp = req.headers["twitch-eventsub-message-timestamp"];
  const signature = req.headers["twitch-eventsub-message-signature"];
  const body = JSON.stringify(req.body);

  const hmac = crypto.createHmac("sha256", webhookSecret);
  hmac.update(messageId + timestamp + body);
  const expectedSignature = "sha256=" + hmac.digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// --- Express API ---
const app = express();
app.use(express.json());

// Webhook EventSub endpoint
app.post("/webhook/eventsub", async (req, res) => {
  const messageType = req.headers["twitch-eventsub-message-type"];

  // Vérification de la signature
  if (!verifyTwitchSignature(req)) {
    console.error("❌ Signature webhook invalide");
    return res.status(403).send("Forbidden");
  }

  // Challenge de vérification
  if (messageType === "webhook_callback_verification") {
    console.log("✅ Webhook vérifié par Twitch");
    return res.status(200).send(req.body.challenge);
  }

  // Notification d'événement
  if (messageType === "notification") {
    const event = req.body.event;
    console.log(`[Webhook] Nouveau clip créé: ${event.id}`);

    try {
      const clip = await syncClipById(event.id);
      console.log(`[Webhook] Clip ${event.id} synchronisé avec succès`);

      // Envoyer le clip sur Discord
      await sendClipToDiscord(clip);
    } catch (err) {
      console.error(`[Webhook] Erreur sync clip ${event.id}:`, err.message);
    }

    return res.status(200).send("OK");
  }

  // Révocation
  if (messageType === "revocation") {
    console.log("⚠️  Webhook révoqué par Twitch:", req.body.subscription.status);
    return res.status(200).send("OK");
  }

  res.status(200).send("OK");
});

app.get("/api/clip", (req, res) => {
  const database = initDb();
  const { date, title, game } = req.query;

  let where = [];
  let params = [];

  const normalize = s => s?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  if (date) {
    const d = date.trim().split("/");
    let start, end;
    if (d.length === 3) {
      const [jj, mm, yyyy] = d.map(Number);
      start = new Date(yyyy, mm - 1, jj).toISOString();
      end = new Date(yyyy, mm - 1, jj + 1).toISOString();
    } else if (d.length === 2) {
      const [mm, yyyy] = d.map(Number);
      start = new Date(yyyy, mm - 1, 1).toISOString();
      end = new Date(yyyy, mm, 1).toISOString();
    } else if (/^\d{4}$/.test(date)) {
      const yyyy = Number(date);
      start = new Date(yyyy, 0, 1).toISOString();
      end = new Date(yyyy + 1, 0, 1).toISOString();
    }
    where.push("created_at BETWEEN ? AND ?");
    params.push(start, end);
  }

  if (title) {
    const t = `%${normalize(title)}%`;
    where.push("lower(title) LIKE ?");
    params.push(t);
  }

  if (game) {
    const g = `%${normalize(game)}%`;
    where.push("lower(game_name) LIKE ?");
    params.push(g);
  }

  const query = `
    SELECT * FROM clips
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY RANDOM() LIMIT 1;
  `;
  const clip = database.prepare(query).get(...params);

  if (!clip) return res.status(404).send("Aucun clip trouvé pour ces critères.");
  res.json(clip);
});

app.get("/api/sync-clip/:clipId", async (req, res) => {
  try {
    const { clipId } = req.params;
    const clip = await syncClipById(clipId);
    res.json({ success: true, clip });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/sync-clip/:clipId", async (req, res) => {
  try {
    const { clipId } = req.params;
    const clip = await syncClipById(clipId);
    res.json({ success: true, clip });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Lancement du cron ---
const cronSchedule = process.env.CRON_SCHEDULE || "0 */6 * * *";
console.log(`⏰ Cron configuré: ${cronSchedule}`);
cron.schedule(cronSchedule, () => {
  updateClips().catch(err => console.error("Erreur CRON:", err.message));
});

// --- Démarrage serveur ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
  await updateClips(); // fetch initial

  // Enregistrer le webhook
  if (webhookCallbackUrl) {
    try {
      const broadcasterId = await getBroadcasterId();
      await subscribeToClipCreated(broadcasterId);
    } catch (err) {
      console.error("❌ Erreur lors de l'enregistrement du webhook:", err.message);
    }
  }
});
