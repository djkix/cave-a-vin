# Maquettes de référence — Cave & Terroir

Ces 4 fichiers sont des maquettes HTML/Tailwind générées par IA (fournies par
l'utilisateur), servant de référence visuelle pour l'implémentation :

- `01-accueil-cockpit.html` — écran d'accueil (boutons Rentrer/Sortir, stats, derniers mouvements)
- `02-confirmation-entree.html` — écran de confirmation après extraction vision (entrée de stock)
- `03-sortie-matching.html` — écran de sortie avec sélection de candidats (millésimes multiples)
- `04-fiche-vin.html` — fiche détail d'un vin (apogée, cote, journal)

**Note de réconciliation.** L'utilisateur a fourni 5 maquettes au total ; 4 partagent
une même palette bronze/doré ("Bastide Provençale & Travertin Doré" : `primary` `#7a5522`,
accents `#8b612c`/`#a37943`/`#956d38`, ferronnerie noire `#2b2621`), cohérente avec la
description de la charte graphique du cahier des charges (doré chêne = *Rentrer*,
ferronnerie noire = *Sortir*). Une 5e maquette (variante de la fiche vin) utilisait une
palette vert sauge incohérente avec les autres — elle a été écartée. Les tokens de design
définitifs de l'application (`packages/design-tokens` ou équivalent) sont construits à
partir de cette palette bronze/doré, pas copiés tels quels depuis ces fichiers : les
valeurs divergent légèrement d'un fichier à l'autre (ex. `border-radius` DEFAULT
0.125rem vs 0.25rem, `primary-container` `#8b612c` vs `#956d38` vs `#a37943`), signe
qu'il s'agit d'explorations et non d'une source de vérité figée. Se référer à la section
*Charte graphique* de `docs/superpowers/specs/` pour les valeurs consolidées.

Polices : Noto Serif (noms de domaine/cuvée, headlines) + Manrope (corps, chiffres,
labels) ; icônes Material Symbols Outlined.
