-- Reprendre en E.164 les téléphones déjà écrits, et imposer le format en base — #824.
--
-- ## Ce que la migration pose
--
-- | Objet | Ce qu'il fait |
-- |---|---|
-- | reprise de `users.phone` | ramène chaque numéro à `+<indicatif><national>`, avec le pays de son établissement |
-- | reprise de `tenants.contact_phone` | la même, avec le pays de l'établissement lui-même |
-- | `assert_phone_is_e164()` | le prédicat du quatrième critère, écrit une fois |
-- | `users_phone_e164` | « aucune écriture ne pose un numéro qui ne soit pas en E.164 », rendu non représentable |
-- | `tenants_contact_phone_e164` | le même, sur le numéro publié du salon |
--
-- ## Le constat qu'elle referme
--
-- Un seul point d'écriture normalisait — le tunnel de réservation sans compte,
-- par `e164PhoneSchema`. Les six autres — inscription, profil, fiche cliente,
-- compte du personnel, invitation, réglages de l'établissement — validaient un
-- motif de saisie (`^[+0-9][0-9\s().-]*$`) et **enregistraient la frappe telle
-- quelle**. La colonne portait donc, pour une même personne, `+261 34 12 345 67`,
-- `00261341234567` et `0341234567` : trois chaînes, un seul destinataire. Deux
-- fonctions du produit en dépendaient et ne pouvaient pas marcher :
--
-- - la **recherche par téléphone** du fichier client, qui interroge
--   `(tenant_id, phone)` par préfixe — un numéro national ne se trouve jamais
--   sous sa forme internationale, ni l'inverse ;
-- - l'**envoi de SMS**, Amazon SNS n'acceptant qu'E.164. Un rappel J-1 vers
--   `0341234567` n'était pas envoyé, et le seul endroit où cela se voyait était
--   la ligne de journal de l'expéditeur.
--
-- Le code applicatif est corrigé par le même ticket — `e164PhoneSchemaFor` dans
-- le contrat partagé, et le module de vocabulaire `phone.ts` que les services
-- appellent. Cette migration traite ce qui est **déjà écrit** : sans
-- elle, la correction ne vaudrait que pour les lignes à venir, et la recherche
-- resterait fausse sur le stock aussi longtemps que le stock vit.
--
-- ## Comment un numéro est complété, et pourquoi si prudemment
--
-- Trois conversions, dans cet ordre, et rien d'autre :
--
-- 1. **les séparateurs sont retirés** — espaces, points, tirets, parenthèses
--    d'indicatif régional. Ils ne portent aucune information et sont la
--    principale cause des trois écritures d'un même numéro ;
-- 2. **`00` devient `+`** — c'est le préfixe de composition internationale de la
--    quasi-totalité des plans de numérotation, et E.164 exige `+` ;
-- 3. **un national à préfixe interurbain `0` reçoit l'indicatif du pays de son
--    établissement** — `0341234567` dans un salon malgache devient
--    `+261341234567`.
--
-- La troisième est la seule qui **ajoute** de l'information, et c'est pourquoi
-- elle est bornée deux fois.
--
-- D'abord par la source du pays : `tenants.country_code`, la colonne que
-- l'écran de réglages renseigne, jamais le fuseau — « Indian/Antananarivo » est
-- un fuseau, pas un pays, et l'Europe en partage un entre une douzaine
-- d'indicatifs. Un établissement qui n'a pas saisi son adresse n'a pas de pays :
-- ses numéros nationaux sont listés, pas devinés.
--
-- Ensuite par la table d'indicatifs ci-dessous, qui ne porte **que** des pays
-- dont le plan de numérotation emploie effectivement le préfixe interurbain
-- `0` : retirer ce `0` et coller l'indicatif y donne le numéro international, et
-- c'est vérifiable pays par pays. Les plans qui n'en ont pas — l'Amérique du
-- Nord, l'Espagne, le Portugal, l'Italie, la Tunisie, le Sénégal, Maurice — en
-- sont **absents exprès** : on ne sait pas y distinguer un national d'un
-- fragment, et un numéro syntaxiquement valide mais faux est pire qu'un numéro
-- refusé. C'est un SMS de rappel envoyé à quelqu'un d'autre.
--
-- Le plan de numérotation complet vit là où il doit vivre : dans
-- `libphonenumber-js`, côté application, où `isValidPhoneNumber` juge aussi la
-- **longueur** et le **préfixe d'attribution**. Une migration SQL n'a pas à
-- l'embarquer — elle a besoin des pays présents en base, et de refuser les
-- autres.
--
-- ## Les valeurs impossibles à normaliser sont listées, jamais écrasées
--
-- Troisième critère du ticket, et il est littéral : ce qui ne se convertit pas
-- **reste en place**. Les mettre à `NULL` aurait détruit la seule trace d'un
-- numéro que quelqu'un a saisi un jour, pour une donnée qu'aucune sauvegarde
-- partielle ne rend — et un numéro mal écrit reste rappelable par un humain qui
-- le lit.
--
-- Le listage est un `RAISE WARNING` par ligne, et il nomme **l'identifiant, son
-- établissement et son pays — jamais le numéro**. Un journal de déploiement part
-- en CI et en agrégateur de logs ; y imprimer des numéros de téléphone
-- constituerait un traitement que rien n'autorise (CDC §5.1, et c'est la règle
-- que `common/logging/redaction.ts` applique partout ailleurs). L'identifiant
-- suffit à retrouver la ligne :
--
--     SELECT id, phone FROM users WHERE id = '…';
--
-- ## Pourquoi un déclencheur, et non le `CHECK` que le critère nomme
--
-- Le quatrième critère demande « une contrainte en base impose le format :
-- `CHECK (phone ~ '^\+[1-9][0-9]{1,14}$')` ». Écrit tel quel, il entre en
-- collision frontale avec le troisième — « les valeurs impossibles à normaliser
-- sont listées, **pas écrasées** » —, et la collision n'est pas théorique :
-- elle verrouille des comptes.
--
-- Un `CHECK`, `NOT VALID` compris, est réévalué par PostgreSQL sur la **nouvelle
-- version de la ligne à chaque `UPDATE`**, que la mise à jour touche la colonne
-- ou non ; `NOT VALID` n'omet que le balayage initial des lignes existantes.
-- Vérifié sur PostgreSQL 16 : un `UPDATE u SET last_login = now()` sur une ligne
-- dont `phone` vaut `(555) 123-4567` rend `23514`. Or `AuthService.login` écrit
-- `users.last_login_at` à chaque connexion réussie : une ligne résiduelle
-- devenait **définitivement inconnectable**, en 500, sans qu'aucun écran ne
-- puisse le corriger.
--
-- Et les résidus sont atteignables. Les DTO d'écriture bornaient la forme par
-- `^[+0-9][0-9\s().-]*$` **sans plancher de chiffres** sur la fiche cliente et
-- sur les comptes du personnel : `0`, `+` et `612345678` sont en base
-- aujourd'hui pour qui les a saisis, et aucun des trois n'est convertible
-- ci-dessus. « Le nombre attendu est zéro » était faux.
--
-- Le déclencheur impose **le même prédicat**, à la seule différence qui compte :
-- il ne juge que les écritures qui **portent** un numéro — `BEFORE INSERT OR
-- UPDATE OF` ne se déclenche que si la colonne figure dans le `SET`, et le garde
-- `IS DISTINCT FROM` écarte la réécriture d'une valeur identique. Ce qui en
-- résulte est exactement ce que le critère cherche, et rien de ce qu'il ne
-- cherchait pas :
--
-- | Écriture | Verdict |
-- |---|---|
-- | insertion d'un numéro non E.164 | refusée, `23514` |
-- | mise à jour d'un numéro vers du non-E.164 | refusée, `23514` |
-- | mise à jour d'une **autre** colonne d'une ligne résiduelle | **passe** — la connexion reste possible |
-- | mise à jour d'un numéro résiduel vers de l'E.164 | passe, et c'est le chemin de correction |
--
-- Le code d'erreur est `check_violation` délibérément : l'application ne
-- distingue pas ce refus de celui d'un `CHECK`, et le jour où le stock sera
-- propre, remplacer le déclencheur par la contrainte du critère ne changera
-- rien de visible.
--
-- Le message ne cite **pas** le numéro refusé — une erreur de base remonte dans
-- les journaux du serveur, où un numéro de téléphone n'a rien à faire
-- (CDC §5.1). Il nomme la table et la colonne, ce qui suffit à situer la panne.
--
-- ## Additive et réversible
--
-- Aucune colonne, aucune table, aucun index n'est touché : la migration écrit
-- des valeurs, pose une fonction et deux déclencheurs. L'inverse exact est le
-- retrait des deux déclencheurs puis de la fonction, sur une base qui portera
-- alors les mêmes numéros qu'avant — la reprise, elle, ne se défait pas, et n'a
-- pas à l'être : E.164 est la forme canonique de ce que ces lignes contenaient
-- déjà.

