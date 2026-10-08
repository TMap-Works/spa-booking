-- Enrôlement du second facteur de la console à la première connexion — #1442.
--
-- Jusqu'ici, la commande d'exploitation `npm run platform:operator` imprimait
-- l'URI `otpauth://` de l'opérateur, une seule fois, à recopier dans son
-- application d'authentification. Désormais l'opérateur naît **non enrôlé** : à
-- sa première connexion, après le mot de passe, la console lui montre le QR code
-- à scanner, puis exige un premier code valide. C'est ce code qui confirme
-- l'enrôlement, et cette colonne qui s'en souvient.
--
-- | Colonne | Type | Nullable | Défaut | Ce qu'elle porte |
-- |---|---|---|---|---|
-- | `platform_operators.totp_confirmed_at` | `TIMESTAMPTZ(6)` | oui | — | l'instant du premier code valide |
--
-- Nulle : l'enrôlement reste à faire, et la connexion rend le QR code. Posée :
-- le secret ne sort plus jamais de l'API.
--
-- ## Les opérateurs existants sont tenus pour enrôlés
--
-- Ils ont reçu leur URI de la commande d'exploitation et s'en servent déjà. Les
-- laisser à `NULL` ferait réafficher leur secret à la prochaine connexion à
-- quiconque connaît leur mot de passe — exactement ce que l'enrôlement unique
-- veut empêcher. `created_at` est l'instant le plus proche de celui où ils ont
-- reçu leur secret.
--
-- Additive : une colonne nullable sans défaut, puis un `UPDATE` sur une table de
-- quelques lignes. Réversible par `DROP COLUMN`.

ALTER TABLE "platform_operators" ADD COLUMN "totp_confirmed_at" TIMESTAMPTZ(6);

UPDATE "platform_operators" SET "totp_confirmed_at" = "created_at";
