# Cave & Terroir — Design : emplacements et cote iDealwine saisie à la main

2026-10-07 · Franck Laval

## Contexte

Deux lots reportés du cahier des charges : les **emplacements** (lot 3) et la
**cote iDealwine** (lot 2c). Le cahier prévoyait un relevé automatique de la
cote par un robot connecté au compte iDealwine ; les conditions générales
d'iDealwine soumettent toute copie de leur base de cotes, prix actuels et
historiques compris, à leur autorisation préalable, quel que soit l'usage. Ce
relevé automatique est donc abandonné au profit d'une **saisie à la main
assistée**.

## Décisions prises

| Question | Décision |
| --- | --- |
| Cote | Saisie à la main par le propriétaire (option A) ; bouton vers la page iDealwine ; jamais de lecture automatique |
| Structure d'un emplacement | Trois champs texte facultatifs : **zone**, **casier**, **position** |
| Granularité | Par lot : « N bouteilles de ce vin à tel endroit » |
| Saisie | À l'entrée (champ replié, pré-rempli avec le dernier emplacement utilisé) et depuis la fiche vin |
| Sortie | On demande d'où sort la bouteille quand le vin est rangé à plusieurs endroits, le choix le plus probable pré-sélectionné |
| Recherche | Filtre « Emplacement » dans la cave, emplacement sur la fiche et dans l'export |
| Membres | Voient les emplacements, ne les modifient pas (lecture seule, comme le reste) |

## 1. Emplacements

### Données

- Table `location (id, cave_id, zone, casier, position, label_key, created_at)`
  avec `zone`, `casier`, `position` facultatifs (texte, 1 à 40 caractères une
  fois nettoyés, au moins un des trois renseigné) ; `label_key` = les trois
  champs nettoyés, en minuscules, joints par `|` ; unicité `(cave_id,
  label_key)` : saisir deux fois « Cave 2 / B / 3 » donne le même emplacement.
- Colonne `movement.location_id` (facultative, référence `location`). Le
  **stock d'un emplacement** est la somme des `delta` des mouvements de ce vin à
  cet emplacement ; « Sans emplacement » = stock total − somme des stocks
  positifs par emplacement (jamais négatif à l'affichage). Aucune quantité n'est
  stockée à part : les mouvements restent la seule source de vérité, une
  annulation de mouvement rend la bouteille à son emplacement.
- Nouveau type de mouvement `MOVE` (déplacement) : un déplacement de N
  bouteilles de A vers B crée deux mouvements `MOVE` (−N à A, +N à B) de même
  date. Ils ne changent pas le stock total, n'apparaissent ni dans les entrées
  ni dans les sorties des statistiques, et figurent au journal comme
  « Déplacé ». Annuler l'un annule les deux.
- Les bouteilles existantes n'ont pas d'emplacement : elles sont « Sans
  emplacement » jusqu'à ce qu'on les range.

### Écrans et API

- **Entrée** (écran de confirmation, unitaire et « À confirmer ») : bloc replié
  « Emplacement » avec zone / casier / position, pré-rempli avec le dernier
  emplacement utilisé dans la cave (mémorisé côté serveur : emplacement du
  dernier mouvement `IN` de la cave). Les suggestions proposent les
  emplacements existants de la cave (liste `<datalist>`).
- **Sortie** : si le vin a du stock à plus d'un endroit (emplacements et/ou
  « Sans emplacement »), on demande « D'où sort-elle ? » avec la liste des
  endroits et leur quantité ; pré-sélection : l'endroit qui a reçu le plus
  récemment une bouteille de ce vin et en a encore. Un seul endroit : pas de
  question.
- **Inventaire** (ajustement du stock) : même choix d'endroit que la sortie
  pour une baisse ; une hausse va à l'endroit choisi (par défaut « Sans
  emplacement »).
