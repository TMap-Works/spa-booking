# ADR 0006 — Un verrou consultatif par agenda de praticien ordonne les insertions de rendez-vous

- **Statut** : Accepté
- **Date** : 2026-08-27
- **Décideurs** : équipe backend
- **Contexte CDC** : §2.3 Réservations, §6 Registre des risques — complète l'[ADR 0002](0002-anti-double-reservation.md)

## Contexte

L'[ADR 0002](0002-anti-double-reservation.md) fait de la contrainte d'exclusion
PostgreSQL la **source de vérité** de l'unicité du créneau. #31 l'a posée :

```sql
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, staff_id WITH =, time_range WITH &&)
  WHERE (status IN ('PENDING', 'CONFIRMED'));
```

Elle tient sa promesse — jamais deux rendez-vous chevauchants pour un même
praticien — mais l'exercer sous concurrence réelle a révélé un mode de
défaillance que l'ADR 0002 n'avait pas anticipé, et que seul un test contre un
vrai moteur pouvait montrer.

Une insertion sous contrainte d'exclusion pose son entrée d'index, **puis**
attend les transactions concurrentes qui détiennent une entrée en conflit, pour
savoir si elles valideront ou non. Quand N insertions concurrentes visent des
intervalles **décalés mais mutuellement chevauchants** — ce que produit
n'importe quelle grille de créneaux au quart d'heure pour un soin d'une heure —
chacune attend toutes les autres. Le graphe d'attente est un cycle : c'est un
interblocage.

Mesuré sur ce schéma, huit réservations concurrentes décalées d'une minute :

| | Sans verrou | Avec verrou |
|---|---|---|
| Durée totale | **7 021 ms** | **31 ms** |
| Succès | 1 | 1 |
| Refus rendus aux perdantes | 7 × `40P01` *deadlock detected* → **HTTP 500** | 7 × `23P01` → **HTTP 409** |

PostgreSQL abat une victime par `deadlock_timeout` (une seconde par défaut), et
il faut donc N−1 secondes pour qu'une gagnante émerge. Surtout, les perdantes
reçoivent un SQLSTATE qui **n'est pas** une violation de contrainte : elles n'ont
rien appris de l'agenda, leur créneau peut être libre, et le contrat de #31 —
« jamais un 500 » — est rompu.

## Options envisagées

### Option A — Réessayer l'insertion après un interblocage

C'est la conduite que documente PostgreSQL pour `40P01`, et elle est correcte en
général. Elle ne suffit pas ici : la victime revient dans un cycle **encore
actif** — la gagnante n'a pas fini d'attendre — et s'y fait abattre à nouveau.
Mesuré : trois tentatives ne suffisent pas, la durée passe de 7 s à 23 s et les
500 restent.

### Option B — Allonger ou raccourcir `deadlock_timeout`

Le raccourcir accélère la détection mais multiplie les faux positifs sur toute la
base ; l'allonger empire l'attente. Dans les deux cas, c'est un réglage global
d'instance pour un problème local à une table, et RDS le rend commun à tous les
environnements. Le nombre de 500 ne change pas.

### Option C — Sérialiser les écritures par agenda de praticien

Un verrou consultatif de transaction pris **avant** l'insertion, sur une clé
dérivée de `(tenant_id, staff_id)` :

```sql
SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint));
```

Une seule insertion à la fois pour un praticien donné. Le cycle d'attente ne peut
plus se former : les candidates attendent leur tour, et celle qui l'obtient
trouve une ligne **déjà validée** — donc un refus immédiat et propre en `23P01`,
que le repository traduit en 409.

### Option D — Ne rien faire et accepter les 500

Écarté sans hésitation : la double réservation est le risque n°1 du CDC §6, et le
chemin qui la referme ne peut pas être celui qui rend l'application instable sous
la charge où elle compte.

## Décision

Option C. `AppointmentsRepository.create` ouvre une transaction, y prend un
verrou consultatif dont la clé est
`appointments:tenant_id=<tenant>:staff_id=<praticien>`, puis insère.

L'option A est **conservée en filet**, bornée à trois tentatives : le verrou
couvre le chemin de création, pas les écritures concurrentes venues d'ailleurs —
un changement de statut, un report. Une contention qui survivrait aux trois
tentatives remonte telle quelle, en 500 : c'est alors un incident qui mérite
d'être vu dans les journaux plutôt que maquillé en refus métier.

Trois propriétés font que ce verrou ne relâche rien :

1. **Il ne décide pas.** La contrainte reste seule juge de la disponibilité. Le
   verrou ne décide que de l'**ordre** dans lequel les candidates se présentent.
   Un chemin d'écriture qui l'oublierait — un script, un `psql` — resterait tenu
   par la contrainte ; il retrouverait seulement les interblocages.
2. **Il est `_xact_`.** PostgreSQL le relâche à la validation ou à l'annulation
   de la transaction, jamais à la main. Aucun chemin d'erreur ne peut le laisser
   pris, et aucun `finally` n'a à s'en charger.
3. **Sa clé est un paramètre lié.** L'identifiant de praticien vient de
   l'appelant : concaténé dans le texte de la requête, il serait une injection
   SQL.

Ce verrou n'est **pas** celui du CDC §2.3 repris par l'ADR 0002 comme « confort
d'interface » : celui-là vivra dans Redis (#38), durera le temps d'une saisie de
paiement, et sert à ne pas afficher un créneau à deux personnes. Celui-ci dure
une insertion et sert l'ordonnancement. Les deux coexistent, et aucun des deux ne
remplace la contrainte.

## Conséquences

**Ce que cela facilite.** Les collisions de créneau redeviennent ce qu'elles
doivent être : un 409 immédiat, que le front sait traiter en réaffichant les
créneaux. La latence sous concurrence tombe de deux ordres de grandeur. Le test
de concurrence obligatoire (booking-engine §6) devient déterministe, donc
utilisable en CI.

**Ce que cela coûte.** Les créations de rendez-vous d'un même praticien sont
sérialisées. Le coût réel est nul — un praticien ne fait qu'un soin à la fois, et
l'insertion dure quelques millisecondes — mais la propriété est à connaître : une
reprise de données qui insérerait en masse sur un seul praticien ne profitera
d'aucun parallélisme. Une telle reprise doit passer par `PRISMA_UNSCOPED` et son
propre chemin, pas par ce repository.

La création passe désormais par une **transaction interactive**, qui retient une
connexion du pool le temps du verrou. Le pool devient donc un plafond de
concurrence sur les réservations. À la taille du MVP c'est sans effet ; à
l'échelle, c'est le premier réglage à regarder.

**Ce que cela ferme.** Le verrou est pris sur `(tenant_id, staff_id)`, donc sur
l'agenda d'**un** praticien. Une règle qui porterait sur une ressource partagée —
une cabine, un équipement, un poste — ne serait pas couverte : elle demanderait
sa propre contrainte d'exclusion et sa propre clé de verrou. C'est hors du
périmètre MVP (CDC §1.4), et cela reste une décision à prendre le jour où la
ressource entre au modèle.
