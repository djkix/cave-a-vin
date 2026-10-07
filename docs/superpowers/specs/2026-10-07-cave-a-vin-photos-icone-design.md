# Cave & Terroir — Design : photos plus nettes, image trouvée sur le web, icône

2026-10-07 · Franck Laval

## Contexte

Franck veut des vignettes de meilleure qualité, voire une étiquette « officielle ».
Arbitrages : **amélioration automatique** des photos (option 1) et **recherche
d'image à la demande** (option 3) via **Open Food Facts** puis, à défaut, **le site
officiel du domaine retrouvé par Gemini** (recherche Google intégrée : 5 000
recherches gratuites par mois pour les modèles Gemini 3, puis 14 $ les 1 000 —
usage manuel, donc gratuit en pratique). Pas de Brave, pas de Google Custom Search
(fermé aux nouveaux clients, arrêt le 1er janvier 2027). L'icône de l'application
(un verre de vin crème sur fond bordeaux) est déjà faite sur la branche.

## 1. Amélioration automatique des photos

- **Cadre de l'étiquette** : les consignes de lecture (unitaire et par lot)
  demandent en plus `"etiquette": [ymin, xmin, ymax, xmax]`, coordonnées
  normalisées de 0 à 1000 (convention Gemini), ou `null` si l'étiquette n'est pas
  repérable. Champ **facultatif** dans le schéma : les lectures existantes restent
  valides.
