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
  demande puis gardée sur le disque (`normalized/<id>.display.jpg`) :
  1. recadrage sur l'étiquette avec une marge de 8 % de chaque côté, **seulement**
     si le cadre est plausible (aire entre 5 % et 95 % de l'image, coordonnées
     cohérentes) ;
  2. balance des blancs « monde gris » : chaque canal multiplié pour ramener sa
     moyenne à la moyenne des trois, facteurs bornés entre 0,8 et 1,25 ;
  3. étirement du contraste (`normalise`), netteté modérée (`sharpen` sigma 1) ;
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

- Bouton sur la fiche vin, sous la vignette. Ouvre une fenêtre de choix.
- **Recherche** (`POST /api/wines/:id/image-search`) :
  1. **Open Food Facts** : recherche texte (`/cgi/search.pl?search_terms=…&json=1`)
     sur « producteur cuvée appellation », produits de la catégorie vins
     (`categories_tags` contient `en:wines`), au plus 5 images de face
     (`image_front_url`), en-tête `User-Agent: CaveEtTerroir/<version>
     (+https://github.com/djkix/cave-a-vin)`. Source affichée : « Open Food
     Facts (CC BY-SA) » + lien vers la fiche produit.
  2. Si Open Food Facts ne donne rien : **Gemini avec la recherche Google**
     (`tools: [{ googleSearch: {} }]`) trouve l'URL du site officiel du domaine
     (réponse JSON `{ "site": url | null }`) ; le serveur lit la page (HTML,
     2 Mo max) et en tire au plus 5 images : `og:image`, `twitter:image`, puis les
     `<img>` dont l'attribut `alt` ou le nom de fichier contient un mot de la
     cuvée ou du domaine. Source affichée : nom de domaine du site + lien.
  - Chaque candidate est **téléchargée par le serveur** (5 Mo max, types image
    jpeg/png/webp, 8 s max), redimensionnée (1200 px max, JPEG), gardée 1 h dans
    `data/photos/candidates/`, et renvoyée sous la forme `{ id, source, sourceUrl,
    imageUrl: /api/image-candidates/:id }`.
  - **Sécurité des téléchargements** : http(s) seulement, résolution DNS
    vérifiée (refus des adresses privées, de bouclage et link-local), redirections
    suivies au plus 3 fois avec la même vérification.
  - Coût Gemini compté dans le plafond mensuel, dans la part de 80 % des accords
    (`assertUnderShare`). Aucune image trouvée : « Aucune image trouvée pour ce
    vin ».
- **Choix** (`POST /api/wines/:id/reference-image { candidateId }`) : la candidate
  devient une photo `purpose = REFERENCE` et la vignette du vin ; l'ancienne
  vignette est mémorisée (`wine.reference_photo_previous_id`), la source est
  gardée (`wine.reference_photo_source`, `wine.reference_photo_source_url`).
- **Revenir à ma photo** (`DELETE /api/wines/:id/reference-image`) : rétablit la
  vignette précédente, efface la source.
- Fiche vin : sous la vignette, « Image : {source} » (lien) quand la vignette
  vient du web. Une photo `REFERENCE` n'apparaît jamais dans « À confirmer » ni
  dans les analyses.

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
