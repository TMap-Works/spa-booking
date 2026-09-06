# Module `notifications`

Confirmations, rappels J-1 et avis d'annulation (CDC §2.3). Trois messages, deux
canaux, rien de plus — le marketing et les campagnes sont hors périmètre MVP.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #68 | La table `notifications` complétée, l'**index unique partiel** qui porte l'idempotence, l'ordre d'écriture `PENDING → fournisseur → SENT`, et la reprise d'un envoi échoué |

À venir : les passerelles SES et SNS, la Lambda d'envoi, les modèles de message
par établissement, le balayage horaire du rappel J-1, et l'abonnement aux
événements de domaine d'`appointments`.

## Le problème que ce module résout

SQS garantit **au-moins-une-fois**, jamais exactement-une-fois. Une livraison se
répète parce que la Lambda a dépassé son délai de visibilité, parce que le
balayage horaire du rappel se chevauche, ou sans raison visible. L'idempotence
est donc notre responsabilité, pas celle de la file (notifications §2).

Et elle ne peut pas être portée par le code. « Existe-t-il déjà une
notification ? sinon, en créer une » est structurellement faux sous concurrence :
deux consommateurs lisent tous les deux « non », insèrent tous les deux,
appellent tous les deux SES. C'est le même défaut que la vérification applicative
de disponibilité qu'ADR 0002 interdit au moteur de réservation, et il se règle de
la même façon — **la base tranche, le code traduit**.

## Les deux uniques, et ce qui les distingue

| Unique | Ce qu'il identifie | Portée |
|---|---|---|
| `notifications_tenant_id_dedupe_key_key` | **la livraison** — « ce message SQS-là, une fois » | tous les statuts |
| `notifications_live_once` | **la donnée** — « ce rappel-là, une fois » | `PENDING` et `SENT` seulement |

Le premier vient de la migration initiale et dépend de la façon dont le
producteur compose sa clé. Le second est posé par #68 :

```sql
CREATE UNIQUE INDEX "notifications_live_once"
  ON "notifications" ("tenant_id", "appointment_id", "type", "channel")
  WHERE "status" IN ('PENDING', 'SENT');
```

Il ne dépend d'aucune convention de clé : deux producteurs qui ne se coordonnent
pas — l'événement `appointment.confirmed` d'un côté, le balayage EventBridge de
l'autre — composeraient deux `dedupe_key` différentes pour un même rappel. Le
premier unique laisserait passer les deux ; celui-ci les sérialise.

Prisma n'exprime pas les index partiels : il est écrit en SQL brut dans
`prisma/migrations/20260906120000_add_notification_idempotency`, dont l'en-tête
détaille chaque décision (api-module §6).

### Pourquoi `FAILED` n'occupe pas la place

C'est le point le plus important du `WHERE`. Un échec transitoire — throttling
SES, panne fournisseur — doit pouvoir se réessayer. Si `FAILED` occupait la
place, la première erreur réseau condamnerait le rappel pour de bon : SQS
rejouerait dans le vide jusqu'à la DLQ, et la cliente ne recevrait rien.

C'est le raisonnement que `appointments_no_overlap` tient sur les statuts de
rendez-vous — un rendez-vous annulé libère son créneau — appliqué aux statuts
d'envoi.

## L'ordre d'écriture

```
1. inscrire la ligne en PENDING     ← la prise de droit ; la base tranche
2. appeler le fournisseur           ← le seul effet irréversible
3. passer la ligne à SENT           ← avec l'accusé du fournisseur
```

Aucune permutation ne tient :

- **inscrire après l'appel** rouvre la fenêtre que l'index ferme : deux
  consommateurs simultanés appelleraient SES avant que l'un ne voie le doublon.
  La marque doit précéder l'effet, sans quoi elle n'est qu'un journal ;
- **passer à `SENT` avant l'appel** ferait passer pour envoyé un message qui ne
  partirait jamais — et `SENT` occupant la place, aucun rejeu ne le rattraperait.

Un échec est inscrit **avant** d'être relevé, pour la même raison : une ligne
laissée `PENDING` reste vivante dans l'index, et le rejeu que SQS s'apprête à
faire serait pris pour un doublon.

## La reprise d'un envoi échoué

Une transition `FAILED → PENDING` sur la ligne existante, jamais une seconde
insertion : `(tenant_id, dedupe_key)` l'interdirait, et c'est aussi la seule
forme qui donne un sens à `attempt_count` — un compteur qui repartirait de zéro à
chaque essai ne compterait rien.

La transition est un test-et-pose atomique (`WHERE status = 'FAILED'`), doublé du
rattrapage de la violation d'unicité : un envoi neuf a pu prendre la place entre
la relecture et l'écriture, et c'est `notifications_live_once` qui l'arrête.

## Structure

| Fichier | Rôle |
|---|---|
| `notifications.types.ts` | Le vocabulaire du domaine — aucune coordonnée n'y figure |
| `notifications.repository.ts` | Le seul fichier qui connaisse le schéma ; porte `claim()` |
| `notification-dispatch.service.ts` | L'ordre d'écriture, et rien d'autre |
| `notification-sender.ts` | Le **port** vers SES/SNS, et son implémentation par défaut qui refuse |
| `notifications.errors.ts` | Le catalogue d'erreurs du module |

## Ce que ce module ne fait pas, délibérément

- **Aucune reprise maison.** Un échec remonte à SQS, qui réessaie avec son
  backoff natif avant la DLQ (notifications §4). Boucler ici doublerait la file
  et masquerait la profondeur de DLQ sur laquelle repose l'alarme CloudWatch.
- **Aucun appel depuis un chemin de requête HTTP.** « L'API ne parle jamais
  directement à SES ou SNS » (notifications §1) : une réservation ne doit pas
  échouer parce qu'un e-mail n'est pas parti.
- **Aucune coordonnée en base ni dans les messages de file.** Le destinataire est
  désigné par l'identifiant de son compte ; l'adresse se relit dessus au moment
  de l'envoi (CDC §5.1, notifications §7).
- **Aucune revérification du rendez-vous.** Un rappel ne doit pas partir si le
  rendez-vous a été annulé entre la sélection et l'envoi (notifications §3) —
  c'est une règle du **producteur**, et la poser ici ferait lire `appointments` à
  un module qui ne le possède pas (api-module §3).
- **Aucun contrôleur.** Le module n'est donc pas encore inscrit dans
  `app.module.ts`, comme `availability` (#41) et `appointments` (#31) avant leur
  premier endpoint.

## Ce que les tests prouvent

`__tests__/notification-dispatch.service.spec.ts` compte les appels à
l'expéditeur : deux livraisons du même message SQS n'en produisent **qu'un**.
Le double de dépôt y reproduit les deux uniques de la table, ce qui rend le
comptage significatif plutôt que tautologique.

`__tests__/notifications.migration.spec.ts` relit le SQL de migration et vérifie
que l'index existe, sur ces colonnes-là, avec ce filtre-là — le lecteur d'index
de `prisma-schema.spec.ts` ne reconnaissant que les index totaux.
