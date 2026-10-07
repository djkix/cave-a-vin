<p align="center"><img src="web/public/icons/icon.svg" width="96" alt="Icône de Cave & Terroir : un verre de vin sur fond bordeaux" /></p>

# Cave & Terroir

Gestion de cave à vin sans saisie clavier : une photo à l'achat crédite le stock,
une photo au moment de boire le débite, et un classeur Excel exportable donne à
tout moment l'état complet de la cave. Application auto-hébergée en Docker,
utilisée depuis un téléphone (PWA installable).

- **URL publique** : <https://cave.djkix.ovh/>
- **État** : lot 0, lot 1, lot 2a, lot 2b, lot 3a, mesure « zéro saisie », lot 4a
  (statistiques), lots 4b et 4c (note de dégustation, accords mets-vins) et
  entrée en rafale avec analyse par lot livrés — socle, entrée de stock par
  photo en rafale (Gemini, analyse par lot en arrière-plan), liste « À
  confirmer », file hors ligne, journal et export Excel, onglet Cave, fiche vin
  et sortie de stock (par la liste ou par photo), estimation de l'apogée par
  règles avec correction manuelle par vin, filtre « à boire en priorité »,
  statistiques de la cave, note de dégustation, accords mets-vins et descriptif
  du domaine, photos retouchées, image d'étiquette trouvée sur le web, icône,
  et, depuis la 2.0.0, une cave par compte : inscription validée par un
  administrateur, membres invités en lecture seule, sélecteur de cave.
