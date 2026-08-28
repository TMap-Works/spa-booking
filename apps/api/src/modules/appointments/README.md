# Module `appointments`

Cycle de vie du rendez-vous — réserver, reporter, annuler. C'est le point
d'entrée du revenu (CDC §2.3), et le module où le risque n°1 du projet, la double
réservation, est tenu.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #31 | La contrainte d'exclusion, le verrou consultatif d'agenda et la traduction du refus en 409 |
| #37 | La réservation publique sans compte — fiche cliente, intervalle occupé, prix figé |
| #39 | Le report — annulation et création liées dans une seule transaction |
| #40 | L'annulation des deux côtés du comptoir — trace écrite, créneau libéré |
| #36 | **L'option « premier disponible »** — `staffId` facultatif, et la règle d'affectation |

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `POST` | `/api/v1/public/:tenantSlug/appointments` | — (ouverte) |
| `POST` | `/api/v1/public/:tenantSlug/appointments/:id/reschedule` | — (ouverte) |
| `POST` | `/api/v1/public/:tenantSlug/appointments/:id/cancel` | — (ouverte) |
| `POST` | `/api/v1/appointments/:id/cancel` | `STAFF` |

Les trois routes publiques ne sont pas gardées, et c'est le quatrième critère de
#37 : on réserve sans compte. Ce qui les tient est le `ValidationPipe` global, le
contrôle de disponibilité, la contrainte d'exclusion, et un quota par adresse.

## Les deux intervalles d'un rendez-vous

| Intervalle | Durée | Qui le voit | Où il vit |
|---|---|---|---|
| **occupé** | `buffer_before + duration + buffer_after` | l'agenda du praticien | `appointments.starts_at` / `ends_at`, donc `time_range`, donc la contrainte |
| **facturé** | `duration` | la cliente | `AppointmentView`, dérivé à la lecture |

La base stocke le premier, l'API rend le second. Même asymétrie que dans
`availability.slots.ts` : la grille se pose sur l'occupé, la sortie rend le
facturé.

## L'option « premier disponible » (#36)

Le CDC §1.4 la nomme explicitement : « choix du praticien ou *premier
disponible* ». Elle se dit en **omettant `staffId`** du corps de la réservation.
Son absence n'est pas une donnée manquante, c'est un choix.

### La règle d'affectation

> Le rendez-vous va au **premier praticien libre dans l'ordre du moteur de
> disponibilité** — `(instant, puis identifiant de praticien)` —, et au suivant
> si la base refuse son créneau.

La liste des candidats est celle que `AvailabilityService.slotsFor` rend **pour
l'instant demandé**, sans `staffId` : tous les praticiens qui pratiquent la
prestation et que le moteur propose alors. Rien n'est recalculé dans ce module,
et aucune règle de disponibilité n'y est réécrite.

Trois propriétés l'ont fait retenir :

- **déterministe à agenda constant** — deux requêtes identiques posées sur le
  même état du calendrier désignent le même praticien. Ce n'est pas de
  l'idempotence : au second envoi d'un double clic, le premier praticien est déjà
  pris, le repli affecte le suivant, et la cliente repart avec **deux**
  rendez-vous plutôt qu'un 409 — la contrainte d'exclusion porte sur `(tenant,
  praticien, intervalle)`, jamais sur la cliente. Désarmer le double envoi reste
  au front (#45) ; une déduplication côté serveur est portée par une issue de
  suivi ;
- **elle remplit un agenda avant d'en ouvrir un autre** — le salon garde des
  plages libres continues chez les praticiens suivants. Une répartition tournante
  émietterait toutes les journées, et un agenda émietté ne vend plus de soin
  long ;
- **elle ne propose jamais un praticien qui ne pratique pas la prestation** : les
  candidats sont l'intersection de `service_staff` calculée par le moteur
  (booking-engine §6, troisième critère du ticket).

Contrepartie assumée : à égalité de disponibilité, c'est toujours le même
praticien qui prend la réservation sans préférence. Une répartition à la charge
coûterait une lecture de plus par réservation ; une issue de suivi la porte.

### Le repli en cas de conflit

Quatrième critère du ticket. Chaque tentative est une **écriture complète**,
verrou consultatif d'agenda compris, jugée par `appointments_no_overlap`. Quand
elle est refusée, le praticien suivant est tenté ; le 409 n'est prononcé
qu'une fois la liste épuisée.

Ce que le repli n'est pas : une façon de contourner le refus. Il n'y a aucune
vérification applicative « ce créneau est-il libre ? » avant l'insertion, aucun
réordonnancement des candidats entre deux tours, aucune mémoire des praticiens
« probablement pris ». La contrainte reste le seul arbitre de l'unicité
(ADR 0002, booking-engine §1) — le repli est ce qu'on fait **après** avoir reçu
son verdict.

Le nombre de tours est borné par la liste que le moteur vient de rendre. Sur une
réservation nominale il vaut un ; il ne croît que sous contention réelle, et
jamais au-delà de l'effectif affecté à ce soin.

### Ce que la réponse dit, et ce qu'elle tait

Le rendez-vous rendu porte **toujours** `staffId` : c'est par lui que la cliente
apprend qui lui a été affecté. Le 409, lui, rend `details.staffId: null` quand
elle n'a désigné personne — nommer le dernier praticien tenté apprendrait à un
appelant anonyme un identifiant qu'il n'a jamais soumis, et ferait de cette route
une sonde d'agenda.

### Pas d'affectation au report

`reschedule` garde le praticien de la demande, ou celui du rendez-vous d'origine.
Un report qui changerait de praticien de lui-même déplacerait une cliente chez
quelqu'un qu'elle n'a pas choisi.

## Ce qui garantit l'unicité, et ce qui ne la garantit pas

| Mécanisme | Ce qu'il fait |
|---|---|
| `appointments_no_overlap` | **La garantie.** Refuse tout chevauchement `(tenant, praticien, intervalle)` sur les statuts occupants |
| verrou consultatif `pg_advisory_xact_lock` | Ordonne les candidates d'un même praticien — supprime les interblocages, ne décide de rien (ADR 0006) |
| contrôle de disponibilité | Refuse un créneau que le calendrier ne proposait pas — jour de fermeture, congé, préavis. Ne dit rien de l'unicité |
| cache de disponibilité | **Jamais lu ici.** `AvailabilityModule` n'exporte pas `AvailabilityQueryService` : un cache périmé ne peut pas faire réserver un créneau pris (#35) |

## Isolation

Le repository injecte le client Prisma **scopé** : aucune requête ne répète
`tenant_id`, donc aucune ne peut l'oublier. Un rendez-vous d'un autre
établissement est **introuvable** — 404, jamais 403, qui confirmerait son
existence (tenant-isolation §4).

Le cas propre à l'option « premier disponible » : les candidats viennent d'une
lecture déjà scopée, si bien qu'un praticien du voisin ne peut pas être affecté —
et un `staffId` du voisin explicitement demandé rend le même 409 qu'un créneau
pris, jamais un 404 qui distinguerait les deux.
`test/appointments-tenant.isolation-spec.ts` couvre les deux.
