-- Un mouvement ne peut être annulé qu'une fois : l'index partiel rend l'invariant vrai sous concurrence.
CREATE UNIQUE INDEX idx_movement_reverses_id ON movement (reverses_id) WHERE reverses_id IS NOT NULL;
