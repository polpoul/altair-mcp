# altair-mcp

Serveur MCP générique pour piloter une instance Altair (axio, nexo, oria...) — lire et
écrire des enregistrements (projets, tâches, contacts...) via l'API HTTP déjà exposée par
l'instance elle-même, avec rafraîchissement en direct côté front via Mercure.

Un seul métier par instance de ce serveur : `ALTAIR_BASE_URL` fixe l'URL cible. Pour
piloter plusieurs métiers, enregistrer plusieurs instances de ce serveur avec des noms/URLs
différents.

## Outils exposés

- `list_types` — liste les types d'objets déclarés dans le schéma
- `list_records` — liste les enregistrements d'un type, avec filtre optionnel
- `get_record` — lit un enregistrement précis
- `create_record` — crée un enregistrement
- `update_record` — modifie un ou plusieurs champs
- `delete_record` — supprime un enregistrement
- `trigger_action` — déclenche une action métier déclarée dans le schéma

## Installation

Aucun clonage ni `npm install` manuel — `npx` s'en charge :

```bash
claude mcp add <nom> -s user \
  -e ALTAIR_BASE_URL=https://<metier>.vivalink.top \
  -e ALTAIR_LABEL=<metier> \
  -e ALTAIR_MERCURE_JWT_SECRET=<secret> \
  -- npx github:polpoul/altair-mcp
```

- `ALTAIR_BASE_URL` (obligatoire) : URL de l'instance à piloter.
- `ALTAIR_LABEL` (optionnel) : nom affiché dans les descriptions d'outils, défaut = nom d'hôte de l'URL.
- `ALTAIR_TOKEN` (obligatoire pour une instance protégée, axio) : `device_token` d'un utilisateur de
  l'auth-service, envoyé en `Authorization: Bearer`. Utiliser un jeton **dédié** (connexion depuis
  un autre navigateur ou profil) pour pouvoir le révoquer sans fermer sa propre session ; le
  compte doit être super-utilisateur (`acl-rules.json` de l'instance) pour tout voir, et les
  objets créés lui appartiennent. Sans jeton, le serveur lit `/assets/data.json` et écrit via
  `/api/save` comme avant (instances sans connexion : nexo, oria).
- `ALTAIR_MERCURE_JWT_SECRET` (optionnel) : active la publication directe sur Mercure après
  chaque écriture, pour un rafraîchissement en direct côté front sans recharger la page
  (nécessaire notamment pour `delete_record`, le back n'ayant pas d'événement de suppression
  natif). Sans ce secret, les écritures fonctionnent quand même, juste sans rafraîchissement
  instantané.

## Sécurité

Ce serveur ne fait qu'appeler l'API exposée par l'instance visée (`/api/data`, `/api/patch`,
`/records/notify`, `/records/action`, ou `/api/save` sans connexion) avec les droits du jeton
fourni : il n'ajoute ni ne retire aucune barrière. Le jeton est un secret : ne le commite pas,
ne le colle pas dans une conversation.