- **Version d'affichage** d'une photo, fabriquée par le serveur à la première
  demande puis gardée sur le disque (`normalized/<id>.display-v2.jpg` ; le nom
  est versionné : changer le traitement fait refabriquer les versions gardées,
  l'ancien `<id>.display.jpg` est ignoré puis effacé avec la photo) :
  1. recadrage sur l'étiquette avec une marge de 8 % de chaque côté, **seulement**
     si le cadre est plausible (aire entre 5 % et 95 % de l'image, coordonnées
     cohérentes) ;
  2. balance des blancs « monde gris » **adoucie** : la moitié seulement de la
     correction qui ramènerait la moyenne de chaque canal à la moyenne des trois,
     facteurs bornés entre 0,95 et 1,05 (une étiquette crème ou dorée n'est pas
     une dominante à corriger) ;
  3. contraste léger et linéaire, centré sur les tons moyens (y = 1,08 x − 10),
     **pas** d'étirement `normalise` (qui poussait un fond uni vers le noir) ;
     netteté modérée (`sharpen` sigma 1) ;
  4. au plus 1200 px de côté, JPEG qualité 85.
- La version d'affichage n'est fabriquée que pour une photo lue (`DONE`) ou en
  échec (`FAILED`) ; une photo en attente renvoie l'image d'origine (pas de cache).
- `GET /api/photos/:id/image?variant=display` ; sans paramètre, l'image d'origine
  (inchangé). Gemini lit toujours l'image d'origine.
- Affichage : vignettes (cave, fiche, sortie), « À confirmer », écran de
  confirmation et de sortie utilisent `variant=display`.
- Échec de fabrication (fichier illisible…) : l'image d'origine est renvoyée,
  l'erreur est journalisée.

## 2. « Chercher une image » (à la demande)

- Bouton (style lien) sur la fiche vin, sous l'en-tête (vignette + titre). Ouvre
  une fenêtre de choix **sur toute la largeur de la carte**, sous l'en-tête et non
  dans la colonne de la vignette : images en grille (2 colonnes à 375 px, image
  entière `object-fit: contain`), lien vers la source sous chaque image, puis
  « Choisir cette image » sur toute la largeur de la colonne. Les liens ont le
  style de l'application (couleur du texte, soulignés), jamais le bleu du
  navigateur.
- Au plus **10 recherches par minute** (limite de débit de la route) : au-delà,
  429 « Trop de recherches, réessayez dans une minute ».
- **Recherche** (`POST /api/wines/:id/image-search`) :
  1. **Open Food Facts** : recherche texte sur « producteur cuvée appellation »,
     d'abord sur le service de recherche `search.openfoodfacts.org/search?q=…`
     (réponse `{ hits }`, stable), puis **une fois en secours** sur l'ancienne
     recherche `world.openfoodfacts.org/cgi/search.pl?search_terms=…&json=1`
     (souvent en 503) ; toute panne des deux vaut « rien trouvé ». Produits de la
     catégorie vins (`categories_tags` contient `en:wines`) **qui nomment le
     producteur** : chaque mot significatif du producteur (au moins 4 lettres,
     hors « domaine », « château », « maison », « clos », « cave », « vins ») dans
     le nom ou la marque, ou, sans mot significatif, le nom complet (la recherche
     d'Open Food Facts est floue et ramènerait l'image d'un autre vin). Ceux qui
     portent aussi l'appellation ou le millésime passent devant ; au plus 5 images
     de face (`image_front_url`). En-tête `User-Agent: CaveEtTerroir
     (+https://github.com/djkix/cave-a-vin)`, sans numéro de version (le
     `package.json` de l'api reste à 0.0.0). Source affichée : « Open Food Facts
     (CC BY-SA) » + lien vers la fiche produit.
  2. Si Open Food Facts ne donne rien : **Gemini avec la recherche Google**
     (`tools: [{ googleSearch: {} }]`) trouve l'URL du site officiel du domaine
     (réponse JSON `{ "site": url | null }`) ; le serveur lit la page (HTML,
     2 Mo max) et en tire au plus 5 images : `og:image`, `twitter:image`, puis les
     `<img>` dont l'attribut `alt` ou le nom de fichier contient un mot de la
     cuvée ou du domaine. Source affichée : nom de domaine du site + lien.
  - Chaque candidate est **téléchargée par le serveur**, une à la fois (5 Mo max,
    types image jpeg/png/webp, 25 millions de pixels max, **4 s max**),
    redimensionnée (1200 px max, JPEG), gardée 1 h dans
    `data/photos/candidates/`, et renvoyée sous la forme `{ id, source, sourceUrl,
    imageUrl: /api/image-candidates/:id }`. Une candidate est **liée au vin**
    cherché : la choisir pour un autre vin vaut « expirée » (410). Les candidates
    périmées sont effacées au démarrage de l'api et à chaque recherche.
  - **Délai global de 30 s** pour toute la recherche (Open Food Facts, Gemini,
    page du site, téléchargements) : un seul signal d'abandon est transmis à
    chaque téléchargement et à Gemini ; Open Food Facts et la page du site ont
    8 s au plus, jamais au-delà du temps restant. Délai écoulé : les images déjà
    prêtes sont rendues ; sans aucune image prête, 503 « Recherche d'image
    indisponible pour le moment ».
  - **Sécurité des téléchargements** : http(s) seulement, résolution DNS
    vérifiée (refus des adresses privées, de bouclage, link-local, réservées, de
    documentation et multicast, en IPv4 comme en IPv6, IPv4 embarquée comprise),
    connexion épinglée sur l'adresse vérifiée, redirections suivies au plus 3 fois
    avec la même vérification.
  - Coût Gemini compté dans le plafond mensuel, dans la part de 80 % des accords
    (`assertUnderShare`) : un appel ancré compte **au moins 1 ct**, et le plus
    élevé de son coût en jetons (jetons des résultats de recherche compris) et de
    1,4 ct par requête de recherche lancée (`groundingMetadata.webSearchQueries`),
    majoré. Aucune image trouvée : « Aucune image trouvée pour ce vin ».
- **Choix** (`POST /api/wines/:id/reference-image { candidateId }`) : la candidate
  devient une photo `purpose = REFERENCE` et la vignette du vin ; l'ancienne
  vignette est mémorisée (`wine.reference_photo_previous_id`), la source est
  gardée (`wine.reference_photo_source`, `wine.reference_photo_source_url`).
- **Revenir à ma photo** (`DELETE /api/wines/:id/reference-image`) : rétablit la
  vignette précédente, efface la source ; sans vignette précédente, reprend la
  photo d'entrée la plus récente de ce vin (s'il y en a une).
- Fiche vin : sous l'en-tête, sur toute la largeur, « Image : {source} » (lien)
  et « Revenir à ma photo » quand la vignette vient du web. Une photo `REFERENCE`
  n'apparaît jamais dans « À confirmer » ni dans les analyses, et ne peut pas
  servir à une entrée ou une sortie (400 « Photo invalide pour une entrée » /
  « … pour une sortie »).

## 3. Icône

Déjà faite : `web/public/icons/icon.svg`, favicon, PNG 192/512, variante
« maskable », icône iOS 180 ; README avec l'icône en tête.

## Données

Migration : valeur `REFERENCE` ajoutée à `PhotoPurpose` ; colonnes
`wine.reference_photo_previous_id TEXT`, `wine.reference_photo_source TEXT`,
`wine.reference_photo_source_url TEXT`.

## Erreurs

| Situation | Comportement |
| --- | --- |
| Open Food Facts ou le site injoignable | Passe à l'étape suivante ; si rien : « Aucune image trouvée pour ce vin » |
| Gemini indisponible / plafond | « Recherche d'image indisponible pour le moment » (503) |
| Délai global de 30 s écoulé | Images déjà prêtes rendues ; aucune : 503 « Recherche d'image indisponible pour le moment » |
| 502 / 504 (proxy devant l'api) | Affichés « Recherche d'image indisponible pour le moment » |
| Plus de 10 recherches par minute | 429 « Trop de recherches, réessayez dans une minute » |
| Choix en échec (hors expiration) | Erreur affichée à côté des images, qui restent proposées |
| Candidate expirée (plus d'1 h) | 410 « Proposition expirée, relancez la recherche » |
| Vin inconnu | 404 « Vin introuvable » |

## Tests

Cadre (schéma facultatif, plausibilité, marge, bornes), balance des blancs
(facteurs bornés), variante d'affichage (photo en attente → original, cache,
repli), Open Food Facts (filtre vins, 5 max, User-Agent, erreur réseau), site
officiel (réponse Gemini, extraction des images d'une page HTML d'exemple),
téléchargement (refus des adresses privées, taille, type, redirections),
candidates (expiration), choix et retour, `REFERENCE` exclu de « À confirmer »,
écrans (bouton, fenêtre de choix, sources, revenir à ma photo, vignettes en
`variant=display`), essai navigateur 375 px.

## Livraison

Une migration ; aucune nouvelle variable d'environnement ; version 1.9.0 (avec
l'icône) ; README et CHANGELOG en français.
