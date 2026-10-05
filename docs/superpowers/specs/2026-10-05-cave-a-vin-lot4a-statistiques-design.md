# Cave & Terroir — Design Lot 4a : les statistiques

2026-10-05 · Franck Laval

## Contexte

Cahier des charges source : [`cahier-des-charges.md`](../../../cahier-des-charges.md),
lot 4 (« Valorisation du stock, statistiques », section « Valorisation de la
cave »). Ce document fixe le **périmètre du lot 4a** et les **décisions prises**
en conception.

Le lot 4 est découpé en trois sous-projets livrés dans cet ordre : **4a (ce
document)**, 4b (notes de dégustation), 4c (accords mets-vins). La valorisation
au **prix de marché** dépend de la cote iDealwine (lot 2c, reportée) et reste
hors de ce lot.

## Intention

Voir la cave d'un coup d'œil : ce qu'elle vaut au prix payé, comment elle se
répartit, ce qui reste à boire, à quel rythme elle se vide, et ce qui y domine.
Tout se calcule à partir des données déjà en base — journal des mouvements,
fiches vin, apogée estimée — sans rien stocker de plus.

## Décisions prises

| Question | Décision | Conséquence |
| --- | --- | --- |
| Contenu | Valeur au prix d'achat, répartition du stock, mouvements sur 12 mois, classements | Quatre blocs sur une même page |
| Accès | **5e onglet « Stats »** dans la barre du bas, après Journal ; tout compte actif | La barre passe à cinq onglets ; à vérifier à 375 px |
| Graphiques | **Barres en HTML/CSS, calcul côté API** | Aucune dépendance ; une route `GET /api/stats` ; lisible au lecteur d'écran |
| Prix d'achat retenu | **Dernier prix d'achat saisi** du vin, comme la colonne *Valeur d'achat* de l'export | Un seul chiffre partout ; un vin sans prix est compté à part |

## Calculs

Fonction pure `computeStats(input, now)` dans `api/src/stats/`, testable sans
base. Le service lit les données (vins avec stock et appellation, mouvements,
règles d'apogée) et la lui passe. Les mois sont ceux du fuseau
`Europe/Paris`.

### Mouvements comptés

- Une **entrée** est un mouvement `IN`, une **sortie** un mouvement `OUT`.
- Un mouvement **annulé** (référencé par le `reverses_id` d'un autre) ne compte
  ni en entrée ni en sortie ; l'annulation elle-même (`ADJUST`) non plus.
- Un **inventaire** (`ADJUST` sans `reverses_id`) n'est ni une entrée ni une
  sortie.
- Le stock reste celui de `stock_courant` (somme de tout le journal).

### 1. Valeur et volume

- `bottles` : somme des stocks positifs ; `references` : nombre de vins en
  stock.
- `purchaseValueCents` : somme, sur les vins en stock dont un prix d'achat est
  connu, de `stock × dernier prix d'achat unitaire` (dernier mouvement `IN` non
  annulé portant un prix). En centimes dans l'API ; affichée arrondie à l'euro,
  précédée de « ~ ».
- `pricedReferences` : nombre de vins en stock avec un prix connu. L'écran
  affiche « sur {pricedReferences} des {references} références » dès qu'un prix
  manque ; `purchaseValueCents` vaut `null` quand aucun prix n'est connu.

### 2. Répartition du stock

En bouteilles, avec la part du total (sur les vins en stock) :

| Clé | Groupes | Ordre |
| --- | --- | --- |
| `byColor` | `ROUGE`, `BLANC`, `ROSE`, `PETILLANT` | décroissant |
| `byRegion` | région de l'appellation ; « Sans région » si l'appellation n'est pas reconnue | décroissant ; l'écran montre les 8 premiers puis « Autres » |
| `byDecade` | décennie du millésime (« 2010 » pour 2010-2019) ; « Non millésimé » | décennie croissante, « Non millésimé » en dernier |
| `byApogee` | `TROP_JEUNE`, `A_BOIRE`, `A_BOIRE_VITE`, `PASSEE`, `SANS_ESTIMATION` | ordre fixe ci-contre |

Le statut d'apogée est celui de `estimateApogee` (correction manuelle
comprise), pour l'année en cours.

### 3. Mouvements sur 12 mois

- `months` : 12 entrées, du mois le plus ancien au mois en cours inclus,
  chacune `{ month: 'AAAA-MM', in, out }` (bouteilles, valeurs absolues). Un
  mois sans mouvement vaut `0`.
- `drinkRate` : bouteilles sorties sur ces 12 mois ÷ 12, arrondi à une
  décimale.
- `yearsLeft` : `bottles ÷ (drinkRate × 12)`, arrondi à l'entier ; `null` si
  `drinkRate` vaut 0.

### 4. Classements (5 premiers)

| Clé | Contenu | Ordre, départage |
| --- | --- | --- |
| `mostDrunk` | vins par bouteilles sorties sur 12 mois (vins sortis au moins une fois) | décroissant, puis producteur |
| `topProducers` | producteurs par bouteilles en stock | décroissant, puis nom |
| `mostExpensive` | vins en stock par dernier prix d'achat unitaire | décroissant, puis producteur |

Chaque vin d'un classement porte `id`, `producer`, `cuvee`, `vintage` et la
valeur classée.

## API

| Méthode et route | Droits | Réponse |
| --- | --- | --- |
| `GET /api/stats` | session (tout compte actif) | `{ bottles, references, pricedReferences, purchaseValueCents, byColor, byRegion, byDecade, byApogee, months, drinkRate, yearsLeft, mostDrunk, topProducers, mostExpensive }` |

Chaque répartition est une liste `{ key, bottles, share }` (`share` entre 0 et
1). Pas de paramètre ; `401` sans session.

## Écran

Onglet **Stats** (icône `bar_chart`), route `/stats`, page **Statistiques**
faite de cartes (`card`) qui défilent :

1. **En-tête** : trois chiffres — bouteilles, références, valeur au prix
   d'achat (« ~12 400 € ») — et, si des prix manquent, « sur 38 des 52
   références ». Sans aucun prix : « — » et « Aucun prix d'achat saisi ».
2. **Apogée** : une barre par statut, nombre et pourcentage. *À boire vite* et
   *Passée* mènent à `/cave` avec le filtre *À boire en priorité* coché ; *Sans
   estimation* avec le filtre *Sans apogée*. L'onglet Cave lit pour cela un
   paramètre d'URL `filtre=priorite` ou `filtre=sans-apogee`.
3. **Couleur**, **Région** (8 premières puis *Autres*), **Millésime** : barres
   horizontales, libellé, nombre, pourcentage. Les barres de couleur prennent
   les teintes de la charte (`--color-wine-rouge`, `-blanc`, `-rose`, et un
   nouveau `--color-wine-petillant`) ; les autres, la teinte primaire.
4. **Mouvements sur 12 mois** : histogramme de 12 colonnes, une barre
   d'entrées et une de sorties par mois, mois abrégés en français (« oct. »).
   Chaque colonne porte un libellé accessible (« octobre 2026 : 12 entrées, 4
   sorties »). En dessous : « En moyenne {drinkRate} bouteilles bues par mois —
   environ {yearsLeft} ans de cave à ce rythme » ; sans sortie : « Aucune
   bouteille sortie sur 12 mois ».
5. **Classements** : *Les plus bus*, *Producteurs*, *Les plus chères* — cinq
   lignes chacun ; chaque vin mène à sa fiche `/cave/:id`.

États : « Calcul… » pendant le chargement ; « Impossible de charger les
statistiques. » en cas d'erreur ; une cave vide affiche « Aucune bouteille en
cave pour l'instant » à la place des cartes (l'histogramme reste affiché s'il y
a eu des mouvements).

