# Cave & Terroir — Design Lot 2b : l'apogée

2026-10-04 · Franck Laval

## Contexte

Cahier des charges source : [`cahier-des-charges.md`](../../../cahier-des-charges.md),
section « Apogée et données œnologiques ». Ce document ne le répète pas ; il
fixe le **périmètre du lot 2b** et les **décisions prises** en conception.

Le lot 2 est découpé en trois sous-projets : 2a (la cave et la sortie, livré en
1.2.0), **2b (ce document)**, 2c (cote iDealwine, précédée d'une étude de
faisabilité).

## Intention

Savoir **quand** boire chaque bouteille. L'apogée n'est presque jamais sur
l'étiquette : c'est une donnée dérivée, estimée par règles, affichée en
**fourchette** avec un **niveau de confiance**, jamais en année unique. Dès que
l'utilisateur corrige une fourchette, sa valeur prime définitivement sur la
règle. La vue « à boire cette année » et les alertes relèvent du lot 3.

## Décisions prises

| Question | Décision | Conséquence |
| --- | --- | --- |
| Source de la qualité des millésimes | **« Moyen » par défaut, qualifiable dans l'application** | Aucune donnée inventée ; un millésime non qualifié vaut 1,0 et abaisse la confiance |
| Garde selon la couleur | **Garde de l'appellation, rosé plafonné à 1-3 ans, ajustable dans l'application** (par appellation, ou par appellation et couleur) | Les ajustements vivent dans une table séparée, que le rechargement du référentiel n'écrase pas |
| Droits | **Règles (millésimes, gardes) : administrateurs ; correction de l'apogée d'un vin : tout compte actif** | Les règles changent toute la cave ; la correction d'un vin est un geste courant |
| Où vit la fourchette | **Calculée à la lecture** par une fonction pure ; seule la correction manuelle est stockée | Effet immédiat de toute règle, rien à recalculer, rien ne peut devenir obsolète |

## Règle de calcul

Fonction pure `estimateApogee(input, currentYear)` dans `api/src/apogee/`,
testable sans base, utilisée par la liste de la cave, la fiche vin et l'export.

### Fourchette

```
apogée = [ round(millésime + garde_min × f) ; round(millésime + garde_max × f) ]
```

`round` est l'arrondi à l'entier le plus proche (`Math.round`).

### Garde retenue (première règle applicable)

1. ajustement **appellation + couleur** du vin (table `guard_override`, couleur renseignée) ;
2. si le vin est un **rosé** : 1 à 3 ans ;
3. ajustement **appellation, toutes couleurs** (table `guard_override`, couleur vide) ;
4. garde du **référentiel** (`appellation.guard_min_years` / `guard_max_years`).

### Facteur de millésime f

