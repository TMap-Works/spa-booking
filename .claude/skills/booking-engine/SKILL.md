---
name: booking-engine
description: Règles du moteur de disponibilité et du cycle de vie des rendez-vous — calcul des créneaux libres, prévention des doubles réservations, report, annulation, no-show. À charger avant toute modification de apps/api/src/modules/availability ou appointments, ou dès qu'une tâche parle de créneaux, disponibilité, réservation, conflit d'agenda ou concurrence.
---

# Moteur de réservation

Le CDC identifie la double réservation comme le risque à impact élevé n°2 et le
moteur de disponibilité comme le cœur de la valeur perçue. Ce document fixe les
règles qui ne se négocient pas.

## 1. La règle d'or : l'unicité est garantie par la base, pas par le code

Une vérification applicative « est-ce que ce créneau est libre ? » suivie d'un
`INSERT` est **toujours** fausse sous concurrence. Deux requêtes simultanées
passent la vérification puis insèrent toutes les deux.

La garantie vient d'une contrainte d'exclusion PostgreSQL sur un intervalle :

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    tenant_id   WITH =,
    staff_id    WITH =,
    time_range  WITH &&
  )
  WHERE (status IN ('pending', 'confirmed'));
```

`time_range` est une colonne `tstzrange` générée à partir de `starts_at` et
`ends_at`. Le `WHERE` partiel est essentiel : un rendez-vous annulé ou marqué
no-show libère le créneau et ne doit plus bloquer.

Conséquence sur le code : la création de rendez-vous **attend une violation de
contrainte** et la traduit en erreur métier.

```ts
try {
  return await this.prisma.appointment.create({ data });
} catch (e) {
  if (isExclusionViolation(e)) {
    throw new SlotNoLongerAvailableError(data.staffId, data.startsAt);
  }
  throw e;
}
```

`SlotNoLongerAvailableError` doit remonter en **409 Conflict**, jamais en 500.
Le front réaffiche les créneaux et invite à en choisir un autre.

## 2. Le verrou Redis est un confort, pas une garantie

Un verrou court (`SET slot:{tenant}:{staff}:{start} NX EX 120`) posé pendant que
le client saisit son paiement évite d'afficher un créneau à deux personnes et
réduit la frustration. Il ne remplace jamais la contrainte d'exclusion :
Redis peut expirer, tomber, ou être contourné par un appel direct à l'API.

Ordre correct : verrou Redis (UX) → transaction + contrainte (vérité) → libération
du verrou dans un `finally`.

## 3. Calcul des créneaux libres

Le calcul se fait **à la demande**, jamais en matérialisant tous les créneaux en base.

Entrées : `tenantId`, `serviceId`, `staffId | 'first-available'`, une plage de dates,
le fuseau horaire du tenant.

Algorithme :

1. Résoudre les praticiens candidats — ceux dont la table de liaison
   `staff_services` contient `serviceId`. Si `first-available`, tous les candidats.
2. Pour chaque praticien, construire ses **fenêtres de travail** sur la plage :
   les `staff_schedules` récurrents (jour de semaine + heure locale), moins les
   `staff_time_off` (plages bloquées, congés), moins les jours de fermeture du tenant.
3. Retirer les rendez-vous existants dont le statut est `pending` ou `confirmed`.
4. Découper chaque fenêtre restante par pas de `slot_interval` (défaut 15 min,
   configurable par tenant).
5. Ne garder que les créneaux où `durée totale` tient entièrement dans la fenêtre.
   La durée totale est `service.duration + service.buffer_before + service.buffer_after` —
   les temps de préparation et de finition du CDC §2.3 font partie du créneau occupé
   mais ne sont pas facturés au client.
6. Filtrer les créneaux dans le passé et ceux qui violent le délai minimum de
   réservation du tenant (`min_booking_notice`, défaut 1 h).

Le résultat est mis en cache Redis avec une clé
`avail:{tenantId}:{serviceId}:{staffId}:{date}` et un TTL court (60 s). Ce cache est
**invalidé explicitement** à chaque écriture sur `appointments`, `staff_schedules`
ou `staff_time_off` du tenant concerné. Un cache périmé qui affiche un créneau déjà
pris est acceptable (la contrainte rattrape) ; un cache qui masque un créneau libre
fait perdre du chiffre d'affaires — d'où le TTL court.

## 4. Fuseaux horaires

- La base ne stocke que de l'UTC (`timestamptz`).
- Les horaires du personnel sont saisis en **heure locale du tenant** et convertis
  à la volée. Ne jamais figer un décalage : les passages heure d'été/hiver
  décaleraient tout l'agenda.
- Le fuseau du tenant est une colonne obligatoire (`tenants.timezone`, IANA, ex.
  `Indian/Antananarivo`, `Europe/Paris`).
- Toute date qui traverse l'API est en ISO 8601 avec offset explicite.

Test obligatoire : réserver un créneau la nuit du changement d'heure et vérifier
que la durée reste correcte.

## 5. Cycle de vie du rendez-vous

```
                 ┌──────────► cancelled
                 │
pending ──► confirmed ──► completed
   │             │
   │             └──────────► no_show
   └──► cancelled
```

| Statut | Signification | Occupe le créneau |
|---|---|---|
| `pending` | Créé, paiement ou confirmation en attente | oui |
| `confirmed` | Confirmé, notification envoyée | oui |
| `completed` | Honoré, encaissé | non |
| `cancelled` | Annulé par le client ou le salon | non |
| `no_show` | Client absent | non |

Transitions interdites : tout retour en arrière depuis `completed`, et tout passage
direct `pending → completed`. Les valider dans un service dédié, pas dans le contrôleur.

**Report (reschedule)** : ce n'est pas un `UPDATE` des dates en place. C'est une
transaction qui annule l'ancien rendez-vous et en crée un nouveau lié par
`rescheduled_from_id`. Sinon l'historique client est perdu et la contrainte
d'exclusion peut refuser une mise à jour pourtant légitime.

**Annulation** : consigner `cancelled_at`, `cancelled_by` (client / staff / système)
et `cancellation_reason`. Le reporting no-show du CDC §1.4 en dépend.

## 6. Ce qu'il faut tester à chaque changement

- Concurrence : N requêtes parallèles sur le même créneau → exactement 1 succès,
  N-1 réponses 409. Ce test est non négociable.
- Un créneau annulé redevient réservable.
- Les buffers avant/après empêchent bien le chevauchement du créneau suivant.
- Un praticien en congé n'apparaît dans aucun créneau.
- `first-available` ne propose jamais un praticien qui ne fait pas ce service.
- Changement d'heure été/hiver.
- Isolation : un créneau du tenant A n'apparaît jamais pour le tenant B.
