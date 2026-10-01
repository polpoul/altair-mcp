# altair-mcp

Serveur MCP pour piloter une instance Altair (axio, nexo, oria...) depuis Claude : lire et écrire
des enregistrements (projets, tâches, contacts...), déclencher les règles métier, et, sur les
instances protégées, gérer le partage des objets avec d'autres utilisateurs.

Le serveur ne contient aucune logique métier : c'est un client HTTP de l'API de l'instance visée.
Les droits, les règles et les données restent côté serveur.

## Vue d'ensemble

```
Claude Code ──stdio──> altair-mcp ──HTTPS + Bearer──> instance (ex. axio.vivalink.top)
                                                        │
                       /assets/schema.json  ◄───────────┤ nginx (statique)
                       /api/data, /api/patch,           │
                       /api/users, /api/owners,         │
                       /api/share, /api/unshare  ◄──────┤ save-server (authentifié, filtre par droits)
                       /records/notify, /records/action ┘   └──> back (règles métier, via RabbitMQ)
                                                        Mercure ◄── publication directe (optionnelle)
```

Un seul métier par instance de ce serveur : `ALTAIR_BASE_URL` fixe l'URL cible. Pour piloter
plusieurs métiers, enregistrer plusieurs instances avec des noms et des URLs différents.

## Installation

Prérequis : Node.js 18 ou plus, Claude Code, et un clone local du dépôt. npm 12 et plus refuse par
défaut les installations depuis GitHub : `npx github:polpoul/altair-mcp` échoue avec `EALLOWGIT`.

```bash
git clone https://github.com/polpoul/altair-mcp.git
cd altair-mcp && npm install
claude mcp add <nom> -s user \
  -e ALTAIR_BASE_URL=https://<metier>.vivalink.top \
  -e ALTAIR_LABEL=<metier> \
  -e ALTAIR_MERCURE_JWT_SECRET=<secret> \
  -e ALTAIR_TOKEN=<jeton> \
  -- node <chemin>/altair-mcp/index.js
```

Vérifier : `claude mcp list` doit afficher `<nom> … ✔ Connected`.

Mettre à jour : `git pull` dans le dossier, puis `/mcp` dans Claude Code, choisir le serveur et le
reconnecter (ou relancer Claude Code). Il n'y a rien à réenregistrer tant que le chemin ne change pas.

Changer la configuration (jeton, secret) : `claude mcp remove <nom> -s user`, puis refaire
`claude mcp add` avec les nouvelles valeurs.

## Configuration

| Variable | Obligatoire | Rôle |
|---|---|---|
| `ALTAIR_BASE_URL` | oui | URL de l'instance à piloter, ex. `https://axio.vivalink.top` |
| `ALTAIR_LABEL` | non | Nom affiché dans les descriptions d'outils (défaut : nom d'hôte de l'URL) |
| `ALTAIR_TOKEN` | pour une instance protégée (axio) | `device_token` de l'auth-service, envoyé en `Authorization: Bearer` |
| `ALTAIR_MERCURE_JWT_SECRET` | non | Active la publication directe sur Mercure après chaque écriture |
| `ALTAIR_MERCURE_URL` | non | URL du hub Mercure (défaut : `<ALTAIR_BASE_URL>/.well-known/mercure`) |

Sans `ALTAIR_TOKEN`, le serveur garde le comportement historique des instances sans connexion
(nexo, oria) : lecture de `/assets/data.json`, écriture du fichier entier par `/api/save`, et pas
d'outils de partage.

Sans `ALTAIR_MERCURE_JWT_SECRET`, les écritures fonctionnent mais le front ouvert dans un navigateur
ne se rafraîchit pas en direct. La suppression en dépend : le back n'a pas d'événement de
suppression, donc sans Mercure la fiche supprimée reste affichée jusqu'au rechargement.

### Obtenir un jeton dédié

Le jeton est le `device_token` d'une session ouverte sur l'instance. Utiliser un jeton **dédié** au
MCP, pour pouvoir le révoquer sans fermer sa propre session :

