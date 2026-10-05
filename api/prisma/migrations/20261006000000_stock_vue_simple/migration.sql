-- Le stock devient une vue simple, calculée à chaque lecture.
--
-- La vue matérialisée était rafraîchie par un déclencheur après chaque
-- insertion. Quand deux mouvements se croisaient, le second rafraîchissement
-- attendait le verrou du premier, puis recalculait avec l'instantané pris
-- avant la validation du premier : un mouvement validé disparaissait du stock
-- jusqu'au mouvement suivant. Une vue simple ne peut pas être périmée ; à
-- quelques milliers de mouvements, la somme est immédiate (index
-- movement_wine_id_occurred_at_idx).
--
-- Le contrôle du stock jamais négatif (check_stock_non_negative) somme déjà
-- le journal directement et n'est pas concerné.
DROP TRIGGER IF EXISTS trg_refresh_stock_courant ON movement;
DROP FUNCTION IF EXISTS refresh_stock_courant();
DROP MATERIALIZED VIEW IF EXISTS stock_courant;

CREATE VIEW stock_courant AS
SELECT wine_id, SUM(delta)::INTEGER AS quantity FROM movement GROUP BY wine_id;
