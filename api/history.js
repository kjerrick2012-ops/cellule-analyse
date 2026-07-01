// =====================================================================
//  /api/history  —  Historique des coupons, stocké en ligne (Vercel KV)
//
//  Utilise la base "Vercel KV" (Redis) via son API REST. Quand tu relies
//  une base KV à ton projet, Vercel ajoute automatiquement les variables :
//     KV_REST_API_URL
//     KV_REST_API_TOKEN
//  Aucune clé à copier à la main pour celle-ci.
//
//  Méthodes :
//    GET  /api/history            -> { runs: [...] }         (liste, plus récent d'abord)
//    POST /api/history {run}      -> { ok:true, run }         (ajoute un coupon)
//    POST /api/history {grade:{runId,idx,status}} -> { ok }   (note gagné/perdu)
//    POST /api/history {del:{runId}} -> { ok }                (supprime un coupon)
// =====================================================================

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_API_TOKEN;
const KEY = "jeybet:runs"; // une seule liste JSON pour tout l'historique

function kvConfigured() { return !!(URL && TOKEN); }

async function kvGet() {
  const r = await fetch(`${URL}/get/${KEY}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) return [];
  const data = await r.json();               // { result: "<string|null>" }
  if (!data || data.result == null) return [];
  try { return JSON.parse(data.result) || []; } catch (_) { return []; }
}

async function kvSet(arr) {
  // /set/<key>/<value> — on envoie la valeur JSON dans le corps
  const r = await fetch(`${URL}/set/${KEY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" },
    body: JSON.stringify(arr),
  });
  return r.ok;
}

module.exports = async (req, res) => {
  if (!kvConfigured()) {
    res.status(500).json({ error: "Base d'historique non configurée (KV non reliée au projet)." });
    return;
  }

  try {
    if (req.method === "GET") {
      const runs = await kvGet();
      runs.sort((a, b) => (b.date || 0) - (a.date || 0));
      res.status(200).json({ runs });
      return;
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      const runs = await kvGet();

      if (body && body.run) {
        // nouveau coupon
        const run = body.run;
        if (!run.id) run.id = Date.now();
        runs.push(run);
        // garde un historique raisonnable (les 200 derniers)
        const trimmed = runs.slice(-200);
        await kvSet(trimmed);
        res.status(200).json({ ok: true, run });
        return;
      }

      if (body && body.grade) {
        // notation gagné / perdu / en attente
        const { runId, idx, status } = body.grade;
        const run = runs.find(r => String(r.id) === String(runId));
        if (run && run.picks && run.picks[idx]) {
          run.picks[idx].status = run.picks[idx].status === status ? "pending" : status;
          await kvSet(runs);
        }
        res.status(200).json({ ok: true });
        return;
      }

      if (body && body.del) {
        const next = runs.filter(r => String(r.id) !== String(body.del.runId));
        await kvSet(next);
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: "Requête invalide" });
      return;
    }

    res.status(405).json({ error: "Méthode non autorisée" });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