- **Fiche vin** : section « Emplacements » listant chaque endroit et sa
  quantité ; bouton « Ranger / déplacer » (propriétaire) : de (endroit
  d'origine, « Sans emplacement » compris), vers (zone / casier / position),
  quantité (1 au stock de l'origine).
- **Cave** : filtre « Emplacement » (liste des emplacements de la cave, plus
  « Sans emplacement ») ; la ligne d'un vin n'affiche pas les emplacements
  (fiche seulement).
- **Export** : colonne « Emplacements » dans la feuille Stock (« Cave 2 / B / 3
  × 4 ; Sans emplacement × 2 »).
- API (toutes sous `CaveAccessGuard`) :
  - `GET /api/locations` (VIEWER) : emplacements de la cave `[{ id, zone,
    casier, position, label }]` ;
  - entrée, sortie, inventaire : champ facultatif `location: { zone?, casier?,
    position? } | null` (sortie et inventaire : ou `locationId`, ou `null` pour
    « Sans emplacement ») ; l'emplacement est créé à la volée s'il n'existe pas ;
  - `POST /api/wines/:id/move { from: locationId | null, to: { zone?, casier?,
    position? }, quantity }` (OWNER) ;
  - `GET /api/wines/:id` renvoie `locations: [{ id | null, label, quantity }]`
    (quantités > 0) ;
  - `GET /api/cave?location=<id|none>` filtre.

### Erreurs

| Situation | Réponse |
| --- | --- |
| Aucun des trois champs renseigné | 400 « Indiquez au moins une zone, un casier ou une position » |
| Champ de plus de 40 caractères | 400 « 40 caractères au plus par champ d'emplacement » |
| Sortie / déplacement depuis un endroit sans assez de bouteilles | 409 « Pas assez de bouteilles à cet emplacement » |
| Emplacement d'une autre cave | 404 « Emplacement introuvable » |

## 2. Cote iDealwine saisie à la main

### Données

- Table `price_quote (id, wine_id, source, cote_cents, n_transactions,
  quoted_on, source_url, entered_by, created_at)`, en ajout seulement
  (historique) ; `source = 'IDEALWINE'` ; `quoted_on` = date de la cote (jour) ;
  `source_url` facultative (page iDealwine du vin) ; `entered_by` = compte qui a
  saisi (null si supprimé).
- La cote courante d'un vin = la dernière saisie (par `quoted_on`, puis
  `created_at`).

### Écrans et API

- **Fiche vin**, bloc « Cote iDealwine » (propriétaire seulement : un membre ne
  voit aucun prix, cote comprise) :
  - sans cote : « Pas encore de cote » + **« Voir la cote sur iDealwine »**
    (lien ouvert dans un nouvel onglet : la page enregistrée du vin si
    `source_url` existe, sinon la recherche iDealwine sur « producteur cuvée
    millésime ») + **« Saisir la cote »** ;
  - avec cote : « 85 € — 12 transactions — cote du 3 mars 2026, il y a 7 mois »,
    « Valeur de cession estimée : 73 € (cote hors frais acheteur d'environ 16 %) »,
    un avertissement « Peu de transactions : ordre de grandeur » sous 5
    transactions, « Cote de plus d'un an » au-delà de 12 mois ; boutons « Voir
    sur iDealwine » et « Mettre à jour » ;
  - formulaire : cote en euros (> 0, au plus 100 000 €), nombre de transactions
    (entier ≥ 0, facultatif), date de la cote (par défaut aujourd'hui, ni dans
    le futur ni avant 1990), lien de la page iDealwine (facultatif, doit
    commencer par `https://www.idealwine.com/`).
- **Statistiques** (propriétaire) : « Valeur à la cote : X € sur N références
  cotées (sur M) », valeur de cession estimée à côté. Absent pour un membre
  (ajouté à `PRICE_KEYS`).
- **Export** : feuille Stock, colonnes « Cote iDealwine », « Date de la cote »,
  « Valeur à la cote » (cote × quantité). Ces colonnes n'apparaissent que pour
  le propriétaire (l'export lui est réservé).
- **Liste de la cave** : inchangée (pas de prix dans la liste).
- API :
  - `POST /api/wines/:id/quotes { coteCents, nTransactions?, quotedOn,
    sourceUrl? }` (OWNER) → la cote créée ;
  - `GET /api/wines/:id` renvoie `quote: { coteCents, nTransactions, quotedOn,
    sourceUrl, enteredBy } | null` et `idealwineUrl` (lien calculé) pour le
    propriétaire ; **les deux clés sont absentes** pour un membre.
- Le lien de recherche iDealwine : `https://www.idealwine.com/fr/prix-vin/`
  suivi de « producteur cuvée millésime » en minuscules, sans accents, mots
  joints par `-`, puis `/le_marche_search/ok_results.jsp`. S'il ne mène pas à
  la bonne page, l'utilisateur enregistre le lien exact dans le formulaire.

### Erreurs

| Situation | Réponse |
| --- | --- |
| Cote absente, nulle ou trop grande | 400 « La cote doit être comprise entre 0,01 € et 100 000 € » |
| Transactions négatives ou non entières | 400 « Nombre de transactions invalide » |
| Date future ou avant 1990 | 400 « Date de cote invalide » |
| Lien hors iDealwine | 400 « Le lien doit être une page www.idealwine.com » |

## 3. Tests

- Emplacements : stock par emplacement dérivé des mouvements (entrée, sortie,
  inventaire, déplacement, annulation) ; « Sans emplacement » ; unicité par
  cave et nettoyage des champs ; pré-sélection de la sortie ; 409 si pas assez ;
  emplacement d'une autre cave 404 ; `MOVE` hors des statistiques
  d'entrées/sorties ; filtre de la cave ; export.
- Cote : validation, cote courante = dernière saisie, valeur de cession, âge,
  avertissements, clés absentes pour un membre (fiche, stats), export, lien de
  recherche.
- Matrice d'étanchéité : les nouvelles routes y sont classées.
- Écrans : bloc emplacement à l'entrée (pré-rempli), question de la sortie,
  ranger / déplacer, filtre, bloc cote (sans / avec, formulaire, membre sans
  bloc).
- Essai navigateur 375 px.

## 4. Livraison

Une migration (`location`, `movement.location_id`, valeur `MOVE`,
`price_quote`) ; aucune nouvelle variable d'environnement ; version 2.2.0 ;
README (fonctionnalités, limites : cote saisie à la main, pas de relevé
automatique, CGS iDealwine) et CHANGELOG en français ; cahier des charges
annoté (relevé automatique abandonné, emplacements livrés).
