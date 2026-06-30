# Cellule d'Analyse — déploiement sur Vercel

Application multi-experts d'analyse de paris sportifs. Les clés API restent secrètes
côté serveur (fonction Vercel). Les cotes réelles viennent de The Odds API, avec repli
automatique sur la recherche web si une compétition n'est pas couverte.

## Contenu du projet

```
cellule-vercel/
├── index.html        ← la page (front-end)
├── api/
│   └── analyze.js    ← le serveur sécurisé (garde les clés, va chercher les cotes)
├── vercel.json       ← autorise jusqu'à 60 s par analyse
├── package.json
└── .env.example      ← modèle des clés à renseigner
```

## Ce qu'il te faut avant de commencer

1. **Une clé API Anthropic** — crée un compte sur https://console.anthropic.com,
   ajoute un peu de crédit (l'API est facturée à l'usage, séparément de l'abonnement
   Claude.ai), puis génère une clé `sk-ant-...`.
2. **(Optionnel) Une clé The Odds API** — inscription gratuite sur
   https://the-odds-api.com (500 requêtes/mois offertes). Sans elle, l'appli marche
   quand même avec des cotes estimées.
3. **Un compte Vercel** gratuit — https://vercel.com (connecte-toi avec GitHub).

## Déploiement — la voie la plus simple (sans ligne de commande)

1. Crée un dépôt GitHub et envoie-y le contenu du dossier `cellule-vercel/`.
   (Sur github.com : « Add file → Upload files », glisse les fichiers, « Commit ».)
2. Sur Vercel : **Add New… → Project → Import** ton dépôt. Laisse les réglages par
   défaut (Framework Preset : « Other »). Clique **Deploy**.
3. Une fois déployé, va dans **Settings → Environment Variables** et ajoute :
   - `ANTHROPIC_API_KEY` = ta clé `sk-ant-...`
   - `ODDS_API_KEY` = ta clé The Odds API (ou laisse vide)
   - `MODEL` = `claude-sonnet-4-6` (facultatif)
4. Onglet **Deployments → … → Redeploy** pour que les clés soient prises en compte.
5. Ouvre l'URL fournie (`ton-projet.vercel.app`), clique **Lancer l'analyse**. ✅

### Variante en ligne de commande

```bash
npm i -g vercel
cd cellule-vercel
vercel            # premier déploiement
vercel env add ANTHROPIC_API_KEY
vercel env add ODDS_API_KEY        # optionnel
vercel --prod     # mise en production
```

## Comment ça marche

- La page appelle `/api/analyze` une fois par expert (compétition).
- Le serveur : (1) tente de récupérer de vraies cotes via The Odds API, (2) lance
  l'analyse IA avec recherche web, (3) renvoie 2 paris honnêtes + la source des cotes.
- Chaque carte indique « cotes réelles ✓ » ou « cotes estimées » selon ce qui a été trouvé.

## Coûts à surveiller

- **Anthropic** : chaque analyse consomme des tokens + des recherches web (quelques
  centimes par expert). Surveille l'usage dans la console.
- **The Odds API** : chaque appel compte dans ton quota gratuit (500/mois). Le serveur
  fait 2 appels par expert max (liste des sports + cotes).
- **Vercel** : le tier gratuit (Hobby) suffit largement pour un usage personnel.

## Note

Analyses fournies à titre informatif — aucun gain garanti. Les paris comportent un
risque financier réel. Joueurs Info Service : 09 74 75 13 13 (France).