- **Reportés, en lots séparés** : emplacements dans la cave, cote iDealwine
  (lot 2c). Pas d'alerte hors de l'application (notification ou e-mail) : la
  liste « à boire en priorité » se consulte dans l'application. Voir
  `cahier-des-charges.md`.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Architecture et ports](#architecture-et-ports)
- [Déploiement](#déploiement)
- [Mise à jour](#mise-à-jour)
- [Sauvegarde et restauration](#sauvegarde-et-restauration)
- [Développement](#développement)
- [Limites](#limites)
- [Journal des modifications](#journal-des-modifications)
- [Stack technique](#stack-technique)

## Fonctionnalités

**Une cave par compte.** Chaque compte a sa propre cave, dont il est le
**propriétaire** : ses vins, ses photos, ses mouvements et ses exports ne sont
visibles que de lui et des membres qu'il invite. Une adresse Google inconnue
qui se connecte ne voit rien tant qu'un administrateur n'a pas validé son
inscription : l'écran affiche « Inscription en attente de validation —
revenez plus tard : l’accès s’ouvrira dès qu’un administrateur l’aura
validée. » (aucun e-mail n'est envoyé, il suffit de revenir). La validation crée sa cave,
« Cave de {nom affiché ou e-mail} ». Une adresse invitée par un propriétaire,
elle, entre directement, sans validation. Un identifiant (vin, photo,
mouvement, membre) d'une autre cave répond comme un identifiant inconnu (404),
et une cave à laquelle le compte n'a pas accès répond « Cave introuvable ».

**Membres en lecture seule.** Depuis l'accueil, *Membres de la cave*
(propriétaire seulement) liste les membres, invite une adresse Google (« Cette
adresse est déjà membre » si elle l'est déjà), retire un membre (jamais le
propriétaire) et renomme la cave (1 à 80 caractères). Un membre voit la cave
qui l'a invité : la liste et ses filtres, la recherche par plat, la fiche vin
(apogée, note, accords, descriptif du domaine) et les statistiques. Il ne voit
**aucun prix d'achat** — les champs sont absents des réponses de l'API, pas
seulement masqués : ni valeur au prix d'achat ni classement « les plus
chères » dans les statistiques —, ni le journal, ni l'export Excel, ni « À
confirmer », et il **n'écrit rien** : pas d'entrée, de sortie, d'inventaire,
de photo, de note, d'apogée manuelle, de recherche d'image ni de régénération
des accords (l'API répond 403 « Lecture seule »). Son application n'affiche
que les onglets *Cave* et *Stats*, sans boutons d'action sur la fiche. Les
images des photos lui sont servies pour toutes les caves dont il est membre.

**Sélecteur de cave.** Un compte qui a accès à plusieurs caves (la sienne et
celles où il est invité) choisit la cave courante dans l'en-tête ; une cave
en lecture seule porte la mention « (lecture) », et un badge « Lecture
seule » rappelle le rôle courant. Le choix est gardé dans la session ; par
défaut, c'est la cave dont le compte est propriétaire, sinon sa plus ancienne
invitation. Un compte actif qui n'a aucune cave (ni la sienne, ni une
invitation) voit « Vous n’avez pas encore de cave. Un administrateur peut
vous en créer une, ou un propriétaire peut vous inviter. »

**Entrée de stock par photo, en rafale.** Bouton *Rentrer*, un grand bouton photo
et un compteur « N photos prises » : on enchaîne photo après photo, sans
attendre ni confirmer une fiche entre deux prises. Chaque photo est réduite sur
le téléphone (côté le plus long 1 600 px, JPEG qualité 0,8 ; si la réduction
échoue, la photo part telle quelle), rangée dans une file locale, et l'écran est
aussitôt prêt pour la suivante. La file locale accepte jusqu'à 200 photos (ou
200 Mo) ; un envoyeur unique les envoie une par une en arrière-plan, relancé
après chaque prise, au retour du réseau, au retour au premier plan et toutes
les 15 s tant que la file n'est pas vide, quelle que soit la page ouverte
(il est porté une seule fois, à la racine des pages protégées) — il ne
fonctionne que tant que l'application est ouverte. Sur le serveur, un travail planifié passe toutes les
15 s et analyse les photos d'entrée par lots : jusqu'à 8 photos en un seul
appel Gemini (un lot part dès 8 photos en attente, ou dès que la plus ancienne
patiente depuis 45 s), pour limiter le coût par photo ; une photo seule part
en appel simple, au coût de cet appel. Le résultat arrive donc
en général en 15 s à 1 min plutôt qu'immédiatement. Si la réponse du lot est
incohérente (nombre ou ordre des fiches mélangé), chaque photo du lot est relue
seule, sans attribution croisée.

Les fiches lues rejoignent la liste **« À confirmer »** (lien sur l'accueil,
avec un badge « N vins à confirmer »), en trois sections : *À valider* (fiche
pré-remplie — domaine, cuvée, appellation, millésime, couleur, format — avec un
indicateur de confiance par champ, quantité lue sur le carton sinon 1 et
modifiable ; *Valider* fiche par fiche ou *Tout valider* d'un coup ; *Mettre
de côté* sort la fiche de *Tout valider* pour la visite en cours seulement —
elle reste à confirmer et revient à la prochaine ouverture ; *Écarter* retire
définitivement la photo sans créer de mouvement, après confirmation « Écarter
cette photo ? Elle ne sera plus proposée. »), *En cours d'analyse* (photos pas
encore lues, avec le motif d'un report éventuel) et *Lecture impossible*
(photos en échec, avec *Saisir à la main* vers l'écran de confirmation unitaire
et *Écarter*). La liste se rafraîchit toutes les 10 s. Rien n'est jamais écrit
en stock avant une validation explicite. Les anciennes URL du mode campagne
(`/entree/campagne` et `/entree/campagne/revue`) redirigent respectivement vers
la rafale et vers « À confirmer » ; le mode campagne lui-même a disparu,
fusionné dans ce parcours. Côté API : `GET /api/photos/entry-inbox` (les trois
sections) et `POST /api/photos/:id/dismiss` (écarter une photo).

**La cave et la sortie.** L'onglet *Cave* liste les vins en stock avec
vignette (photo de l'entrée, ou un pictogramme de bouteille s'il n'y a pas de
photo ou qu'elle ne charge pas), domaine, cuvée, appellation, millésime,
couleur et quantité ; la recherche porte sur domaine/cuvée/appellation sans
tenir compte des accents ni de la casse (« chateauneuf » trouve
« Châteauneuf-du-Pape »), un filtre par couleur s'ajoute, et les vins épuisés
restent masqués sauf à cocher « Vins épuisés ». La fiche vin affiche la photo
de référence (celle de la première entrée), le stock et les 10 derniers
mouvements ; *Sortir* propose un sélecteur de quantité borné par le stock puis
confirme « Sorti — il en reste N » (le message survit au rafraîchissement du
stock, y compris pour la dernière bouteille) ; *Corriger le stock* permet un
inventaire physique — le nombre compté, l'écart annoncé avant d'enregistrer
(« −2 bouteilles », « Stock déjà juste »), écrit comme un mouvement `ADJUST`
daté (« Inventaire : N comptées »). La **sortie par photo** (bouton *Sortir une
bouteille* sur l'accueil, ou onglet *Sortie*) ne reconnaît que les vins en
stock : l'étiquette est lue par Gemini puis comparée sur domaine/cuvée/
appellation, le millésime pesant fortement. Un candidat clair déclenche une
confirmation ; plusieurs candidats (ou un candidat incertain) affichent 1 à 4
vignettes avec le millésime en gros, un tap suffit pour choisir, et « Choisir
un autre millésime » permet de revenir en arrière ; aucun candidat affiche
« Ce vin n'est pas dans la cave » avec « Chercher dans la cave » (recherche
pré-remplie avec ce qui a été lu) ou « Rentrer ce vin ». Si l'envoi de la photo
échoue, « Réessayer l'envoi » renvoie la même photo sans reprendre une capture ;
si l'analyse échoue d'emblée ou n'a pas abouti au bout de 12 s, l'écran bascule
sur « Chercher dans la cave ». Rien n'est jamais sorti sans confirmation
explicite. Les photos de sortie ne sont **jamais reportées** : deux tentatives
à 3 s d'intervalle puis abandon (l'utilisateur sort par la liste) ; elles
n'apparaissent ni dans « À confirmer » ni dans le bandeau « en attente
d'analyse », et ne sont pas remises en file au démarrage du worker.

**Analyse différée, jamais bloquante.** L'analyse ne dépend pas de la
disponibilité de l'API de vision. Dès qu'une photo est reçue, elle est stockée
sur le serveur ; si le service de lecture est saturé, injoignable ou à quota
(erreurs 429, 500, 502, 503, 504, coupure réseau, plafond mensuel atteint), la
photo **retourne en attente au lieu d'échouer** et le worker la reprend
automatiquement — 30 s, 1 min, 2, 4, 8, puis toutes les 15 minutes, pendant une
dizaine de jours si nécessaire. Une photo d'entrée est aussi **reportée, et non
mise en échec, quand le service de lecture est mal configuré** (clé Gemini
invalide ou expirée, API non activée, modèle inconnu) : elle affiche « Analyse
reportée : service de lecture mal configuré (clé Gemini à vérifier), reprise
automatique » et repart d'elle-même une fois la clé corrigée. Le motif du
report s'affiche sous la photo dans la section *En cours d'analyse* de « À
confirmer », et un bandeau « N photos en attente d'analyse » (sans compter les
photos écartées), avec le motif du dernier report, reste visible sur l'accueil.
Seule une étiquette réellement inexploitable échoue tout de suite, avec le
message « Lecture de l’étiquette inexploitable », et rejoint *Lecture
impossible* pour une saisie manuelle ; les messages bruts du service de lecture
ne sont jamais affichés, ils restent dans les journaux du worker. Les photos
d'entrée n'ont pas de travail Redis : la table des photos sert elle-même de
file, si bien qu'un redémarrage du worker ou de Redis ne leur fait perdre ni
leur place ni leur analyse — une réservation interrompue est reprise au bout de
cinq minutes. Une photo reçue n'est jamais perdue, même après un redémarrage
de la pile.

**Photos plus nettes.** Une version d'affichage est fabriquée par le serveur,
sans aucun coût supplémentaire : la lecture Gemini d'une photo renvoie déjà le
cadre de l'étiquette, réutilisé pour recadrer l'image avec une marge quand ce
cadre est plausible, puis corriger balance des blancs, contraste et netteté,
et la réduire à 1200 px de côté au plus. Elle est fabriquée une seule fois, à
la première consultation d'une photo lue (ou en échec), puis gardée sur le
disque ; c'est elle qui s'affiche désormais dans les vignettes (cave, fiche,
sortie) et les écrans de confirmation. L'original n'est jamais modifié, et
c'est toujours lui que Gemini relit. API : `GET /api/photos/:id/image?variant=display`
(sans paramètre, l'original, inchangé).

**Chercher une image.** Sur la fiche vin, un bouton sous l'en-tête (vignette et
titre) ouvre, sur toute la largeur de la fiche, une recherche d'image d'étiquette sur le web, pour remplacer sa propre photo par
une image plus nette ou plus officielle. La recherche interroge d'abord **Open
Food Facts** (gratuit, sans clé, licence CC BY-SA, source toujours citée avec
un lien) ; si rien n'y figure, **le site officiel du domaine**, retrouvé par
Gemini grâce à la recherche Google intégrée (5 000 recherches gratuites par
mois pour les modèles Gemini 3 ; chaque recherche compte au moins 1 centime,
et davantage si Gemini lance plusieurs requêtes de recherche, dans le plafond mensuel et dans la part de 80 % déjà réservée aux accords et
descriptifs). Le serveur télécharge lui-même jusqu'à 5 propositions et les
garde 1 heure le temps de choisir ; chaque téléchargement est protégé (adresses
http(s) publiques seulement, taille et délai limités, 4 secondes par image).
La recherche entière tient en 30 secondes : passé ce délai, les propositions
déjà prêtes s'affichent, et s'il n'y en a aucune, « Recherche d'image
indisponible pour le moment ». Une fois l'image choisie, la fiche affiche « Image : {source} » (lien vers la page d'origine) et
« Revenir à ma photo » pour annuler à tout moment. Limité à 10 recherches par
minute. API : `POST /api/wines/:id/image-search`, `GET
/api/image-candidates/:id`, `POST`/`DELETE /api/wines/:id/reference-image`.

**Version affichée en permanence.** Le numéro de version est visible en haut à
droite de chaque écran, et sur l'écran de connexion avant même de s'identifier —
indispensable dans une PWA installée, où aucune barre d'adresse ne dit ce qui
tourne. Une image publiée affiche son numéro (`1.0.0`) ; une image `latest`
construite depuis `main` affiche ce numéro suivi de l'empreinte du commit
(`1.0.0+ab12cd3`), pour ne jamais faire passer des changements non publiés pour
la dernière version ; une construction locale affiche `dev`.

**Hors ligne.** La cave est souvent un sous-sol sans réseau : les photos sont
mises en file dans le navigateur (200 photos ou 200 Mo maximum) et envoyées une
par une dès que le réseau revient, ou que l'application revient au premier
plan. Le bandeau « N photos en cours d'envoi » reste visible ; file pleine,
il annonce « File d'envoi pleine (200 photos) — attendez que les envois
partent ».

**Journal et annulation.** Les 20 derniers mouvements de la cave sont
consultables et annulables en un tap, par son propriétaire seulement. Une annulation écrit un mouvement inverse : rien n'est
jamais supprimé, l'historique reste vrai.

**Apogée.** Une fourchette de buvabilité est estimée par règles pour chaque vin
millésimé, **recalculée à la lecture** (jamais stockée, donc jamais périmée) :
`[millésime + garde min × f ; millésime + garde max × f]`, où la garde vient,
par ordre de priorité, d'un ajustement pour l'appellation et la couleur, du cas
particulier des rosés (1 à 3 ans), d'un ajustement pour l'appellation entière,
ou de la garde du référentiel ; le facteur `f` vaut 1,2 pour un grand
millésime, 0,85 pour un millésime faible et **1,0 par défaut** (millésime
« moyen », tant qu'il n'a pas été qualifié). La fiche vin affiche la fourchette,
un badge de confiance (*Saisie* en cas de correction manuelle, *Confiance
moyenne* si le millésime est qualifié, *Confiance faible* sinon) et un statut
(« Trop jeune », « À boire », « À boire vite », « Apogée passée depuis… ») ;
quand aucune estimation n'est possible (vin non millésimé, appellation non
reconnue, garde inconnue), la raison s'affiche avec une saisie manuelle
proposée. *Corriger* permet au propriétaire de la cave de fixer deux années,
qui priment alors toujours sur les règles ; *Revenir à l'estimation* efface la
correction. L'onglet *Cave* porte une mention courte par ligne (« À boire
2024-2036 », « Trop jeune (2027) », « À boire vite », « Apogée passée »).
Réservée aux administrateurs, l'**administration des règles** (espace
Administration) permet de qualifier le millésime d'une région (grand / moyen /
faible) et d'ajuster la garde d'une appellation (pour toutes les couleurs ou
une seule) ; les changements s'appliquent immédiatement partout, sur toutes
les fiches concernées, dans toutes les caves.

**À boire en priorité.** Dans l'onglet *Cave*, la case *À boire en priorité*
ne garde que les vins dont l'apogée se termine **au plus tard l'an prochain**
(apogée passée, dernière année, ou fin l'an prochain — l'année de marge laisse
le temps de prévoir l'occasion), la fin la plus proche en premier, puis par
producteur. Une correction manuelle de l'apogée compte comme l'estimation. Les
vins sans estimation n'y figurent jamais, mais ne sont pas oubliés : un bandeau
« N vins sans apogée estimée » mène, par *À compléter*, à la case *Sans
apogée*, qui les liste pour qu'on saisisse leur fourchette depuis la fiche. Les
deux cases s'excluent ; elles se combinent avec la recherche, la couleur et les
vins épuisés. Côté API : `GET /api/cave?drinkSoon=true` et
`GET /api/cave?noApogee=true`.

**Mesure « zéro saisie ».** Chaque entrée par photo (en rafale, ou saisie à la
main après une lecture impossible) garde la fiche telle qu'elle a été
confirmée. L'espace
Administration affiche, pour les administrateurs, la section *Qualité de la
lecture* : la part des champs corrigés à la main sur les 90 derniers jours
(objectif du cahier des charges : moins de 15 %), avec le détail par champ
(producteur, cuvée, appellation, millésime, couleur, format) pour voir lequel
la lecture rate le plus. Un champ est corrigé quand la valeur confirmée
diffère de celle que l'écran avait pré-remplie : espaces autour ignorés,
majuscules et accents comptés, valeurs par défaut gardées (rouge, 75 cl) non
comptées. Une photo dont l'analyse a échoué compte pour tout ce qui a été
saisi. API : `GET /api/admin/reading-quality`.

**Statistiques.** Le 5e onglet *Stats* ouvre une page calculée à chaque
lecture (`GET /api/stats`, propriétaire et membres de la cave) : bouteilles,
références et **valeur au prix d'achat** (propriétaire seulement) (stock × dernier prix d'achat saisi, la même règle
que l'export ; « sur N des M références » quand des prix manquent, « Aucun prix
d'achat saisi » quand aucun prix n'est connu) ; répartition du stock par
**apogée** (les barres *À boire vite*, *Passée* et *Sans estimation* ouvrent
l'onglet Cave déjà filtré ; l'onglet Cave affiche alors toute la liste « à
boire en priorité », apogée finie au plus tard l'an prochain, qui peut compter
plus de bouteilles que la barre), par **couleur**, par **région** (8 premières
puis *Autres*) et par **décennie
de millésime** ; **mouvements sur 12 mois** (entrées et sorties par mois, heure
de Paris ; annulations et inventaires exclus), avec le rythme moyen de
consommation et la durée de cave qu'il donne ; et quatre **classements** : les
vins les plus bus sur 12 mois, les producteurs les plus présents, les
bouteilles les plus chères au prix d'achat (propriétaire seulement) et les
mieux notés. Pour un membre, la valeur au prix d'achat et « les plus chères »
sont absentes : la page n'affiche que le reste.

**Note de dégustation.** Sur la fiche d'un vin, le bloc *Ma note* permet au
propriétaire de la cave de noter le vin **sur 20, par demi-point** (« 16,5 » ou
« 16.5 » acceptés) ; la note remplace la précédente et peut être retirée. Elle
s'affiche avec sa date et son auteur (un membre voit le nom affiché de
l'auteur, jamais son adresse e-mail), sur la ligne du vin dans l'onglet Cave,
dans la colonne *Note /20* de l'export Excel et dans le classement *Les mieux
notés* de la page Stats. API : `PUT` et `DELETE /api/wines/:id/rating`.

**Accords mets-vins.** Chaque vin reçoit, en tâche de fond, jusqu'à 8 plats
suggérés par Gemini (file `wine-pairing` du worker, à la création du vin et au
démarrage du worker pour les vins qui n'en ont pas encore — ce rattrapage au
démarrage génère les accords de tous les vins existants qui n'en ont pas,
pour une fraction de centime chacun). Comme pour les photos, une
indisponibilité de Gemini relance la génération plus tard sans rien bloquer,
et le plafond mensuel `GEMINI_MONTHLY_CAP_CENTS` compte photos et accords
ensemble ; les accords ne se génèrent que tant que la dépense du mois reste
sous 80 % de ce plafond, pour que les photos d'étiquette gardent toujours la
priorité. La fiche affiche les plats (« Suggestions générées par
Gemini »), « Suggestions en préparation… » en attendant, et, pour le propriétaire, *Régénérer*
(`POST /api/wines/:id/pairing/regenerate`) ; une génération qui échoue pour un
problème de configuration affiche « Génération impossible : configuration
Gemini à vérifier », et une réponse inexploitable « Réponse de Gemini
inexploitable ». Dans l'onglet Cave, le champ
**Accompagner un plat** garde les vins dont un plat suggéré contient les mots
tapés (sans accents ni majuscules), les bouteilles à boire en priorité en
premier, avec la mention « avec : … » (`GET /api/cave?dish=`). L'export ajoute
une colonne *Accords*.

**Descriptif du domaine.** Chaque domaine (producteur) reçoit un seul texte,
partagé par tous ses vins et millésimes, **dans toutes les caves**, généré en arrière-plan par Gemini (3
à 4 phrases : lieu, histoire, style) — même file `wine-pairing` et même part de
80 % du plafond mensuel que les accords mets-vins, déclenché à la création
d'un vin dont le domaine n'a pas encore de descriptif et, pour les domaines
déjà existants, au démarrage du worker. Quand Gemini n'a pas d'information
fiable sur un petit domaine, la fiche affiche « Domaine peu documenté » plutôt
qu'un texte inventé. Un descriptif généré par Gemini porte toujours la mention
« Généré par Gemini, peut contenir des erreurs ». Tout le monde le lit ;
**seuls les administrateurs l'écrivent** (403 « Réservé à l’administrateur »
pour les autres, propriétaires compris) : un texte saisi à la main
(2 000 caractères maximum) prend le pas sur celui de Gemini et le remplace
tant qu'on ne choisit pas *Revenir au texte généré*, qui relance une
génération ; *Régénérer* relance aussi une génération à tout moment. Le bloc
*Le domaine* s'affiche sur la fiche du vin, au-dessus des accords mets-vins.
API : `PUT /api/producers/:key/description`, `POST
/api/producers/:key/regenerate`, et `producerKey` / `producerProfile` ajoutés
à `GET /api/wines/:id`. Au tout premier démarrage du worker après cette mise à
jour, tous les domaines déjà existants sont mis en file un par un (la même
file que les accords) : les textes et les accords des vins déjà saisis
peuvent donc mettre quelques dizaines de minutes à apparaître cette première
fois-là.

**Export Excel.** Réservé au propriétaire de la cave : un classeur `.xlsx` à la demande, limité à la cave courante, régénéré intégralement à
chaque fois, avec trois feuilles (`Stock`, `Mouvements`, `Référence`), un filtre
optionnel par couleur et la case *Seulement les vins à boire en priorité*
(même règle et même ordre que l'onglet Cave ; `GET /api/export.xlsx?drinkSoon=true`). La feuille `Stock` ajoute *Apogée min*, *Apogée max* et
*Confiance* après *Millésime*, puis *Note /20* après *Confiance* et *Accords*
en dernière colonne ; une ligne dont l'apogée est déjà passée est
mise en évidence par une teinte d'alerte.

**Garde-fous.** Stock jamais négatif (contrainte en base), **même sous
concurrence** : le déclencheur verrouille désormais la ligne du vin avant de
vérifier le stock, pour qu'une sortie simultanée des dernières bouteilles ne
puisse pas en laisser passer deux à la fois. Le stock affiché est **calculé à
chaque lecture** à partir du journal (vue `stock_courant`) : deux mouvements
simultanés ne peuvent plus en faire disparaître un. Journal en ajout seul,
idempotence de bout en bout (empreinte de contenu par photo, clé d'idempotence par
mouvement, un seul mouvement d'entrée par photo **et une seule sortie par
photo**, une clé d'idempotence déjà utilisée par un autre mouvement est
refusée plutôt que rejouée comme une sortie), inventaire physique sous verrou
de ligne (deux inventaires simultanés n'écrivent l'écart qu'une fois), et
plafond mensuel de dépense pour l'API de vision. Le serveur télécharge
désormais aussi des images tierces pour « Chercher une image » : adresses
http(s) publiques seulement (résolution DNS vérifiée, adresses privées,
de bouclage et locales refusées), redirections limitées et revérifiées, taille
et délai bornés.

**Comptes et administration.** Toute adresse Google peut demander l'accès ;
le compte reste **en attente** jusqu'à ce qu'un administrateur le valide. Les
adresses de `ADMIN_EMAILS` sont actives et administratrices dès leur première
connexion, et une adresse invitée par un propriétaire est active d'emblée,
en lecture seule sur la cave qui l'a invitée. L'espace `/admin` (lien sur
l'accueil) réunit, pour les administrateurs :

- **Inscriptions** (en tête) : les comptes en attente (nom, e-mail, date
  d'inscription), avec *Valider* — le compte devient actif et reçoit sa cave,
  « Cave de {nom affiché ou e-mail} », dont il est propriétaire — et
  *Refuser* — le compte est bloqué.
- **Comptes** : liste des comptes, blocage/réactivation,
  promotion/retrait des droits d'administration, et *Créer sa cave* pour un
  compte actif qui n'en a pas (un invité qui veut aussi sa propre cave, ou un
  administrateur). Un compte n'est propriétaire que d'une seule cave.
- **Budget** : la dépense Gemini du mois et la **part maximale par cave**
  (20 % du plafond mensuel `GEMINI_MONTHLY_CAP_CENTS` par défaut, réglable de
  0 à 100 %). Une cave qui a atteint sa part voit ses analyses reportées avec
  le motif « Part mensuelle de cette cave atteinte — reprise le mois
  prochain », comme pour le plafond global. **La cave de l'administrateur
  principal** (le plus ancien administrateur qui n'est pas le compte de
  secours) **n'est pas limitée** ; le plafond global, lui, vaut pour tous.
  Les caves invitées (toutes les autres) ont aussi une **part maximale
  ensemble** (60 % par défaut, réglable de 0 à 100 %) : quel que soit leur
  nombre, elles laissent au moins le reste du plafond à la cave principale
  (motif « Part mensuelle des caves invitées atteinte — reprise le mois
  prochain »).
  Les accords mets-vins et les descriptifs de domaine ne sont soumis à
  aucune part, seulement au plafond global.
- **Qualité de la lecture** et **règles d'apogée** (voir plus haut).

Les **membres** d'une cave se gèrent, eux, par son propriétaire, depuis
l'écran *Membres de la cave* (voir *Membres en lecture seule*).

`ADMIN_EMAILS` est un **plancher garanti, jamais un plafond** : une adresse qui
y figure est administratrice même si la base dit le contraire (le propriétaire
ne peut jamais s'enfermer dehors), et ces comptes-là ne sont ni blocables ni
rétrogradables depuis `/admin` — seul le `.env` le peut. À l'inverse, une
promotion accordée depuis l'interface à un compte absent d'`ADMIN_EMAILS` est
durable : elle survit aux connexions suivantes, jamais écrasée par
l'environnement. Un administrateur ne peut pas non plus modifier son propre
compte, pour ne jamais perdre l'accès à l'administration par erreur. Un
blocage prend effet dès la requête suivante, y compris sur une session déjà
ouverte : il n'attend pas une prochaine connexion. Être administrateur ne
donne accès à aucune cave en particulier : un administrateur voit sa propre
cave et celles où il est invité, comme tout compte.

## Architecture et ports

| Service | Rôle | Port | Exposition |
| --- | --- | --- | --- |
| `web` | nginx + PWA compilée, relaie `/api/` | **3100** sur l'hôte → 80 | **seul port publié** (`WEB_PORT`) |
| `api` | REST, authentification, règles métier, export | 3000 | réseau Docker interne |
| `worker` | extraction Gemini via BullMQ (sorties, accords) ; analyse des entrées par lots toutes les 15 s | — | réseau Docker interne |
| `postgres` | données (PostgreSQL 16 + `pg_trgm`) | 5432 | réseau Docker interne |
| `redis` | file de travaux et sessions | 6379 | réseau Docker interne |
| `db-backup` | `pg_dump` quotidien avec rotation | — | réseau Docker interne |

Seul le port `3100` est joint par Nginx Proxy Manager, qui termine TLS et garde
80/443. Aucune autre ouverture n'est nécessaire sur la box.

## Déploiement

### 1. Préparer l'hôte

Une VM ou un LXC avec 2 vCPU, 4 Go de RAM et 40 Go de disque suffit. Docker et le
plugin Compose installés ; le Nginx Proxy Manager existant doit pouvoir joindre
cette machine sur le réseau local.

### 2. Créer la stack

La stack est **autonome** : le `docker-compose.yml` et son `.env` suffisent,
aucun autre fichier du dépôt n'est nécessaire sur l'hôte (les images portent le
code, et le script de sauvegarde est écrit dans le YAML lui-même). L'intégration
continue le vérifie à chaque commit en démarrant la stack dans un dossier qui ne
contient que ces deux fichiers.

**Avec Dockge** (le cas de ce serveur) : créer une stack `cave-a-vin`, coller le
contenu de [`docker-compose.yml`](docker-compose.yml) dans l'éditeur et celui du
`.env` (étape 4) dans le panneau des variables. Dockge range la stack dans
`/opt/stacks/cave-a-vin/`.

**En ligne de commande**, l'équivalent :

```bash
mkdir -p /opt/stacks/cave-a-vin && cd /opt/stacks/cave-a-vin
curl -fsSLO https://raw.githubusercontent.com/djkix/cave-a-vin/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/djkix/cave-a-vin/main/.env.example
```

Les sauvegardes sont écrites dans `./backups`, à côté du YAML.

### 3. Créer le client OAuth Google

Dans la console Google Cloud, avec le compte qui possédera l'application :

1. Créer ou choisir un projet (<https://console.cloud.google.com/projectcreate>).
2. **Google Auth Platform** (<https://console.cloud.google.com/auth/overview>) :
   nom de l'application, adresse de support, **audience External**, puis
   **Publish app**. Les scopes demandés se limitent à `openid`,
   `userinfo.email` et `userinfo.profile` : ce périmètre est exempté de
   vérification par Google, il n'y a donc aucune démarche à faire.
3. **Clients → Create client** (<https://console.cloud.google.com/auth/clients>),
   type **Application Web**, avec cet URI de redirection autorisé :
   `https://cave.djkix.ovh/api/auth/google/callback`
   (aucune origine JavaScript n'est nécessaire, le flux est côté serveur).
4. Relever le **Client ID** et le **Client secret**. Le secret ne se réaffiche
   pas : s'il est perdu, en créer un nouveau depuis la fiche du client.

**Règle ferme** : aucun autre scope ne doit jamais être demandé à ce client.
L'export étant un simple téléchargement, l'application n'a besoin d'aucun accès
à Drive ni à Sheets.

### 4. Renseigner le `.env`

```bash
cd /opt/stacks/cave-a-vin && nano .env
```

Générer les deux secrets :

```bash
openssl rand -hex 24
```

```bash
openssl rand -hex 32
```

| Variable | Valeur attendue |
| --- | --- |
| `WEB_PORT` | port publié sur l'hôte (défaut `3100`), cible du proxy |
| `IMAGE_TAG` | `latest`, ou un numéro de version (`1.0.0`) pour figer le déploiement |
| `POSTGRES_USER` / `POSTGRES_DB` | `cave` / `cave` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `SESSION_SECRET` | `openssl rand -hex 32` — 32 caractères minimum, l'api refuse de démarrer en dessous |
| `WEB_ORIGIN` | `https://cave.djkix.ovh` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | valeurs de l'étape 3 |
| `GOOGLE_CALLBACK_URL` | `https://cave.djkix.ovh/api/auth/google/callback`, **identique** à l'URI déclaré chez Google |
| `BREAK_GLASS_EMAIL` / `BREAK_GLASS_PASSWORD` | compte local de secours (mot de passe de 12 caractères minimum) ; laisser vide pour n'en créer aucun |
| `ADMIN_EMAILS` | adresses administratrices, séparées par des virgules, en minuscules ; seule façon de désigner un administrateur (voir étape 7) |
| `GEMINI_API_KEY` | clé Google AI Studio |
| `GEMINI_MODEL` | `gemini-3.5-flash` |
| `GEMINI_MONTHLY_CAP_CENTS` | plafond mensuel approximatif en centimes (`500` = ~5 €) |
| `BACKUP_DIR` / `BACKUP_RETENTION_DAYS` / `BACKUP_INTERVAL_SECONDS` | sauvegardes : répertoire, rétention, intervalle |

Le `.env` n'est jamais commité et n'entre jamais dans une image.

### 5. Récupérer les images

Les paquets GHCR sont privés par défaut, même si le dépôt est public. Soit
s'authentifier avec un jeton personnel disposant de `read:packages` :

```bash
echo <PAT> | docker login ghcr.io -u djkix --password-stdin
```

```bash
cd /opt/stacks/cave-a-vin && docker compose pull
```

… soit construire les images sur place, ce qui évite toute authentification.
C'est le seul cas où le dépôt complet est nécessaire sur l'hôte, puisque la
construction part des sources :

```bash
git clone https://github.com/djkix/cave-a-vin.git /opt/stacks/cave-a-vin-src
cd /opt/stacks/cave-a-vin-src && docker compose build
```

### 6. Démarrer

```bash
cd /opt/stacks/cave-a-vin && docker compose up -d
```

Le conteneur `api` applique les migrations Prisma puis charge le référentiel des
appellations au démarrage — les deux opérations sont idempotentes et se rejouent
sans risque à chaque redémarrage. Vérification :

```bash
curl -s http://localhost:3100/api/health
```

La réponse attendue est `{"status":"ok"}`. En cas d'échec :
`docker compose logs api --tail 50`.

### 7. Désigner un administrateur

Le sous-domaine est public : n'importe quel titulaire d'un compte Google peut
se connecter, mais son compte reste **en attente de validation** et ne voit
rien tant qu'un administrateur ne l'a pas validé depuis la section
*Inscriptions* de `/admin` (ce qui lui crée sa cave). Seules les adresses
d'`ADMIN_EMAILS` et celles qu'un propriétaire a invitées entrent directement.

La seule façon de désigner un administrateur est la variable `ADMIN_EMAILS` du
`.env` (adresses séparées par des virgules, en minuscules) : au moins la vôtre,
pour pouvoir ouvrir l'espace d'administration après le premier déploiement.
C'est un plancher garanti, pas un plafond : un compte listé ici reste
administrateur quoi qu'il arrive et **ne peut pas être bloqué ni rétrogradé
depuis `/admin`** (l'interface refuse l'action) — seule une modification de ce
fichier le peut. À l'inverse, promouvoir depuis `/admin` un compte qui n'est
pas dans `ADMIN_EMAILS` reste valable durablement, connexion après connexion.

```bash
ADMIN_EMAILS=vous@gmail.com
```

Une fois connecté avec cette adresse, l'espace **Administration** (lien sur
l'accueil, ou `/admin`) valide ou refuse les inscriptions, liste tous les
comptes créés et permet de bloquer un compte indésirable, de le réactiver, de
promouvoir/retirer d'autres administrateurs, de créer la cave d'un compte qui
n'en a pas et de régler la part de budget par cave. Un administrateur ne peut
pas modifier son propre compte. Sur une installation neuve, le premier
administrateur n'a pas encore de cave : *Créer sa cave* sur sa propre ligne
la lui crée.

### 8. Configurer Nginx Proxy Manager

**Proxy Hosts → Add Proxy Host** :

- *Domain Names* : `cave.djkix.ovh`
- *Scheme* : `http` · *Forward Hostname / IP* : IP de la VM Docker · *Forward Port* : `3100`
- *Websockets Support* et *Block Common Exploits* activés
- Onglet **SSL** : certificat Let's Encrypt, *Force SSL* et HTTP/2 activés

NPM envoie `X-Forwarded-Proto: https`, que le nginx interne relaie tel quel :
c'est ce qui permet au cookie de session `Secure` d'être posé. **Ne pas** ajouter
`proxy_set_header X-Forwarded-Proto $scheme;` dans la configuration avancée de
NPM, sinon l'en-tête est réécrit en `http` et la connexion boucle indéfiniment.

### 9. Installer la PWA et vérifier

1. Ouvrir <https://cave.djkix.ovh/> : l'écran de connexion s'affiche.
2. « Se connecter avec Google » puis rentrer une bouteille avec une vraie photo
   d'étiquette : la fiche doit arriver dans « À confirmer » en moins d'une
   minute.
3. **Journal → Exporter le classeur** : la bouteille figure dans la feuille
   `Stock`.
4. Sur iPhone : *Partager → Sur l'écran d'accueil*. Sur Android : bannière
   d'installation. L'icône est un verre de vin sur fond bordeaux
   (`web/public/icons/icon.svg`, déclinée en PNG 192, 512, « maskable » pour
   Android et 180 pour iOS). Un raccourci installé avant la 1.9.0 garde l'ancien
   carré brun : le supprimer de l'écran d'accueil puis le réinstaller.

## Mise à jour

Les images sont republiées automatiquement à chaque fusion sur `main`.

```bash
cd /opt/stacks/cave-a-vin && docker compose pull && docker compose up -d
```

Si les images sont construites localement, remplacer `docker compose pull` par
`docker compose build`. Pour figer une version plutôt que suivre `latest`,
fusionner la demande de version proposée par release-please puis renseigner
`IMAGE_TAG=<version>` dans le `.env`.

### Passage à la 2.0.0 (une cave par compte)

La 2.0.0 change le fonctionnement pour tous les comptes. **Vérifier d'abord
les comptes**, avant la mise à jour :

```bash
cd /opt/stacks/cave-a-vin && docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT email, is_admin, is_break_glass, status FROM app_user ORDER BY created_at;"'
```

Votre adresse Google doit apparaître avec `is_admin` = `t` et le statut
`ACTIVE`. Sinon, connectez-vous une fois avec Google avant de mettre à jour
(`ADMIN_EMAILS` pose `is_admin` à la connexion) : c'est ce compte qui recevra
la cave existante.

**Faire ensuite une sauvegarde de la base**, juste avant la mise à jour, sans
attendre le dump quotidien de `db-backup` :

```bash
cd /opt/stacks/cave-a-vin && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' | gzip > backups/cave-avant-2.0.0.sql.gz
```

Vérifier que le fichier n'est pas vide (`ls -la backups/`) ; il se restaure
comme les dumps quotidiens (voir *Sauvegarde et restauration*). Puis mettre à
jour comme d'habitude. Au démarrage, la migration, en une seule transaction :

- crée une cave **« Cave de {nom} »** appartenant au premier administrateur
  (le plus ancien compte administrateur actif qui n'est pas le compte de
  secours, sinon le compte de secours) et y rattache toutes les données
  existantes : vins, mouvements, photos, exports (si la base contient des
  données mais aucun compte, la cave attend son propriétaire : le premier
  administrateur qui se connecte la reçoit) ;
- fait des **autres comptes actifs des membres** de cette cave, **en lecture
  seule** (les comptes bloqués n'y sont pas ajoutés) : ils ne voient plus les
  prix d'achat et ne peuvent plus rien écrire. Pour qu'un de ces comptes
  retrouve une cave où il écrit, un administrateur lui crée la sienne
  (*Créer sa cave*) ;
- règle la part de budget par cave à 20 %.

**Compte de secours** : la migration l'inscrit comme membre de votre cave,
mais depuis la 2.1.0 il y a les droits du propriétaire (entrées, sorties,
journal, prix) : pendant une panne de Google, il permet de continuer à tenir
la cave.

Aucune variable d'environnement n'est ajoutée. Après la mise à jour, les
nouvelles adresses Google qui se connectent attendent une validation dans
*Inscriptions*.

Vérifier après la mise à jour que la cave appartient bien à votre adresse
Google :

```bash
cd /opt/stacks/cave-a-vin && docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT c.name, u.email FROM cave c LEFT JOIN app_user u ON u.id = c.owner_id;"'
```

**Retour arrière** : le schéma de la 1.9.0 ne sait pas lire la base migrée,
il faut donc restaurer la sauvegarde prise juste avant la mise à jour. Les
tables propres à la 2.0.0 (`cave`, `cave_member`, `app_setting`) ne figurent
pas dans cette sauvegarde et bloqueraient sa restauration : on vide d'abord le
schéma. Arrêter l'api et le worker, vider le schéma, restaurer, remettre
`IMAGE_TAG=1.9.0` dans le `.env`, puis relancer :

```bash
cd /opt/stacks/cave-a-vin && docker compose stop api worker
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
gunzip -c backups/cave-avant-2.0.0.sql.gz | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose up -d
```

## Sauvegarde et restauration

`db-backup` dépose un `pg_dump` compressé chaque jour dans `BACKUP_DIR`
(rétention 30 jours par défaut). Le nom définitif n'apparaît qu'une fois le dump
**et** la compression réussis : un fichier `cave-*.sql.gz` est donc toujours
complet. Les dumps utilisent `--clean --if-exists`, ils se restaurent par-dessus
un schéma existant.

Pour vérifier que la sauvegarde tourne vraiment — le conteneur annonce son
réglage au démarrage puis chaque dump écrit :

```bash
cd /opt/stacks/cave-a-vin && docker compose logs db-backup --tail=5 && ls -la backups/
```

Restauration :

```bash
cd /opt/stacks/cave-a-vin && gunzip -c backups/cave-<date>.sql.gz | docker compose exec -T postgres psql -U cave -d cave
```

Les photos vivent dans le volume `photo_data` : à synchroniser vers le NAS chaque
semaine, elles ne sont pas couvertes par ce conteneur. Une sauvegarde jamais
restaurée n'étant pas une sauvegarde, prévoir un test de restauration
trimestriel.

## Développement

```bash
docker run -d --name cave-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=cave -p 5432:5432 postgres:16-alpine
```

```bash
docker run -d --name cave-redis -p 6379:6379 redis:7-alpine
```

```bash
cd api && npm ci && npx prisma migrate deploy && npm run seed && npm run start:dev
```

```bash
cd api && npm run start:worker:dev
```

```bash
cd web && npm ci && npm run dev
```

Tests : `cd api && npm test` (les suites qui touchent la base s'activent quand
`DATABASE_URL` est défini) et `cd web && npm test`.

Les index uniques partiels (`idx_movement_reverses_id`,
`idx_movement_photo_in`, `idx_movement_photo_out`, `idx_guard_override_all_colors`,
`idx_guard_override_color`) et la fonction de déclencheur
`check_stock_non_negative` ne sont pas exprimables dans le schéma Prisma :
créer les futures migrations avec `npx prisma migrate dev --create-only` et
conserver ce SQL écrit à la main, sinon Prisma proposera de le supprimer.

## Limites

- **Un membre ne peut rien écrire** : la lecture seule est le seul rôle
  d'invité, il n'existe pas de membre qui rentre ou sort des bouteilles dans
  la cave d'un autre. Une cave n'a qu'un propriétaire, et la propriété ne se
  transfère pas depuis l'interface.
- **Une seule cave possédée par compte** : un compte peut être membre de
  plusieurs caves, mais n'est propriétaire que d'une. Une cave ne se supprime
  pas depuis l'interface.
- **Descriptifs de domaine communs à toutes les caves** : un seul texte par
  domaine, écrit ou régénéré par un administrateur seulement ; un propriétaire
  ne peut pas avoir sa propre version. Il en va de même du référentiel des
  appellations et des règles d'apogée.
- **Pas d'e-mail** : ni l'inscription validée, ni l'invitation ne sont
  annoncées par e-mail ; la personne invitée se connecte simplement avec
  l'adresse invitée.
- **Mesure « zéro saisie » à partir de la 1.5.0** : les entrées antérieures
  n'ont pas gardé leur fiche confirmée et ne comptent pas. Une entrée confirmée
  avant la fin de l'analyse est comparée à un formulaire vide : la lecture
  arrivée ensuite n'a pas été montrée.
- **Statistiques au prix d'achat seulement** : la valeur au prix du marché et
  l'écart achat / marché attendent la cote iDealwine (lot 2c, reporté). La
  fenêtre des mouvements est fixe (12 mois).
- **Accords suggérés, jamais saisis** : les plats viennent de Gemini et ne se
  corrigent pas un à un (seulement *Régénérer*) ; aucun accord « vécu » n'est
  enregistré. Une régénération remplace le coût de la précédente dans le
  plafond du mois. Si le plafond mensuel est atteint tôt dans le mois, un
  accord peut épuiser ses tentatives avant le changement de mois et rester
  « indisponible » — utiliser alors *Régénérer* le mois suivant.
- **Une seule note par vin**, sans commentaire ni historique.
- **Descriptif du domaine limité par ce que Gemini sait** : pour un petit
  domaine, la connaissance de Gemini est parfois incomplète ou erronée — d'où
  le disclaimer et la possibilité de saisir un texte manuel. Un seul texte par
  domaine, partagé par clé d'orthographe (accents et casse ignorés) : deux
  producteurs réellement distincts mais portant le même nom partagent le même
  descriptif.
- **Référentiel des appellations** : 145 AOC sont chargées au démarrage (sur
  environ 360 reconnues par l'INAO). Une appellation absente du référentiel est
  conservée telle qu'elle a été lue ou saisie ; seule une correspondance quasi
  exacte (similarité ≥ 0,8) réécrit le libellé avec le nom canonique.
- **`GEMINI_MONTHLY_CAP_CENTS` est un plafond approximatif** : le coût par appel
  est une estimation à l'ordre de grandeur, pas une facturation réelle. Le
  réglage se comporte donc comme un nombre maximum de photos par mois.
- **Compte de secours** : `BREAK_GLASS_EMAIL` / `BREAK_GLASS_PASSWORD` vides =
  connexion Google uniquement. Le compte de secours a les droits du
  propriétaire sur la cave de l'administrateur principal (le plus ancien
  administrateur actif qui n'est pas le compte de secours), quelle que soit
  sa ligne de membre : pendant une panne de Google, il permet de saisir
  entrées et sorties. Il n'a pas d'autre droit sur les autres caves.
- **Blocage de compte manuel** : il n'y a pas de modération automatique ; un
  administrateur doit bloquer un compte indésirable depuis `/admin`. Le blocage
  prend effet dès la requête suivante (la session en cours cesse de
  fonctionner), il n'attend pas une prochaine connexion.
- **Réessai borné dans le temps** : une photo reportée est reprise pendant
  environ dix jours (1 000 tentatives au plafond de 15 minutes). Au-delà, elle
  passe en échec et attend une saisie manuelle — un travail qui ne meurt jamais
  finirait par masquer une panne réelle. Seule exception : un report pour
  budget (plafond mensuel ou part de la cave atteints) est repris sans limite,
  toutes les 15 minutes, et ne passe jamais en échec.
- **Pas de relance manuelle d'une analyse** : il n'y a pas de bouton
  « réanalyser » sur une photo en échec définitif ; la saisie manuelle prend le
  relais, et reprendre la photo crée simplement une nouvelle entrée.
- **La reconnaissance ne départage pas seule deux millésimes** quand l'année
  n'est pas lisible sur l'étiquette : la sortie par photo propose alors le
  choix sur vignettes plutôt que de deviner.
- **Qualité des millésimes non pré-remplie** : tant qu'une région n'a pas été
  qualifiée depuis l'administration, tous ses millésimes comptent pour
  « moyen » (facteur 1,0).
- **Pas d'estimation d'apogée pour les vins non millésimés** : la fiche
  l'indique et ne propose que la saisie manuelle.
- **Pas d'alerte hors de l'application** : la liste « à boire en priorité » se
  consulte, elle ne prévient pas (choix assumé). **Emplacements dans la cave**
  et **cote iDealwine** : reportés, chacun dans un lot séparé.
- **Après « Annuler »**, le panneau de sortie de la fiche vin reste sur
  « Sortie annulée » jusqu'à ce qu'on quitte la page (pas de retour
  automatique à l'écran de sortie).
- **Envoi des photos d'entrée seulement application ouverte** : l'envoyeur en
  arrière-plan tourne tant que l'onglet ou la PWA est ouvert, il n'y a pas de
  synchronisation en arrière-plan une fois l'application fermée — les photos
  prises partent dès la réouverture.
- **Analyse par lot plus lente qu'une analyse unitaire** : le résultat met en
  général de 15 s à 1 min à apparaître dans « À confirmer », le temps qu'un lot
  se forme (8 photos, ou 45 s d'attente) puis soit traité par le passage
  suivant du worker (toutes les 15 s).
- **L'écran de confirmation par photo subsiste uniquement pour la saisie
  manuelle** d'une photo en « Lecture impossible » ; la rafale et « À
  confirmer » ne l'utilisent plus pour le flux normal.
- **Pas de notification temps réel pour les entrées** : contrairement à la
  sortie par photo, la liste « À confirmer » ne suit pas l'avancement de
  l'analyse par flux SSE, elle se rafraîchit toutes les 10 s.
- **Open Food Facts connaît rarement les petits domaines** : la recherche
  d'image n'y trouve souvent rien pour une cave de particuliers, et passe au
  site officiel.
- **Le site officiel montre souvent la gamme ou le domaine plutôt que
  l'étiquette exacte du millésime** : l'image trouvée ressemble à la bouteille
  sans forcément être le même millésime.
- **Les images trouvées sur le web appartiennent à leurs auteurs** : usage
  raisonnable pour une cave privée, la source reste toujours affichée et
  citée.
- **La version d'affichage d'une photo n'est pas refabriquée** si la photo est
  analysée de nouveau plus tard : elle garde le cadrage de la première
  lecture.

## Journal des modifications

Le détail par version, avec le lien vers chaque commit, est dans
[`CHANGELOG.md`](CHANGELOG.md) ; voici les versions publiées.

### 2.0.1 — 7 octobre 2026

Publiée ([v2.0.1](https://github.com/djkix/cave-a-vin/releases/tag/v2.0.1)),
images `ghcr.io/djkix/cave-a-vin-api:2.0.1` et `-web:2.0.1`.

**Prêt pour les prochains modèles Gemini.** Les appels à Gemini n'envoient plus
de température, que les prochains modèles refuseront. Rien à faire de plus
qu'une mise à jour habituelle (passer d'abord par la 2.0.0 et sa sauvegarde).

### 2.0.0 — 7 octobre 2026

Publiée ([v2.0.0](https://github.com/djkix/cave-a-vin/releases/tag/v2.0.0)),
images `ghcr.io/djkix/cave-a-vin-api:2.0.0` et `-web:2.0.0`.

**Une cave par compte.** Inscriptions Google validées par l'administrateur,
membres invités en lecture seule (sans prix, journal ni export), sélecteur de
cave, part du budget Gemini par cave. **Sauvegarder la base avant la mise à
jour** et suivre « Passage à la 2.0.0 » : la migration
`20261012000000_multi_caves` est sans retour.

### 1.9.0 — 7 octobre 2026

Publiée ([v1.9.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.9.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.9.0` et `-web:1.9.0`.

**Icône, photos plus nettes et image trouvée sur le web.** L'application a son
icône (un verre de vin sur fond bordeaux) ; les vignettes sont recadrées sur
l'étiquette et retouchées avec douceur ; « Chercher une image » propose
l'étiquette d'Open Food Facts ou du site officiel du domaine, au choix.
Migration `20261011000000_image_reference`.

### 1.8.0 — 6 octobre 2026

Publiée ([v1.8.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.8.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.8.0` et `-web:1.8.0`.

**Descriptif du domaine.** Un bloc « Le domaine » sur chaque fiche vin : 3 à
4 phrases par producteur rédigées par Gemini en tâche de fond (« Domaine peu
documenté » quand il ne sait pas), modifiables à la main. Migration
`20261010000000_descriptif_domaine` ; au premier démarrage du worker, tous les
domaines existants sont mis en file.

### 1.7.0 — 6 octobre 2026

Publiée ([v1.7.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.7.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.7.0` et `-web:1.7.0`.

**Entrée en rafale, note de dégustation et accords mets-vins.** On photographie
les bouteilles à la suite sans attendre : envoi en arrière-plan, lecture par
lots de huit au plus par appel Gemini, confirmation dans « À confirmer » (badge
sur l'accueil) ; le mode campagne disparaît. Note sur 20 par vin, et plats
suggérés par Gemini avec la recherche « Accompagner un plat ». Migrations
`20261008000000_note_degustation`, `20261008000001_accords_mets_vins` et
`20261009000000_entree_par_lot`, appliquées au démarrage de l'api.

### 1.6.0 — 5 octobre 2026

Publiée ([v1.6.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.6.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.6.0` et `-web:1.6.0`.

**Statistiques.** Un 5e onglet *Stats* : valeur de la cave au prix d'achat,
répartition par apogée, couleur, région et millésime, mouvements sur 12 mois
avec le rythme de consommation, et trois classements. Correction : l'export
Excel ignore désormais le prix d'une entrée annulée, comme les statistiques.
Ni migration ni nouvelle variable d'environnement.

### 1.5.0 — 5 octobre 2026

Publiée ([v1.5.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.5.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.5.0` et `-web:1.5.0`.

**Mesure « zéro saisie ».** L'Administration affiche la part des champs
corrigés à la main à l'entrée par photo sur 90 jours, par rapport à l'objectif
de 15 %, avec le détail par champ. Correction : la fiche d'une photo déjà lue
se pré-remplit même si le flux temps réel se coupe. Migration
`20261007000000_zero_saisie`.

### 1.4.1 — 5 octobre 2026

Publiée ([v1.4.1](https://github.com/djkix/cave-a-vin/releases/tag/v1.4.1)),
images `ghcr.io/djkix/cave-a-vin-api:1.4.1` et `-web:1.4.1`.

**Le stock ne perd plus de mouvement quand deux se croisent.** La vue
`stock_courant` est désormais calculée à chaque lecture au lieu d'être
rafraîchie après chaque mouvement. Migration
`20261006000000_stock_vue_simple` ; le stock se recalcule depuis le journal à
la mise à jour, rien à recompter.

### 1.4.0 — 5 octobre 2026

Publiée ([v1.4.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.4.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.4.0` et `-web:1.4.0`.

**À boire en priorité.** Dans l'onglet Cave, la case *À boire en priorité*
garde les vins dont l'apogée se termine au plus tard l'an prochain, la fin la
plus proche en premier ; la case *Sans apogée* liste les vins sans estimation,
signalés par un bandeau « N vins sans apogée estimée — À compléter ». L'export
Excel propose *Seulement les vins à boire en priorité*. Ni migration ni
nouvelle variable d'environnement.

### 1.3.0 — 4 octobre 2026

Publiée ([v1.3.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.3.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.3.0` et `-web:1.3.0`.

**L'apogée : une fourchette de buvabilité estimée par règles, recalculée à
chaque lecture.** Fiche vin (fourchette, confiance, statut, correction
manuelle par vin qui prime toujours), mention courte dans l'onglet Cave,
colonnes *Apogée min*, *Apogée max* et *Confiance* dans l'export Excel (apogées
passées mises en évidence), administration réservée aux administrateurs pour
qualifier le millésime d'une région et ajuster la garde d'une appellation
(l'écran rappelle que les rosés se gardent 1 à 3 ans sauf ajustement « Rosé »,
qu'un ajustement « Toutes couleurs » ne s'applique pas à eux).
Migration `20261005000000_lot2b_apogee` (tables `vintage_quality`,
`guard_override`).

### 1.2.0 — 4 octobre 2026

Publiée ([v1.2.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.2.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.2.0` et `-web:1.2.0`.

**Le lot 2a boucle le cycle du stock : on peut désormais sortir ce qu'on a
rentré.** Onglet *Cave* (recherche sans accents, filtre couleur, vins
épuisés) ; fiche vin (photo de référence, stock, derniers mouvements, sortie
par quantité, inventaire physique avec écart annoncé) ; sortie par photo
restreinte aux vins en stock, avec choix sur vignettes quand plusieurs
millésimes sont proches et repli sur la cave en cas d'échec ou au bout de
12 s ; photos de sortie jamais reportées. Correction : le déclencheur « stock
jamais négatif » verrouille désormais la ligne du vin, deux sorties
simultanées de la dernière bouteille ne passent plus toutes les deux. Une
photo de sortie réutilisée après une annulation sort bien le vin choisi
ensuite ; réutilisée pour un autre vin sans annulation, elle est refusée en
clair. Une sortie rejouée par le serveur s'annonce « Déjà sortie — il en reste
N ». Le résultat et *Annuler* restent affichés après la sortie de la dernière
bouteille, même au retour sur l'application. Les vignettes de choix affichent
le format (« 150 cl »), et l'inventaire refuse un compte au-delà de 100 000
bouteilles. Une photo d'entrée identique à une ancienne photo de sortie
inutilisée rejoint la revue groupée.

### 1.1.2 — 3 octobre 2026

Version de documentation uniquement ([v1.1.2](https://github.com/djkix/cave-a-vin/releases/tag/v1.1.2)),
sans changement de code. Désormais, seuls les commits de fonctionnalité, de
correction et de performance déclenchent une nouvelle version : la mise à jour
de la documentation n'ouvre plus de version vide.

### 1.1.1 — 3 octobre 2026

Publiée ([v1.1.1](https://github.com/djkix/cave-a-vin/releases/tag/v1.1.1)),
images `ghcr.io/djkix/cave-a-vin-api:1.1.1` et `-web:1.1.1`.

**La sauvegarde de la base tourne enfin.** Le service `db-backup` dépendait d'un
script du dépôt monté depuis l'hôte, absent d'une stack créée dans Dockge : il
redémarrait en boucle sans jamais produire de dump. Le script est désormais écrit
dans le `docker-compose.yml`, la stack est autonome, et l'intégration continue
le vérifie à chaque commit en exigeant un vrai dump. La documentation de
déploiement décrit maintenant la création par Dockge. La construction des images
d'une publication ne peut plus être annulée par un push concurrent.

### 1.1.0 — 21 septembre 2026

Publiée ([v1.1.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.1.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.1.0` et `-web:1.1.0`.

**Analyse des photos différée et jamais bloquante.** Une indisponibilité
passagère du service de vision (429, 500, 502, 503, 504, coupure réseau,
plafond mensuel atteint) remet la photo en attente au lieu de la marquer en
échec, et le worker la reprend de 30 s à 15 minutes d'intervalle pendant une
dizaine de jours. Les erreurs définitives, elles, échouent immédiatement et
proposent la saisie manuelle. Le worker remet en file au démarrage les photos
que Redis a oubliées, un bandeau compte les photos en attente avec le motif du
dernier report, et l'écran d'entrée unitaire n'attend plus indéfiniment. La
migration `20260925000000_photo_deferred_retry` récupère les photos déjà
abandonnées à tort.

**Version affichée en permanence** en haut à droite de chaque écran et sur
l'écran de connexion, avec l'empreinte du commit pour une image `latest`.

### 1.0.0 — 21 septembre 2026

Première version déployable ([v1.0.0](https://github.com/djkix/cave-a-vin/releases/tag/v1.0.0)),
images `ghcr.io/djkix/cave-a-vin-api:1.0.0` et `-web:1.0.0`.

**Fonctionnalités**

- Socle auto-hébergé : Compose (`web`, `api`, `worker`, `postgres`, `redis`,
  `db-backup`), un seul port publié derrière Nginx Proxy Manager, intégration
  continue et publication automatique des images.
- Comptes : connexion Google OpenID Connect (scopes `openid`, `email`,
  `profile`), inscription libre avec accès complet immédiat, compte local de
  secours, sessions serveur en Redis.
- Administration (`/admin`) : blocage et réactivation des comptes, promotion et
  retrait des droits, avec `ADMIN_EMAILS` comme plancher garanti.
- Entrée de stock par photo : capture native, normalisation de l'image,
  extraction par Gemini avec confiance par champ, recalage sur le référentiel des
  appellations, dédoublonnage, écran de confirmation éditable, quantité en un tap.
- Mode campagne : rafale puis revue groupée triée par confiance croissante.
- File hors ligne (20 photos / 50 Mo) vidée au premier plan.
- Journal des 20 derniers mouvements avec annulation par mouvement inverse.
- Export Excel à la demande (`Stock`, `Mouvements`, `Référence`) avec filtre par
  couleur.

**Sécurité et exploitation**

- Contrôle d'accès par statut de compte : un blocage coupe la session en cours
  dès la requête suivante.
- L'API d'administration n'expose ni hachage de mot de passe ni identifiant
  Google.
- Sauvegardes quotidiennes de la base avec rotation, sans fichier tronqué.
- Limitation de débit sur l'envoi de photos et sur la connexion locale.
- Plafond mensuel de dépense pour l'API de vision.

**Corrections de la première mise en service**

- Moteurs Prisma compilés pour OpenSSL 3 (l'api et le worker ne démarraient pas).
- En-tête `X-Forwarded-Proto` relayé tel quel (le cookie de session n'était
  jamais posé derrière le proxy et la connexion bouclait).
- Démarrage possible avec un `.env` dont les variables de secours sont vides.

## Stack technique

NestJS (api + worker BullMQ), PostgreSQL 16 avec `pg_trgm`, Redis 7, React + Vite
en PWA, Gemini pour la lecture d'étiquettes, ExcelJS pour le classeur.

## Licence

MIT — voir [`LICENSE`](LICENSE).
