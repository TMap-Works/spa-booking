---
name: notifications
description: Chaîne de notifications e-mail et SMS — confirmations, rappels J-1 planifiés, avis d'annulation, modèles, délivrabilité, idempotence des envois. À charger avant de toucher apps/api/src/modules/notifications, les Lambda d'envoi, ou dès qu'une tâche parle de rappel, confirmation, e-mail, SMS, SES, SNS ou EventBridge.
---

# Notifications

Le CDC §1.4 limite le MVP à trois messages : **confirmation** à la réservation,
**rappel 24 h avant**, **avis d'annulation** au client et au staff. Rien d'autre —
le marketing et les campagnes sont post-MVP.

## 1. Architecture (CDC §4.8)

```
appointment.confirmed (événement domaine)
        │
        ▼
     SQS  ──►  Lambda d'envoi  ──►  SES (e-mail) / SNS (SMS)
        ▲                                  │
        │                                  ▼
EventBridge Scheduler                notification (statut en base)
 (balayage horaire J-1)
```

Deux déclencheurs, une seule voie de sortie :

- **Immédiat** : un événement domaine (`appointment.confirmed`,
  `appointment.cancelled`) publie un message SQS.
- **Planifié** : une règle EventBridge s'exécute toutes les heures, sélectionne
  les rendez-vous qui commencent dans 24 à 25 h et dont le rappel n'est pas
  encore envoyé, et publie un message SQS par rendez-vous.

L'API ne parle **jamais** directement à SES ou SNS. Un appel synchrone à un
fournisseur depuis le chemin de requête HTTP fait échouer une réservation parce
qu'un e-mail n'est pas parti — inacceptable.

## 2. Table `notifications` : la mémoire des envois

```
id, tenant_id, appointment_id, client_id,
type      -- confirmation | reminder_24h | cancellation
channel   -- email | sms
status    -- pending | sent | failed | suppressed
provider_message_id, sent_at, failed_at, error_code, attempts
```

Contrainte d'unicité :

```sql
CREATE UNIQUE INDEX notifications_once
  ON notifications (tenant_id, appointment_id, type, channel)
  WHERE status IN ('pending', 'sent');
```

C'est ce qui empêche le double rappel quand la règle EventBridge se chevauche ou
que SQS livre deux fois. **SQS garantit au-moins-une-fois, pas exactement-une-fois** :
l'idempotence est notre responsabilité, pas celle de la file.

Ordre correct dans la Lambda : insérer la ligne `pending` (échec en doublon =
déjà traité, on sort) → appeler le fournisseur → passer à `sent` avec le
`provider_message_id`.

## 3. Fenêtre du rappel J-1

- Le balayage horaire sélectionne `starts_at BETWEEN now()+24h AND now()+25h`.
- Un rendez-vous créé **moins de 24 h à l'avance** ne reçoit jamais de rappel :
  la confirmation en tient lieu. Ne pas envoyer un rappel « en retard ».
- Un rendez-vous annulé ou reporté **entre-temps** ne doit pas recevoir le rappel :
  la Lambda revérifie le statut au moment de l'envoi, pas seulement au moment de
  la sélection. L'écart entre les deux peut atteindre une heure.
- Le rappel est calculé dans le fuseau du tenant pour l'affichage de l'heure, mais
  la sélection se fait en UTC.

## 4. Échecs et reprises

- La Lambda laisse SQS gérer les reprises (backoff natif). Ne pas boucler avec
  des `retry` maison dans la fonction.
- Après N tentatives, le message part en **DLQ**. Une alarme CloudWatch sur la
  profondeur de la DLQ prévient l'équipe : un rappel non envoyé se traduit en
  no-show, donc en perte de chiffre d'affaires.
- Distinguer les échecs **permanents** (adresse invalide, numéro inexistant,
  désinscription) des **transitoires** (throttling, panne fournisseur). Un échec
  permanent passe en `suppressed` et ne doit pas être rejoué.

## 5. Délivrabilité (risque identifié au CDC §6)

**E-mail — SES**
- Domaine vérifié avec **DKIM, SPF et DMARC** configurés. Sans les trois, les
  messages finissent en spam et le rappel J-1 perd son intérêt.
- Sortir du bac à sable SES avant la mise en production (demande à faire tôt,
  le délai AWS n'est pas instantané).
- Traiter les notifications de **bounce et de plainte** via SNS : une adresse en
  hard bounce est marquée `suppressed` et n'est plus jamais sollicitée. Continuer
  à écrire à une adresse morte dégrade la réputation d'envoi de tout le domaine.

**SMS — SNS**
- Type de message `Transactional`, pas `Promotional` : priorité de routage
  supérieure et meilleure délivrabilité.
- Numéros au **format E.164** strict (`+261...`). Normaliser à la saisie, refuser
  ce qui n'est pas normalisable.
- Le SMS coûte cher et varie fortement par pays. Le CDC exclut le SMS de
  l'estimation budgétaire précisément pour cette raison : mettre un plafond de
  dépense mensuel et une alarme.
- Certains pays exigent un enregistrement préalable de l'expéditeur (sender ID).
  À vérifier pour Madagascar et la France avant le go-live.

## 6. Modèles de messages

- Les modèles vivent en base, par tenant, avec un modèle par défaut au niveau
  plateforme. Un salon doit pouvoir personnaliser sans déploiement.
- Variables disponibles : nom du client, nom du service, date et heure **dans le
  fuseau du tenant**, nom du praticien, nom et adresse du salon, lien d'annulation.
- **Échapper les variables** dans le rendu HTML : un nom de client contenant du
  HTML ne doit pas casser ni injecter dans l'e-mail.
- Toujours fournir une version texte brut à côté du HTML — les clients mail qui
  n'ont que du HTML sont pénalisés par les filtres anti-spam.
- Le SMS est court par nature : 1 segment GSM-7 = 160 caractères. Un accent hors
  GSM-7 bascule le message en UCS-2 et le limite à 70 caractères, doublant le
  coût. Vérifier la longueur des modèles français.

## 7. RGPD (CDC §5.1)

- Le rendez-vous relève de l'**exécution du contrat** : la confirmation et le
  rappel ne demandent pas de consentement.
- Tout message promotionnel exige un consentement explicite et un lien de
  désinscription — hors périmètre MVP, mais le champ `marketing_consent` existe
  dès maintenant sur le client pour ne pas avoir à migrer plus tard.
- Ne pas journaliser le contenu des messages ni les coordonnées en clair. Le log
  garde l'id de notification et l'id de message fournisseur.

## 8. Tests

- Idempotence : rejouer deux fois le même message SQS → un seul envoi.
- Un rendez-vous annulé après la sélection ne reçoit pas de rappel.
- Un rendez-vous créé à J-12 h ne reçoit pas de rappel.
- Le rendu du modèle affiche l'heure dans le bon fuseau, y compris au changement
  d'heure.
- Un hard bounce marque bien l'adresse en `suppressed`.
- En test, SES et SNS sont bouchonnés — aucun test n'envoie de vrai message.