DO $reprise$
DECLARE
  -- Pays dont le plan de numérotation emploie le préfixe interurbain « 0 »,
  -- avec leur indicatif E.164. Voir l'en-tête pour ce qui n'y est pas, et
  -- pourquoi.
  indicatifs CONSTANT jsonb := jsonb_build_object(
    'FR', '33',   -- France métropolitaine
    'RE', '262',  -- La Réunion
    'YT', '262',  -- Mayotte
    'GP', '590',  -- Guadeloupe
    'MQ', '596',  -- Martinique
    'GF', '594',  -- Guyane
    'MG', '261',  -- Madagascar
    'BE', '32',
    'CH', '41',
    'DE', '49',
    'AT', '43',
    'NL', '31',
    'SE', '46',
    'GB', '44',
    'IE', '353',
    'MA', '212',
    'DZ', '213',
    'ZA', '27'
  );
  reprises integer;
  restante record;
  restantes integer := 0;
BEGIN
  -- ------------------------------------------------------------------
  -- 1. `users.phone` — le pays vient de l'établissement de la ligne
  -- ------------------------------------------------------------------
  WITH candidat AS (
    SELECT
      u."id",
      u."phone" AS avant,
      CASE
        -- Déjà international : seuls les séparateurs partent.
        WHEN compacte.valeur ~ '^\+[1-9][0-9]{1,14}$' THEN compacte.valeur
        -- Préfixe de composition internationale.
        WHEN compacte.valeur ~ '^00[1-9][0-9]{1,14}$' THEN '+' || substr(compacte.valeur, 3)
        -- National à préfixe interurbain, pays connu : le « 0 » cède la place à
        -- l'indicatif. La borne basse de quatre chiffres après le « 0 » écarte
        -- ce qui n'est un numéro dans aucun plan ; la borne haute tient les
        -- quinze chiffres significatifs d'E.164, indicatif compris.
        WHEN compacte.valeur ~ '^0[1-9][0-9]{4,13}$'
             AND (indicatifs ->> t."country_code") IS NOT NULL
             AND length(indicatifs ->> t."country_code") + length(compacte.valeur) - 1 <= 15
          THEN '+' || (indicatifs ->> t."country_code") || substr(compacte.valeur, 2)
        ELSE NULL
      END AS apres
    FROM "users" AS u
    JOIN "tenants" AS t ON t."id" = u."tenant_id"
    CROSS JOIN LATERAL (
      SELECT regexp_replace(u."phone", '[\s().-]', '', 'g') AS valeur
    ) AS compacte
    WHERE u."phone" IS NOT NULL
  )
  UPDATE "users" AS u
     SET "phone" = candidat.apres
    FROM candidat
   WHERE candidat."id" = u."id"
     AND candidat.apres IS NOT NULL
     AND candidat.apres <> candidat.avant;

  GET DIAGNOSTICS reprises = ROW_COUNT;
  RAISE NOTICE '#824 — users.phone : % ligne(s) normalisée(s) en E.164', reprises;

  -- ------------------------------------------------------------------
  -- 2. `tenants.contact_phone` — le pays est celui de l'établissement
  -- ------------------------------------------------------------------
  WITH candidat AS (
    SELECT
      t."id",
      t."contact_phone" AS avant,
      CASE
        WHEN compacte.valeur ~ '^\+[1-9][0-9]{1,14}$' THEN compacte.valeur
        WHEN compacte.valeur ~ '^00[1-9][0-9]{1,14}$' THEN '+' || substr(compacte.valeur, 3)
        WHEN compacte.valeur ~ '^0[1-9][0-9]{4,13}$'
             AND (indicatifs ->> t."country_code") IS NOT NULL
             AND length(indicatifs ->> t."country_code") + length(compacte.valeur) - 1 <= 15
          THEN '+' || (indicatifs ->> t."country_code") || substr(compacte.valeur, 2)
        ELSE NULL
      END AS apres
    FROM "tenants" AS t
    CROSS JOIN LATERAL (
      SELECT regexp_replace(t."contact_phone", '[\s().-]', '', 'g') AS valeur
    ) AS compacte
    WHERE t."contact_phone" IS NOT NULL
  )
  UPDATE "tenants" AS t
     SET "contact_phone" = candidat.apres
    FROM candidat
   WHERE candidat."id" = t."id"
     AND candidat.apres IS NOT NULL
     AND candidat.apres <> candidat.avant;

  GET DIAGNOSTICS reprises = ROW_COUNT;
  RAISE NOTICE '#824 — tenants.contact_phone : % ligne(s) normalisée(s) en E.164', reprises;

  -- ------------------------------------------------------------------
  -- 3. Ce qui reste — listé ligne par ligne, sans le numéro
  -- ------------------------------------------------------------------
  FOR restante IN
    SELECT u."id", u."tenant_id", coalesce(t."country_code", '(pays non renseigné)') AS pays
      FROM "users" AS u
      JOIN "tenants" AS t ON t."id" = u."tenant_id"
     WHERE u."phone" IS NOT NULL
       AND u."phone" !~ '^\+[1-9][0-9]{1,14}$'
     ORDER BY u."tenant_id", u."id"
  LOOP
    restantes := restantes + 1;
    RAISE WARNING
      '#824 — users.phone non normalisable : id=% tenant=% pays=% (valeur conservée)',
      restante."id", restante."tenant_id", restante.pays;
  END LOOP;

  FOR restante IN
    SELECT t."id", t."id" AS "tenant_id", coalesce(t."country_code", '(pays non renseigné)') AS pays
      FROM "tenants" AS t
     WHERE t."contact_phone" IS NOT NULL
       AND t."contact_phone" !~ '^\+[1-9][0-9]{1,14}$'
     ORDER BY t."id"
  LOOP
    restantes := restantes + 1;
    RAISE WARNING
      '#824 — tenants.contact_phone non normalisable : id=% pays=% (valeur conservée)',
      restante."id", restante.pays;
  END LOOP;

  IF restantes = 0 THEN
    RAISE NOTICE
      '#824 — aucune valeur résiduelle : le stock est entièrement en E.164, et le CHECK du quatrième critère pourrait remplacer les déclencheurs ci-dessous';
  ELSE
    RAISE WARNING
      '#824 — % valeur(s) résiduelle(s) : lisibles et modifiables, mais ni cherchables par téléphone ni joignables par SMS. À reprendre à la main — toute réécriture de leur numéro devra être en E.164',
      restantes;
  END IF;