Les montants et pourcentages sont en chiffres tabulaires (`num`), arrondis
(pourcentage entier, euros entiers).

## Erreurs

| Situation | Comportement |
| --- | --- |
| Pas de session | `401` |
| Erreur de lecture | `500` ; l'écran affiche le message d'erreur français |
| Données incomplètes (vin sans prix, sans région, sans millésime, sans apogée) | Comptées dans leur groupe « sans », jamais devinées |

## Tests

- **Fonction de calcul** : valeur avec prix partiels et sans aucun prix ;
  dernier prix retenu, prix d'un mouvement annulé ignoré ; annulations et
  inventaires exclus des entrées et sorties ; bornes des 12 mois (premier jour
  du mois le plus ancien, mois en cours, fuseau de Paris) ; mois sans
  mouvement à 0 ; `drinkRate` et `yearsLeft` (et `null` sans sortie) ;
  regroupements « Sans région », « Non millésimé », « Sans estimation » ; ordre
  des répartitions ; classements limités à 5 avec départage.
- **Api** (PostgreSQL de la CI) : `GET /api/stats` avec une session renvoie la
  forme décrite ; `401` sans session.
- **Interface** : chaque carte, liens vers la cave avec le bon filtre (et
  l'onglet Cave qui coche le filtre depuis l'URL), états chargement, erreur et
  cave vide ; cinq onglets dans la barre.
- **Essai dans le navigateur** à largeur de téléphone (375 px).

## Livraison

- Commits `feat:` → version **1.6.0** via release-please.
- Aucune migration, aucune nouvelle variable d'environnement ;
  `docker-compose.yml` inchangé.
- README (fonctionnalités, limites, journal) et CHANGELOG en français.

## Hors périmètre

- Valorisation au prix de marché et écart achat / marché (lot 2c).
- Notes de dégustation (4b), accords mets-vins (4c).
- Filtres ou périodes réglables (la fenêtre est fixe : 12 mois).
- Export des statistiques.
