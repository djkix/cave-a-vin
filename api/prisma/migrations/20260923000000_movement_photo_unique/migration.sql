-- Une photo ne crédite le stock qu'une fois : deux téléphones qui confirment la même
-- fiche, ou un retour sur un écran de confirmation déjà validé, ne doivent pas écrire
-- deux mouvements IN. L'index partiel rend l'invariant vrai sous concurrence.
CREATE UNIQUE INDEX idx_movement_photo_in ON movement (photo_id) WHERE photo_id IS NOT NULL AND type = 'IN';
