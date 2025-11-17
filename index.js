import express from "express";
import fetch from "node-fetch";
import Database from "better-sqlite3";
import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();

const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const username = process.env.TWITCH_USERNAME;
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

// --- Check if streamer is live ---
async function isStreamerLive() {
  if (!accessToken) await getAccessToken();

  const broadcasterId = await getBroadcasterId();
  const res = await fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`, {
    headers: { "Client-ID": clientId, "Authorization": `Bearer ${accessToken}` }
  });

  const data = await res.json();
  return data.data && data.data.length > 0;
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

// --- Check recent clips and notify Discord ---
async function checkRecentClips() {
  const database = initDb();
  if (!accessToken) await getAccessToken();

  const broadcasterId = await getBroadcasterId();
  if (!broadcasterId) throw new Error("Streamer introuvable");

  // Récupérer uniquement la première page (clips les plus récents)
  const res = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&first=20`, {
    headers: { "Client-ID": clientId, "Authorization": `Bearer ${accessToken}` }
  });

  if (res.status === 401) {
    await getAccessToken();
    return checkRecentClips();
  }

  const data = await res.json();
  let newClips = 0;

  const insertStmt = database.prepare(`
    INSERT OR IGNORE INTO clips (id,url,title,game_name,broadcaster_name,created_at,view_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

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

    if (result.changes > 0) {
      newClips++;
      // Envoyer sur Discord
      await sendClipToDiscord(c);
    }
  }

  if (newClips > 0) {
    console.log(`[Check] ${newClips} nouveau(x) clip(s) détecté(s) et envoyé(s) sur Discord`);
  }
}

// --- Express API ---
const app = express();

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

// --- Cron jobs ---

// Cron 1: Mise à jour complète de tous les clips (toutes les 6 heures)
const fullUpdateSchedule = process.env.FULL_UPDATE_CRON || "0 */6 * * *";
console.log(`⏰ Cron mise à jour complète: ${fullUpdateSchedule}`);
cron.schedule(fullUpdateSchedule, () => {
  console.log("[Cron Full] Démarrage de la mise à jour complète...");
  updateClips().catch(err => console.error("Erreur CRON Full:", err.message));
});

// Cron 2: Vérification des nouveaux clips (adaptatif selon si en live ou non)
let isLive = false;
let checkInterval = null;

async function startAdaptiveChecking() {
  const checkStatus = async () => {
    try {
      const wasLive = isLive;
      isLive = await isStreamerLive();

      if (isLive !== wasLive) {
        console.log(`[Cron Check] Statut changé: ${isLive ? "🔴 EN LIVE" : "⚫ HORS LIGNE"}`);
        // Redémarrer le cron avec la bonne fréquence
        if (checkInterval) {
          checkInterval.stop();
        }

        const schedule = isLive ? "* * * * *" : "0 * * * *"; // 1 minute si live, 1 heure sinon
        console.log(`[Cron Check] Nouvelle fréquence: ${isLive ? "toutes les minutes" : "toutes les heures"}`);

        checkInterval = cron.schedule(schedule, async () => {
          await checkRecentClips().catch(err => console.error("Erreur CRON Check:", err.message));
        });
      }

      await checkRecentClips();
    } catch (err) {
      console.error("Erreur lors de la vérification du statut:", err.message);
    }
  };

  // Vérification initiale
  await checkStatus();

  // Vérifier le statut live toutes les 5 minutes
  cron.schedule("*/5 * * * *", checkStatus);
}

startAdaptiveChecking();

// --- Démarrage serveur ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Serveur lancé sur le port ${PORT}`);
  await updateClips(); // fetch initial
});