1. Ouvrir l'instance dans une fenêtre de navigation privée et se connecter par le lien magique.
2. Ouvrir la console du navigateur (F12) et exécuter `copy(localStorage.getItem('device_token'))`.
   La console affiche `undefined` : c'est normal, le jeton est dans le presse-papier.
3. Le coller dans la commande `claude mcp add`, directement dans le terminal.
4. Fermer la fenêtre privée **sans cliquer sur « Se déconnecter »** : ce bouton révoque le jeton.

Pour révoquer ce jeton plus tard : `POST https://auth.vivalink.top/auth/logout` avec cet `Authorization: Bearer`.

Le compte du jeton doit être **super-utilisateur** de l'instance (`acl-rules.json`) pour que le MCP
voie tout. Les objets créés par le MCP appartiennent à ce compte.

## Outils

Valeurs de champs : toujours des chaînes (nombres, dates et cases à cocher sont stockés en texte,
voir `list_types`). Les champs « à chemin » (ex. `projetId.nom`) sont en lecture seule et refusés.

| Outil | Rôle | Paramètres |
|---|---|---|
| `list_types` | Types d'objets du schéma, avec champs et relations. À appeler en premier. | — |
| `list_records` | Enregistrements d'un type, filtre d'égalité exacte optionnel | `typeId`, `filters?` |
| `get_record` | Un enregistrement | `typeId`, `id` |
| `create_record` | Crée un enregistrement (id `<typeId>-<horodatage>`, champs absents à `''`) | `typeId`, `fields` |
| `update_record` | Modifie un ou plusieurs champs | `typeId`, `id`, `fields` |
| `delete_record` | Supprime un enregistrement | `typeId`, `id` |
| `trigger_action` | Déclenche une action métier déclarée dans le schéma | `typeId`, `id`, `actionId`, `params?` |

Avec `ALTAIR_TOKEN`, quatre outils de partage s'ajoutent :

| Outil | Rôle | Paramètres |
|---|---|---|
| `list_users` | Utilisateurs inscrits avec qui partager (sans soi-même) | — |
| `list_owners` | Qui a accès à un enregistrement : propriétaires directs, et accès hérités (`inherited: true`) | `id` |
| `share_record` | Donne accès à des enregistrements à un utilisateur déjà inscrit | `ids`, `user` (id ou email) |
| `unshare_record` | Retire un utilisateur des propriétaires directs | `ids`, `user` (id ou email) |

Comportements à connaître :

- **Règles métier.** Après une création ou une modification, le MCP notifie le back
  (`/records/notify`) : les règles s'exécutent de façon asynchrone dans un worker. Leur effet (ex. un
  titre mis en majuscules, l'avancement d'un projet recalculé) n'apparaît pas dans la réponse de
  l'outil mais à la lecture suivante.
