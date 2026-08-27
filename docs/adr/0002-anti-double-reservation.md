# ADR 0002 — La contrainte d'exclusion PostgreSQL garantit l'unicité du créneau

- **Statut** : Accepté
- **Date** : 2026-08-23
- **Contexte CDC** : §2.3 Réservations, §6 Registre des risques

## Contexte

La double réservation d'un même créneau est identifiée au CDC §6 comme un risque
à impact élevé. Sous concurrence, deux clients peuvent réserver le même créneau
chez le même praticien à quelques millisecondes d'écart.

## Options envisagées

### Option A — Vérification applicative

Lire les rendez-vous existants, constater que le créneau est libre, puis insérer.
Simple, et structurellement faux : entre la lecture et l'écriture, une autre
transaction peut insérer. Deux requêtes simultanées passent toutes deux la
vérification. Le défaut est invisible en développement et apparaît en production
sous charge.

### Option B — Verrou distribué Redis

Poser un verrou sur la clé du créneau avant d'écrire. Cela réduit fortement la
fenêtre, mais la garantie repose sur la disponibilité de Redis, l'expiration du
verrou et la discipline de tous les chemins d'écriture — y compris un appel API
direct ou un script d'administration.

### Option C — Contrainte d'exclusion PostgreSQL

Une contrainte EXCLUDE USING gist sur (tenant_id, staff_id, tstzrange), filtrée
sur les statuts actifs. La base refuse physiquement deux rendez-vous qui se
chevauchent, quelle que soit l'origine de l'écriture.

## Décision

Option C comme **source de vérité**, option B comme **confort d'interface**.

```sql
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    tenant_id  WITH =,
    staff_id   WITH =,
    time_range WITH &&
  )
  WHERE (status IN ('pending', 'confirmed'));
```

Un verrou Redis court est posé pendant la saisie du paiement pour éviter
d'afficher un créneau à deux personnes, mais il ne conditionne jamais la validité
de l'écriture.

## Conséquences

**Facilite** : la garantie est absolue et vaut pour tout chemin d'écriture, y
compris une correction manuelle en base. Aucun code applicatif ne peut la
contourner par oubli.

**Coûte** : le code de création de rendez-vous doit intercepter la violation de
contrainte et la traduire en SlotNoLongerAvailableError, rendue en HTTP 409. Le
front doit traiter le 409 comme un cas nominal, pas comme une erreur
exceptionnelle. L'extension btree_gist doit être activée sur la base.

**Ferme** : toute conception où deux rendez-vous actifs se chevaucheraient
légitimement pour le même praticien. Si un tel besoin apparaît, la contrainte
devra être repensée, pas contournée.

## Suite

La mise en œuvre (#31) a révélé une conséquence que cet ADR n'avait pas prévue :
sous concurrence réelle, des insertions aux intervalles décalés mais
chevauchants s'attendent en cycle et produisent des **interblocages** — donc des
500 — au lieu de la violation de contrainte attendue. La réponse est un verrou
consultatif d'ordonnancement par agenda de praticien, décrit par
l'[ADR 0006](0006-verrou-consultatif-agenda-praticien.md). Il ne modifie rien de
la décision ci-dessus : la contrainte reste la seule source de vérité.
