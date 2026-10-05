-- Mesure « zéro saisie » : la fiche telle que confirmée à l'entrée par photo,
-- comparée à la lecture de la photo pour compter les champs corrigés à la main.
-- Vide pour les mouvements sans photo et pour les entrées antérieures.
ALTER TABLE movement ADD COLUMN confirmed_wine JSONB;
