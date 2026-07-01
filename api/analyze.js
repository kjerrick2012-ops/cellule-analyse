// =====================================================================
//  /api/analyze  —  Fonction serverless Vercel
//  Reçoit { sport, comp }, renvoie { picks:[...], note, oddsSource }.
//
//  Les clés (Anthropic + The Odds API) restent SECRÈTES ici, côté serveur.
//  Elles ne sont jamais envoyées au navigateur.
//
//  Variables d'environnement à définir dans Vercel (Settings → Environment Variables) :
//    ANTHROPIC_API_KEY   (obligatoire)  -> https://console.anthropic.com
//    ODDS_API_KEY        (optionnel)    -> https://the-odds-api.com  (500 req/mois gratuites)
//    MODEL               (optionnel)    -> défaut: claude-sonnet-4-6
// =====================================================================

const MODEL = process.env.MODEL || "claude-sonnet-4-6";
const TODAY = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

// ---------------------------------------------------------------------
// 1) Cotes réelles via The Odds API (best-effort, jamais bloquant)
//    On liste les sports ACTIFS, on devine celui qui colle à la
//    compétition demandée, puis on récupère quelques matchs + cotes.
// ---------------------------------------------------------------------
function deburr(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

async function fetchRealOdds(comp, sport) {
  const key = process.env.ODDS_API_KEY;
  if (!key) return null;
  try {
    const sportsRes = await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${key}`);
    if (!sportsRes.ok) return null;
    const sports = await sportsRes.json(); // [{key, group, title, active, ...}]
    if (!Array.isArray(sports)) return null;

    // tokens issus de la compétition + sport pour faire le matching
    const tokens = deburr(`${comp} ${sport}`).split(/[^a-z0-9]+/).filter(t => t.length > 2);
    // alias utiles FR -> termes The Odds API
    const aliases = {
      "coupe": ["world", "cup", "fifa"], "monde": ["world", "cup", "fifa"],
      "ligue": ["league", "ligue"], "espagne": ["spain", "liga"], "bresil": ["brazil", "campeonato"],
      "mexique": ["mexico", "liga"], "argentine": ["argentina"], "angleterre": ["epl", "england"],
      "allemagne": ["bundesliga", "germany"], "italie": ["serie", "italy"], "football": ["soccer"],
      "basket": ["basketball"], "tennis": ["tennis"], "baseball": ["baseball"], "hockey": ["hockey"],
    };
    const wanted = new Set(tokens);
    tokens.forEach(t => (aliases[t] || []).forEach(a => wanted.add(a)));

    let best = null, bestScore = 0;
    for (const s of sports) {
      if (!s.active) continue;
      const hay = deburr(`${s.group} ${s.title} ${s.key}`);
      let score = 0;
      wanted.forEach(w => { if (hay.includes(w)) score++; });
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (!best || bestScore === 0) return null;

    const oddsRes = await fetch(
      `https://api.the-odds-api.com/v4/sports/${best.key}/odds/` +
      `?apiKey=${key}&regions=eu&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`
    );
    if (!oddsRes.ok) return null;
    const events = await oddsRes.json();
    if (!Array.isArray(events) || events.length === 0) return null;

    // On compacte : jusqu'à 8 matchs, 1er bookmaker dispo, marchés h2h + totals
    const compact = events.slice(0, 8).map(ev => {
      const bk = (ev.bookmakers || [])[0];
      const markets = {};
      (bk?.markets || []).forEach(m => {
        markets[m.key] = (m.outcomes || []).map(o => ({
          n: o.name, p: o.price, ...(o.point != null ? { pt: o.point } : {})
        }));
      });
      return {
        match: `${ev.home_team} vs ${ev.away_team}`,
        date: ev.commence_time,
        bookmaker: bk?.title || null,
        markets,
      };
    });
    return { competition: best.title, events: compact };
  } catch (_) {
    return null; // jamais bloquant : on retombera sur la recherche web
  }
}