Selon la qualité du couple (région de l'appellation, millésime) dans la table
`vintage_quality` : **GRAND → 1,2**, **MOYEN → 1,0**, **FAIBLE → 0,85**. Un
millésime absent de la table est **non qualifié** et vaut 1,0. Une appellation
sans région ne peut pas être qualifiée : f = 1,0, millésime non qualifié.

### Correction manuelle

Si le vin porte `apogee_source = 'MANUEL'`, la fourchette est `[apogee_min ;
apogee_max]` du vin, quelles que soient les règles, y compris pour un vin non
millésimé ou d'appellation non reconnue.

### Confiance

| Confiance | Quand |
| --- | --- |
| `SAISIE` | correction manuelle |
| `MOYENNE` | règle appliquée, millésime qualifié |
| `FAIBLE` | règle appliquée, millésime non qualifié |

### Absence d'estimation

Pas de fourchette (et `reason` renseignée) quand il n'y a pas de correction
manuelle et :

| `reason` | Cas | Message affiché |
| --- | --- | --- |
| `NON_MILLESIME` | `vintage` vide | « Vin non millésimé : saisis la fourchette si tu la connais » |
| `APPELLATION_INCONNUE` | `appellation_id` vide | « Appellation non reconnue par le référentiel : saisis la fourchette » |
| `GARDE_INCONNUE` | aucune garde applicable | « Garde inconnue pour cette appellation : saisis la fourchette » |

### Statut (selon l'année en cours `a`)

| Statut | Condition | Libellé |
| --- | --- | --- |
| `TROP_JEUNE` | `a < min` | « Trop jeune — à partir de {min} » |
| `A_BOIRE` | `min ≤ a < max` | « À boire — jusqu'en {max} » |
| `A_BOIRE_VITE` | `a = max` | « À boire vite — {max} est la dernière année » |
| `PASSEE` | `a > max` | « Apogée passée depuis {max} » |

### Exemples de référence (tests)

| Vin | Règles | Résultat |
| --- | --- | --- |
| Châteauneuf-du-Pape 2016, rouge, garde 8-20, Rhône 2016 non qualifié | — | 2024-2036, `FAIBLE` |
| idem, Rhône 2016 qualifié GRAND | f = 1,2 | 2026-2040, `MOYENNE` |
| idem, Rhône 2016 qualifié FAIBLE | f = 0,85 | 2023-2033, `MOYENNE` |
| Rosé de Provence 2023, garde référentiel 1-3 | — | 2024-2026 |
| Alsace 2020 rosé, garde référentiel 1-8 | rosé | 2021-2023 (et non 2021-2028) |
| Alsace 2020 rosé, ajustement Alsace/ROSE 2-4 | priorité 1 | 2022-2024 |
| Meursault 2019 blanc, ajustement Meursault toutes couleurs 4-12 | priorité 3 | 2023-2031 |
| Vin non millésimé | — | aucune, `NON_MILLESIME` |
| Correction manuelle 2030-2035 sur le Châteauneuf | — | 2030-2035, `SAISIE` |

## Données

### Nouvelles tables

- `vintage_quality` : `region` (texte), `year` (entier), `quality`
  (`GRAND` | `MOYEN` | `FAIBLE`), `updated_at`. Clé primaire (`region`, `year`).
  « MOYEN » peut être enregistré explicitement : il qualifie le millésime
  (confiance `MOYENNE`) sans changer le facteur.
- `guard_override` : `id`, `appellation_id` (référence `appellation`),
  `color` (`WineColor`, facultatif), `guard_min_years`, `guard_max_years`,
  `updated_at`. Unicité : un seul ajustement par appellation sans couleur, un
  seul par (appellation, couleur) — deux index uniques partiels écrits à la
  main dans la migration.

**Pourquoi une table séparée :** le service des appellations recharge le
référentiel (`api/data/appellations.json`) à chaque démarrage de l'api et
réécrit les gardes. Un ajustement porté par la ligne `appellation` serait
écrasé au déploiement suivant.

### Colonnes existantes du vin

`apogee_min`, `apogee_max`, `apogee_source` existent déjà. Ils ne portent que
la correction manuelle (`apogee_source = 'MANUEL'`) ; vides sinon.

## API

| Méthode et route | Droits | Entrée | Réponse |
| --- | --- | --- | --- |
| `GET /cave`, `GET /wines/:id` | session | — | chaque vin porte `apogee: { min, max, confidence, status, reason, source }` (`source` : `MANUEL` ou `REGLE`, `null` sans estimation) |
| `PUT /wines/:id/apogee` | session | `{ min, max }` | `apogee` recalculé ; `400` si invalide |
| `DELETE /wines/:id/apogee` | session | — | `apogee` recalculé par la règle |
| `GET /admin/vintages` | admin | — | `{ regions: string[], qualities: [{ region, year, quality }] }` |
| `PUT /admin/vintages` | admin | `{ region, year, quality }` | ligne enregistrée |
| `DELETE /admin/vintages/:region/:year` | admin | — | `204` (retour à « non qualifié ») |
| `GET /admin/guards?q=` | admin | — | appellations correspondantes avec garde du référentiel et ajustements |
| `PUT /admin/guards` | admin | `{ appellationId, color?, min, max }` | ajustement enregistré |
| `DELETE /admin/guards/:id` | admin | — | `204` |

Validations (messages en français) :
- correction de vin : `min` et `max` entiers de 1900 à 2200, `min ≤ max` ;
- millésime : `year` entier de 1900 à l'année en cours + 1, `region` parmi les
  régions du référentiel, `quality` dans l'énumération ;
- garde : entiers de 0 à 100, `min ≤ max`, `appellationId` existant, `color`
  dans `WineColor` ou absent.

## Écrans

### Fiche vin

Bloc « Apogée » sous les informations du vin :
- la fourchette (« À boire entre 2024 et 2036 »), un badge de confiance
  (*Saisie*, *Confiance moyenne*, *Confiance faible*) et le libellé de statut ;
- sans estimation : le message de la `reason` ;
- *Corriger* : deux champs d'année (pré-remplis avec la fourchette affichée),
  validation `min ≤ max` dans le formulaire, enregistrement ;
- *Revenir à l'estimation* (visible seulement si la confiance est `SAISIE`).

### Onglet Cave

Chaque ligne porte une mention courte sous l'appellation : « À boire
2024-2036 », « Trop jeune (2027) », « À boire vite », « Apogée passée ». Rien
quand il n'y a pas d'estimation.

### Administration (administrateurs)

Deux sections ajoutées à `/admin` :
- **Qualité des millésimes** : choix d'une région (liste du référentiel) et
  d'une année, puis *Grand* / *Moyen* / *Faible* ; liste des millésimes
  qualifiés, triée par région puis année décroissante, chacun avec *Retirer*.
- **Gardes** : recherche d'une appellation ; affichage de sa garde du
  référentiel et de ses ajustements ; ajout d'un ajustement pour toutes les
  couleurs ou pour une couleur ; *Retirer* sur chaque ajustement.

## Export Excel

Feuille *Stock* : colonnes *Apogée min*, *Apogée max*, *Confiance* (libellés
français) ajoutées après *Millésime*, calculées par la même fonction ; une
ligne dont le statut est `PASSEE` reçoit un fond d'avertissement.

## Erreurs

| Situation | Comportement |
| --- | --- |
| Correction invalide | Refusée dans le formulaire et par l'api (`400`, message français) |
| Règle invalide | `400`, message français |
| Compte non administrateur sur `/admin/vintages` ou `/admin/guards` | `403`, comme le reste de l'administration |
| Vin inconnu | `404` « Vin introuvable » |
| Appellation inconnue dans un ajustement | `404` « Appellation introuvable » |

## Tests

- **Fonction de calcul** : chaque niveau de priorité de la garde, le rosé, les
  trois facteurs et le millésime non qualifié, l'arrondi, la correction qui
  prime, les trois absences d'estimation, les quatre statuts, tous les exemples
  de référence ci-dessus.
- **Api** : correction posée puis retirée, validations, `403` des routes de
  règles pour un non-administrateur, `apogee` présent dans la liste et la fiche,
  et une règle modifiée change immédiatement la fourchette d'un vin.
- **Intégration** (PostgreSQL de la CI) : un ajustement de garde survit au
  rechargement du référentiel ; unicité des ajustements (appellation seule,
  appellation + couleur).
- **Export** : colonnes et mise en évidence des apogées passées.
- **Interface** : bloc Apogée (affichage, correction, retour à l'estimation,
  absence d'estimation, validation), mention dans la liste, sections
  d'administration.
- **Essai dans le navigateur** à largeur de téléphone.

## Livraison

- Commits `feat:` → version **1.3.0** via release-please.
- Aucune nouvelle variable d'environnement ; `docker-compose.yml` inchangé ;
  la migration s'applique au démarrage de l'api.
- README (fonctionnalités, limites, journal) et CHANGELOG en français.

## Hors périmètre

- Vue « à boire cette année » et alertes (lot 3).
- Cote iDealwine (lot 2c).
- Pré-remplissage de la qualité des millésimes.
- Estimation pour les vins non millésimés.