END
$reprise$;

-- ## Le format, imposé en base
--
-- `NULL` reste licite — les deux colonnes sont nullables, et « pas de numéro »
-- est un état parfaitement légitime. Le motif est celui du quatrième critère,
-- qui est la recommandation UIT-T E.164 : un `+`, un indicatif de pays qui ne
-- commence pas par zéro, quinze chiffres significatifs au plus. Il a une
-- seconde écriture, dans `E164_PATTERN` de `packages/shared` — les deux
-- décrivent la même chose des deux côtés de la frontière, et c'est la base qui
-- fait foi.
--
-- Une **seule** fonction pour les deux colonnes, la colonne visée passée en
-- argument du déclencheur : le prédicat est la décision, et la recopier deux
-- fois aurait donné deux avis sur ce qu'est un numéro E.164 — la divergence que
-- ce ticket passe justement son temps à refermer.
CREATE OR REPLACE FUNCTION "assert_phone_is_e164"() RETURNS trigger
LANGUAGE plpgsql AS $verdict$
DECLARE
  colonne text := TG_ARGV[0];
  suivant text := to_jsonb(NEW) ->> colonne;
  precedent text := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> colonne END;
BEGIN
  -- Pas de numéro, ou le même qu'avant : rien à juger. Le second cas n'est pas
  -- une complaisance — c'est ce qui laisse une ligne résiduelle se mettre à jour
  -- sur ses autres colonnes, donc son titulaire se connecter.
  IF suivant IS NULL OR suivant IS NOT DISTINCT FROM precedent THEN
    RETURN NEW;
  END IF;

  IF suivant !~ '^\+[1-9][0-9]{1,14}$' THEN
    RAISE EXCEPTION
      'la colonne %.% n''accepte qu''un numéro au format E.164 (« +261341234567 »)',
      TG_TABLE_NAME, colonne
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$verdict$;

CREATE TRIGGER "users_phone_e164" BEFORE INSERT OR UPDATE OF "phone" ON "users"
  FOR EACH ROW EXECUTE FUNCTION "assert_phone_is_e164"('phone');

CREATE TRIGGER "tenants_contact_phone_e164" BEFORE INSERT OR UPDATE OF "contact_phone" ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION "assert_phone_is_e164"('contact_phone');