// ---------------------------------------------------------------------
// 2) Analyse experte via l'API Anthropic (avec recherche web)
// ---------------------------------------------------------------------
async function analyze(sport, comp, oddsData, history, threshold) {
  const MINCONF = Number(threshold) || 80;
  const nowMs = Date.now();
  const winStart = new Date(nowMs + 2 * 3600 * 1000);      // +2 heures
  const winEnd = new Date(nowMs + 7 * 24 * 3600 * 1000);   // +7 jours
  const fmt = d => d.toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
  const windowRule =
    `IMPORTANT — FENÊTRE HORAIRE STRICTE : ne retiens QUE les matchs dont le coup d'envoi se situe entre ` +
    `${fmt(winStart)} (dans 2 heures) et ${fmt(winEnd)} (dans 7 jours). ` +
    `Vérifie l'heure de début réelle de chaque match : exclus tout match qui commence dans moins de 2 heures (trop proche) ` +
    `ou dans plus de 7 jours (trop lointain), afin qu'un combiné soit réellement jouable.`;
  const sys =
    `Tu es un analyste sportif professionnel, rigoureux et méthodique, expert de ${sport}, rattaché à : ${comp}. ` +
    `Tu analyses la réalité du match (forme récente, confrontations directes, absences, contexte, stats clés) ` +
    `indépendamment des cotes des bookmakers. Règles strictes : ` +
    `(1) "confidence" = ta probabilité HONNÊTE réelle pour cette issue précise ; ` +
    `(2) plafond réaliste pour un événement sportif ≈ 88, ne dépasse jamais sauf certitude exceptionnelle ; ` +
    `(3) ne gonfle JAMAIS la confiance pour faire plaisir ; ` +
    `(4) n'invente JAMAIS de statistiques — base-toi uniquement sur des données réelles ; ` +
    `(5) si tu ne peux pas vérifier une donnée, baisse la confiance et signale-le dans "risk" ; ` +
    `(6) QUALITÉ AVANT VOLUME : tu peux renvoyer 0, 1 ou 2 paris. Ne propose QUE des paris dont la confiance honnête atteint au moins ${MINCONF}%. ` +
    `Si aucun match ne mérite ce seuil cette semaine, renvoie "picks":[] et explique dans "note". Ne remplis JAMAIS pour atteindre un quota. Date du jour : ${TODAY}.`;

  // Résultats passés pris en compte (pas de ré-apprentissage statistique : simple relecture critique).
  let learning = "";
  if (Array.isArray(history) && history.length) {
    const lost = history.filter(h => h.result === "perdu");
    learning =
      `\n\nRÉSULTATS PASSÉS à prendre en compte (tes paris précédents sur cette compétition et leur issue réelle) :\n` +
      JSON.stringify(history) +
      `\n\nAvant de proposer tes paris, relis SANS COMPLAISANCE tes paris PERDANTS` +
      (lost.length ? ` (${lost.length} perte(s))` : "") +
      ` : quel type de marché ou quelle erreur t'a coûté ? Sois plus prudent sur ces situations et n'attribue une confiance élevée que si la leçon est respectée.`;
  }

  const schema = `{"picks":[{"match":"Équipe A vs Équipe B","competition":"compétition réelle","date":"JJ/MM HHhMM (fuseau)","confidence":<entier ${MINCONF}-88>,"odds":<cote décimale ex 1.65>,"oddsReal":<true si cote issue de l'API de cotes, sinon false>,"market":"option de pari","form":"forme des 2 camps","rationale":"justification ≤ 25 mots","risk":"principal risque"}],"note":"si 0 pari : explique pourquoi"}`;

  let user;
  if (oddsData && oddsData.events.length) {
    user =
      `Voici de VRAIS matchs et cotes (décimal) récupérés via une API de cotes pour "${oddsData.competition}" :\n` +
      JSON.stringify(oddsData.events) + `\n\n` +
      windowRule + ` ` +
      `Propose 0 à 2 paris (uniquement ceux atteignant honnêtement ${MINCONF}% de confiance) parmi ces matchs. Vérifie forme, absences et contexte via la recherche web. ` +
      `Dans "odds", reprends la cote réelle du marché recommandé et mets "oddsReal":true. ` +
      learning +
      `\nRéponds UNIQUEMENT en JSON valide, sans texte ni markdown. Format exact :\n${schema}`;
  } else {
    user =
      `Recherche sur le web les matchs réels de "${comp}". ` +
      windowRule + ` ` +
      `Propose 0 à 2 paris, UNIQUEMENT ceux atteignant honnêtement ${MINCONF}% de confiance. Si "${comp}" n'offre rien de fiable, tu peux élargir aux divisions inférieures/coupes/ligues voisines — mais NE REMPLIS PAS pour faire du volume : mieux vaut 0 pari qu'un pari faible. ` +
      `Comme les cotes ne viennent pas d'une API ici, mets "oddsReal":false et donne une cote estimée réaliste. ` +
      learning +
      `\nIndique la compétition réelle de chaque pari. Réponds UNIQUEMENT en JSON valide, sans texte ni markdown. Format exact :\n${schema}`;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: sys,
      messages: [{ role: "user", content: user }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a === -1 || b === -1) throw new Error("Réponse IA illisible");
  return JSON.parse(text.slice(a, b + 1));
}

// ---------------------------------------------------------------------
// 3) Handler HTTP
// ---------------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Clé ANTHROPIC_API_KEY manquante dans les variables d'environnement Vercel." });
    return;
  }

  try {
    // Vercel parse déjà le JSON dans req.body ; fallback au cas où.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    const sport = (body && body.sport) || "Football";
    const comp = (body && body.comp) || "";
    const history = (body && body.history) || [];
    const threshold = (body && body.threshold) || 80;
    if (!comp) { res.status(400).json({ error: "Compétition manquante" }); return; }

    const oddsData = await fetchRealOdds(comp, sport);
    const parsed = await analyze(sport, comp, oddsData, history, threshold);

    res.status(200).json({
      picks: parsed.picks || [],
      note: parsed.note || "",
      oddsSource: oddsData ? "live" : "estimée",
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
