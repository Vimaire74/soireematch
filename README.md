# Soirée Match — site + inscriptions (déploiement Coolify)

Un seul petit serveur Node sert **tout** : le site public, le formulaire d'inscription,
la base SQLite et la page d'administration `/admin`. Aucune dépendance à installer.
Déploiement **comme le jeu** : fichiers sur GitHub → nouvelle ressource dans Coolify.

## À faire dans Coolify (résumé)

1. **GitHub** : mettre ces fichiers dans un dépôt (Add file → Upload files → Commit).
   Ne pas envoyer `config.json` ni le dossier `data/` (ce sont tes secrets et ta base).
2. **Coolify** : nouvelle ressource → build pack **Dockerfile** → dépôt GitHub → domaine `soireematch.com`, port **8090**.
3. **Variables d'environnement** (onglet de la ressource) :
   - `ADMIN_USER` = ton identifiant admin
   - `ADMIN_PASS` = ton mot de passe admin
   - `SESSION_SECRET` = une longue chaîne au hasard
   - `REPORT_TOKEN` = une autre longue chaîne au hasard
4. **Persistent Storage** : monter un volume sur **`/app/data`** (sinon un redéploiement efface les inscriptions).
5. **Deploy**. Coolify met en HTTPS tout seul.

La marche à suivre détaillée clic par clic est donnée dans la conversation.

## La page /admin
Liste des inscrits, filtres (genre / recherche), sélection par cases à cocher,
export CSV (pour mailings), suppression, et statistiques. Accès par `ADMIN_USER` / `ADMIN_PASS`.

## Fichiers
- `server.js` — le serveur (ne pas modifier).
- `public/index.html` — le site (formulaire natif inclus).
- `Dockerfile` / `.dockerignore` — pour Coolify.
- `config.example.json` — utile seulement pour un test local (Coolify utilise les variables d'environnement).
- `data/` — créé automatiquement : ta base SQLite. À garder sur un volume persistant.
