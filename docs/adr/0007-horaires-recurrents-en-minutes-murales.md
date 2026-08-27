# ADR 0007 — Un horaire récurrent se stocke en minutes murales, jamais en instant ni en `time`

- **Statut** : Accepté
- **Date** : 2026-08-27
- **Contexte CDC** : §1.4 Gestion du personnel, §2.3 Disponibilité et réservations, §6 Registre des risques

## Contexte

Le moteur de disponibilité (#34) construit les fenêtres de travail d'un
praticien à partir de ses **horaires récurrents** : « le mardi, de 09:00 à 12:00
et de 14:00 à 18:00 ». C'est la donnée d'entrée de tout le calcul de créneaux, et
la première que #32 devait poser en base.

Ces horaires ne sont pas des instants. [L'ADR 0006](0006-fuseaux-horaires-tenant.md)
a nommé la distinction et l'a tranchée pour le **code** : le décalage se recalcule
à chaque conversion depuis la tzdata IANA, il ne se mémorise jamais. Ce qui
restait ouvert est le **stockage** d'une heure murale, un cas que le schéma
initial n'avait pas : toutes ses colonnes temporelles sont des `timestamptz`,
parce que toutes ses données temporelles étaient des instants.

Trois contraintes se croisent ici :

1. un praticien a **plusieurs plages par jour** — la coupure méridienne du CDC
   §1.4 — donc plusieurs lignes par couple (praticien, jour) ;
2. l'établissement a des **jours de fermeture**, qui doivent retirer les fenêtres
   correspondantes sans qu'on ait à les retirer de chaque semaine de travail ;
3. **aucun décalage horaire ne doit être figé en base** : c'est un critère
   d'acceptation explicite de #32, et un bug de sévérité haute s'il tombe.

## Options envisagées

### Option A — Deux `timestamptz`, un par borne, sur une date de référence

L'horaire « mardi 09:00 » serait stocké comme l'instant correspondant à un mardi
arbitraire, et relu par sa partie horaire.

Fatale, et pour une raison qui ne se voit qu'en octobre : l'instant retenu porte
l'offset du jour où il a été **écrit**. Un horaire saisi en juillet à Paris
(`UTC+2`) se relirait `08:00` toute la saison d'hiver. L'agenda du salon serait
juste six mois par an, faux les six autres, et rien dans la donnée ne dirait
laquelle des deux moitiés est la bonne. C'est exactement le mode de défaillance
que l'ADR 0006 a écarté du code ; le laisser rentrer par le stockage n'aurait
rien réglé.

### Option B — Le type `time` de PostgreSQL

`time without time zone` dit littéralement « une heure sans fuseau », ce qui est
la bonne sémantique. PostgreSQL sait l'ordonner et le comparer.

Écartée pour deux raisons cumulées :

- `prisma-schema.spec.ts` interdit toute colonne temporelle qui ne soit pas
  `timestamptz`, et cette règle est **juste** : elle existe parce qu'un
  `timestamp` nu stocke une heure murale là où on croyait stocker un instant.
  L'exception aurait demandé de percer la règle qui protège précisément contre la
  confusion que cette table incarne ;
- le type ne dispense de rien. Convertir un `time` en instant demande de toute
  façon une date **et** un fuseau, exactement comme un entier. Il apporte donc la
  ressemblance avec un instant sans en apporter le service — la pire des deux
  situations.

### Option C — Des minutes depuis minuit local, en entier

`540` pour 09:00, `1440` pour minuit de fin de journée. Un entier ne peut se lire
que pour ce qu'il est : il ne ressemble à aucun instant, se compare sans
conversion, et se soustrait — une durée de plage est une soustraction.

Son coût est réel : il faut une conversion `HH:MM` ↔ minutes aux deux frontières,
et une contrainte `CHECK` pour borner la journée civile, là où un type dédié
l'aurait fait seul.

### Option D — Les jours de fermeture comme absence d'horaire

Plutôt qu'une table, ne poser aucun horaire le dimanche pour chaque praticien.

Écartée : un praticien embauché après coup rouvrirait le salon à lui seul. Sa
semaine ne saurait rien de la fermeture, et le calendrier public proposerait des
créneaux un jour où personne n'ouvre. La fermeture est un fait de
l'établissement ; elle se dit une fois, au même endroit que le fuseau.

## Décision

**Option C**, complétée d'une table de fermeture propre à l'établissement.

- `staff_schedules` porte `weekday` (ISO 8601, 1 lundi … 7 dimanche),
  `start_minute` et `end_minute` — des entiers, minutes depuis minuit **local**,
  borne haute exclue. Plusieurs lignes par couple (praticien, jour).
- `tenant_closing_days` porte les jours de fermeture **récurrents** de
  l'établissement. Les fermetures ponctuelles — jour férié, congés — portent une
  date et relèvent des plages bloquées (#33).
- La conversion en instants UTC se fait **à la lecture**, date par date, par
  `TenantClockService` (#41). Aucun décalage n'est stocké nulle part.
- La numérotation des jours est celle d'ISO 8601 et non le `0`-dimanche de
  `Date.prototype.getDay` : `0` est *falsy*, et le praticien du dimanche
  disparaîtrait au premier `weekday ?? défaut`.
- Le non-recouvrement des plages d'une même journée est garanti en base par
  `EXCLUDE USING gist` sur `int4range(start_minute, end_minute)` — la même
  doctrine que l'anti-double-réservation : la base tranche, le contrôle
  applicatif ne fait que nommer.

## Conséquences

**Ce que cela facilite.** Un horaire saisi une fois reste juste toute l'année, des
deux côtés des deux changements d'heure. La journée du passage à l'heure d'été
dure 23 heures et le calcul le sait, parce qu'il repose la question du décalage à
chaque date au lieu de la lire dans la ligne. Une plage entièrement contenue dans
le trou d'horloge — `02:00–03:00` fin mars à Paris — ne produit aucune fenêtre,
ce qui est le comportement exact.

**Ce que cela coûte.** Deux conversions à écrire et à tenir : `HH:MM` → minutes à
l'entrée, minutes → `HH:MM` à la sortie. Elles vivent dans un seul fichier
(`availability.schedule.ts`) et partagent le motif horaire du moteur de
conversion, mais elles existent. Et la borne haute d'une journée demande un
littéral de plus dans le contrat — `24:00` —, parce que `HH:MM` s'arrête à
`23:59` et qu'un salon qui ferme à minuit doit pouvoir le dire sans perdre une
minute.

**Ce que cela ferme.** Un horaire qui déborde sur le lendemain ne se dit pas d'une
seule ligne : `22:00–02:00` se décrit par deux plages, une par jour civil. C'est
une contrainte assumée — la borne à 1440 est ce qui rend « une plage appartient à
un jour » vrai sans exception, et sans elle le calcul de créneaux devrait, pour
chaque jour demandé, aller regarder la veille.

**Ce que cela laisse ouvert.** Le pas de créneau (`slot_interval`) et le délai
minimum de réservation (`min_booking_notice`) du CDC ne sont pas ici : ils
paramètrent le **découpage** des fenêtres, pas les fenêtres elles-mêmes, et
relèvent de #34.