- **Suppression.** Aucune règle ne se déclenche : les compteurs qui en dépendent (ex. l'avancement
  d'un projet) ne sont pas recalculés. Les recalculer avec `update_record` si besoin.
- **Écriture.** Sur une instance protégée, seuls les champs modifiés sont envoyés
  (`/api/patch`) : les autres champs et les objets invisibles pour le compte ne sont jamais écrasés.
  Le lot est refusé en entier si un seul objet est interdit.
- **Inscription d'un utilisateur.** Volontairement absente du MCP : c'est une opération
  d'administrateur (`server/add-user.js`, dépôt `altair-ux-maquette`).

## Droits et partage

Le modèle, appliqué par le serveur de l'instance (`altair-ux-maquette`, dossier `server/`) :

- Chaque objet a une liste de propriétaires (`acl.json`). Tous les propriétaires ont le même
  droit : lire, modifier, partager, supprimer. Il n'y a pas de lecture seule.
- **Héritage** : un objet est aussi accessible aux propriétaires de ses parents (une tâche à ceux
  de son projet, une note ou une interaction à ceux de son projet ou de sa tâche). Partager un projet
  partage donc tout son contenu.
- Un **super-utilisateur** voit et modifie tout, y compris les objets sans propriétaire.
- `unshare_record` ne retire que les propriétaires directs. Un accès hérité se retire sur
  l'objet parent : la réponse indique dans `stillAccess` les objets encore visibles par héritage.
  Il est refusé si un objet se retrouverait sans aucun propriétaire.

## API utilisée

| Appel | Usage |
|---|---|
| `GET /assets/schema.json` | `list_types`, validation des champs (statique, sans jeton) |
| `GET /api/data` | Lecture, filtrée par les droits du jeton (sans jeton : `GET /assets/data.json`) |
| `POST /api/patch` | Création, modification, suppression (sans jeton : `POST /api/save`) |
| `POST /records/notify`, `POST /records/action` | Règles métier et actions |
| `GET /api/users`, `POST /api/owners`, `POST /api/share`, `POST /api/unshare` | Partage |
| `POST <hub Mercure>` | Rafraîchissement en direct du front (si `ALTAIR_MERCURE_JWT_SECRET`) |

## Sécurité

- Le serveur n'ajoute ni ne retire aucune barrière : il agit avec les droits du jeton fourni. Un
  jeton de super-utilisateur permet à Claude de tout lire, modifier, supprimer et partager.
- Le jeton et le secret Mercure sont des secrets : ne pas les commiter, ne pas les coller dans une
  conversation. Ils restent dans l'historique du terminal où `claude mcp add` a été lancé.
- Pour couper l'accès : révoquer le jeton (voir plus haut) ou `claude mcp remove <nom> -s user`.

## Dépannage

| Symptôme | Cause probable | Remède |
|---|---|---|
| `claude mcp list` : `Failed to connect — CONNECTION_CLOSED` | Le processus s'arrête au démarrage : `npx github:` refusé par npm (`EALLOWGIT`), `ALTAIR_BASE_URL` manquant ou chemin faux | Installer depuis un clone local et vérifier la commande (voir Installation). Lancer `node index.js` à la main avec les variables pour lire l'erreur. |
| `GET /assets/data.json -> 404` | Instance protégée appelée sans jeton | Ajouter `ALTAIR_TOKEN` |
| `401` | Jeton invalide ou révoqué | Générer un nouveau jeton et réenregistrer le MCP |
| `403 Utilisateur non autorisé` | Le compte du jeton n'est pas inscrit dans l'annuaire de l'instance | L'inscrire (`server/add-user.js`) |
| `503 Authentification indisponible` | L'auth-service est injoignable | Vérifier le conteneur `auth-service` |
| `500` sur `/api/data` | Fichier de droits illisible (`acl.json` ou `users.json` : JSON invalide, souvent après une édition manuelle) | `python3 -m json.tool /data/axio/acl.json` sur le serveur pour trouver la ligne, puis corriger |
| Les outils de partage n'apparaissent pas | Pas de `ALTAIR_TOKEN`, ou processus MCP lancé avant la mise à jour du code | Vérifier le jeton, puis `/mcp` pour reconnecter le serveur |
| `404` sur `/api/unshare`, `/api/share`... | Serveur de l'instance pas à jour | Reconstruire l'image du save-server et recréer son conteneur |
| Un titre n'est pas en majuscules juste après `create_record` | La règle s'exécute après la création | Relire l'enregistrement quelques secondes plus tard |

## Tests

Deux scripts de vérification, qui ciblent l'instance **réelle** (`https://axio.vivalink.top`) et lisent
`ALTAIR_TOKEN` dans l'environnement :

```bash
set ALTAIR_TOKEN=<jeton>      # Windows cmd ; export ALTAIR_TOKEN=... sous bash
node smoke-test.mjs           # lecture seule : types et enregistrements
node smoke-test-write.mjs     # écriture : crée, modifie puis supprime un contact « MCP-smoketest »
```
