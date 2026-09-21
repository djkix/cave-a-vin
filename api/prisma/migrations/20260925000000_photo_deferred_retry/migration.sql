-- Récupération des photos abandonnées à tort.
--
-- Jusqu'ici, une indisponibilité passagère du service de vision (503 de
-- saturation, 429 de quota, coupure réseau) faisait passer la photo en FAILED
-- après trois tentatives en six secondes. L'image restait stockée sur le
-- volume Docker, mais n'apparaissait plus nulle part dans l'interface : la
-- revue groupée ne liste que les analyses terminées.
--
-- On remet donc en attente les photos dont le message d'erreur désigne une
-- panne passagère. Le worker les reprend tout seul à son démarrage suivant
-- (voir requeueOrphanPhotos) : aucune action manuelle n'est nécessaire.
--
-- Les photos en échec pour une raison définitive — étiquette illisible, sortie
-- du modèle inexploitable — sont laissées en FAILED : elles attendent une
-- saisie manuelle, pas un réessai.

UPDATE "photo"
SET "status" = 'PENDING',
    "error_message" = 'Analyse reportée : reprise automatique après une indisponibilité du service'
WHERE "status" = 'FAILED'
  AND (
    "error_message" LIKE '%[429%'
    OR "error_message" LIKE '%[500%'
    OR "error_message" LIKE '%[502%'
    OR "error_message" LIKE '%[503%'
    OR "error_message" LIKE '%[504%'
    OR "error_message" LIKE '%Service Unavailable%'
    OR "error_message" LIKE '%high demand%'
    OR "error_message" LIKE '%overloaded%'
    OR "error_message" LIKE '%fetch failed%'
    OR "error_message" LIKE '%ECONNRESET%'
    OR "error_message" LIKE '%ETIMEDOUT%'
    OR "error_message" LIKE '%EAI_AGAIN%'
    OR "error_message" LIKE '%Plafond mensuel%'
  );
