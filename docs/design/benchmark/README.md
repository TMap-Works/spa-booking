# Benchmark du marché — ce que Booker et ses concurrents font à chaque étape

Relevé le 2026-09-16 (#805). Décision : [ADR 0011](../../adr/0011-standard-du-marche-reference-de-l-audit.md).

Le cahier des charges fait de Booker « le standard du marché » (CDC §1.2) et
bâtit ses priorités sur son analyse (§1.3). Ce dossier est la forme
**opposable** de cette comparaison : pour chaque étape de l'application, les
pratiques d'interface que les plateformes de référence ont en commun, écrites
de façon qu'un audit de conception puisse les citer et qu'un agent de
correction puisse les appliquer.

Il sert l'audit de conception (`/design-audit`, critère `ds:standard`) :
[.claude/skills/design-audit/SKILL.md](../../../.claude/skills/design-audit/SKILL.md) §5.1.

## Ce qu'il contient

| Fichier | Étapes |
|---|---|
| [parcours-client.md](parcours-client.md) | vitrine, choix du service, du praticien, du créneau, récapitulatif, coordonnées, paiement, confirmation |
| [espace-client.md](espace-client.md) | compte, rendez-vous à venir, historique, report, annulation, e-mails et SMS, coordonnées |
| [back-office.md](back-office.md) | tableau de bord, planning, rendez-vous au comptoir, clients, catalogue, personnel, réglages |
| [encaissement-reporting.md](encaissement-reporting.md) | encaissement, historique des ventes, remboursement, reçu, reporting |
| [transverse.md](transverse.md) | langage visuel, filtres et recherche, chargement, accessibilité, synchronisation |

## Les plateformes, et ce qu'on a pu en voir

| Plateforme | Parcours public | Espace client | Back-office |
|---|---|---|---|
| **Booker** (Mindbody) — la référence du CDC | observé (go.booker.com) | observé (ancien site public), extraits | extraits — le centre d'aide ne se lit pas directement |
| Fresha | observé | documenté | documenté |
| Planity — leader français | observé | documenté | — |
| Treatwell | observé | documenté (conditions de réservation) | — |
| Square Appointments | observé | documenté | documenté |
| Boulevard | — | documenté | documenté |
| Vagaro | bloque la navigation automatisée | documenté | extraits |
| Phorest | — | — | documenté |
| Timely, Zenoti, GlossGenius | — | — | extraits, quelques articles lus |

Booker, la référence nommée par le CDC, est aussi la moins lisible : son
tunnel public a été observé, mais son centre d'aide ne se lit que par
extraits. Ses motifs de back-office s'appuient donc toujours sur une autre
plateforme.

## Comment lire un motif

Chaque motif a exactement cette forme — `test_design_tickets.Benchmark` la
vérifie :

```markdown
### BM-ETAPE-nn — Ce que fait le motif, en une phrase

- **Étape** : tunnel — créneau
- **Ce que voit l'utilisateur** : ce qui est à l'écran, concrètement.
- **Pourquoi** : ce que cela évite ou permet.
- **À vérifier chez nous** : la question à poser à notre écran.
- **Sources** :
  - Fresha · observé · 2026-09-16 · https://…
  - Planity · observé · 2026-09-16 · https://…
```

Le **mode** de chaque source dit comment le motif a été établi, du plus fort
au plus faible :

| Mode | Ce qu'il veut dire |
|---|---|
| `observé` | vu à l'écran, dans un navigateur, à la date indiquée |
| `documenté` | décrit par un article du centre d'aide de la plateforme, lu en entier |
| `extrait` | article du centre d'aide identifié, mais connu seulement par l'extrait d'un moteur de recherche — la page refuse la lecture directe |
| `annoncé` | page marketing, fiche d'application ou note de version |

## Ce qui rend un motif citable

Un motif ne porte un identifiant `BM-…` que s'il remplit **les quatre**
conditions :

1. il est vu chez **deux plateformes au moins** — ce qu'une seule fait est une
   particularité, pas un standard ;
2. **une au moins** de ses sources est `observé` ou `documenté` — un extrait ou
   une annonce ne suffisent pas seuls ;
3. chaque source est **datée** ;
4. il relève du **périmètre MVP** (CDC §1.4). Avis, cartes cadeaux, fidélité,
   forfaits, marketing, place de marché : pas d'identifiant, parce que leur
   absence chez nous est voulue.

Ce qui ne remplit pas ces conditions figure en fin de fichier, sous « Vu, mais
sans identifiant » ou « À confirmer » : utile à lire, jamais à citer.

## Comment le citer

Dans un constat d'audit, par son identifiant :

```bash
MSYS_NO_PATHCONV=1 python scripts/design_tickets.py open --critere ds:standard \
  --reference "BM-CRENEAU-01" …
```

`scripts/design_tickets.py` vérifie que l'identifiant existe, ajoute le chemin
du fichier à la référence, et recopie le motif dans le ticket. Il refuse le
benchmark cité en entier (« docs/design/benchmark/ »), et refuse un constat
`ds:standard` qui ne cite aucun motif.

```bash
grep -rn '^### BM-' docs/design/benchmark     # tous les motifs citables
```

**S'inspirer du motif, jamais de l'identité.** Un ticket décrit la structure à
atteindre avec nos jetons (`apps/web/styles/tokens.css`) et nos composants
(`apps/web/components/ui/`). Ni logo, ni illustration, ni palette, ni texte
d'une marque tierce.

## La carte : quels motifs pour quel écran

L'auditeur lit, **avant d'ouvrir un écran**, les motifs de sa ligne. Les
motifs de [transverse.md](transverse.md) (`BM-VISUEL-*`, `BM-ECRAN-*`,
`BM-FILTRE-*`) valent pour tous.

| Écran | Route | Largeur d'abord | Motifs |
|---|---|---|---|
| Vitrine | `/[tenantSlug]` | 360 px | `BM-VITRINE-*` |
| Tunnel — service | `/[tenantSlug]/reservation` | 360 px | `BM-SERVICE-*`, `BM-TUNNEL-07` à `-12` |
| Tunnel — praticien | `/[tenantSlug]/reservation` | 360 px | `BM-PRATICIEN-*` |
| Tunnel — créneau | `/[tenantSlug]/reservation` | 360 px | `BM-CRENEAU-*`, `BM-PRATICIEN-04` |
| Tunnel — coordonnées et paiement | `/[tenantSlug]/reservation` | 360 px | `BM-TUNNEL-01` à `-06`, `BM-ANNUL-01` |
| Tunnel — confirmation | `/[tenantSlug]/reservation` | 360 px | `BM-CONFIRM-01`, `BM-RDV-03`, `BM-NOTIF-01` |
| Connexion et inscription client | `/[tenantSlug]/compte/connexion`, `…/inscription` | 360 px | `BM-COMPTE-*` |
| Espace client | `/[tenantSlug]/compte` | 360 px | `BM-COMPTE-01`, `BM-RDV-*`, `BM-HISTO-*`, `BM-ANNUL-*`, `BM-REPORT-05` |
| Report d'un rendez-vous | `/[tenantSlug]/compte/rendez-vous/[appointmentId]/report` | 360 px | `BM-REPORT-*`, `BM-CRENEAU-*` |
| Coordonnées | `/[tenantSlug]/compte/coordonnees` | 360 px | `BM-PROFIL-*` |
| E-mails et SMS | notifications (`apps/api`) | — | `BM-NOTIF-*`, `BM-CONFIRM-01` |
| Connexion au back-office | `/[tenantSlug]/admin/connexion` | 1280 px | transverses seulement |
| Tableau de bord | l'écran d'arrivée du gérant, et la synthèse de `/[tenantSlug]/admin/reporting` | 1280 px | `BM-DASH-*` |
| Planning | `/[tenantSlug]/admin/calendrier` | 1280 puis 1920 px | `BM-AGENDA-*`, `BM-COMPTOIR-*`, `BM-CAISSE-01` |
| Clients | `/[tenantSlug]/admin/clients` | 1280 px | `BM-CLIENT-*`, `BM-COMPTOIR-07` |
| Catalogue | `/[tenantSlug]/admin/catalogue`, `…/nouveau`, `…/rubriques`, `…/[serviceId]` | 1280 px | `BM-CATALOGUE-*` |
| Aperçu du catalogue | `/[tenantSlug]/admin/catalogue/apercu` | 360 px | `BM-SERVICE-*` |
| Personnel | `/[tenantSlug]/admin/personnel`, `…/[staffId]` | 1280 px | `BM-STAFF-*` |
| Encaissement | `/[tenantSlug]/admin/encaissement` | 1280 px | `BM-CAISSE-*`, `BM-VENTE-*`, `BM-REMBOURS-*`, `BM-TICKET-*` |
| Reporting | `/[tenantSlug]/admin/reporting` | 1280 px | `BM-RAPPORT-*`, `BM-DASH-*` |
| Réglages | `/[tenantSlug]/admin/reglages` | 1280 px | `BM-REGLAGE-*` |

Un écran qui n'est pas dans cette carte n'a pas de motif : il se juge sur les
neuf autres critères, et son absence se signale dans le compte rendu.

## La comparaison en direct

Pendant un audit, l'auditeur peut ouvrir ces pages **publiques** à la même
largeur que l'écran audité, pour joindre une capture « chez la référence ».
Ce sont de vrais établissements : quelques pages par audit, en lecture
seulement.

| Étape | Pages |
|---|---|
| Vitrine | https://www.fresha.com/a/la-cour-des-anges-paris-8-rue-rondelet-m2cbzkz3 · https://www.planity.com/studio-beaute-75008-paris · https://www.treatwell.fr/salon/l-institut-parisien/ |
| Tunnel (service, praticien, créneau) | https://go.booker.com/location/RainWellnessSpaV2/service-menu · https://book.squareup.com/appointments/viuejp3lzxwj5v/location/LSZTYRACWHD66/services · la vitrine Fresha ou Planity, puis « Réserver » |
| Récapitulatif et paiement | le tunnel Square ou Treatwell, **jusqu'au formulaire de coordonnées, sans le remplir** |
| Espace client, back-office | aucune page publique — s'en tenir au benchmark écrit |

Les bornes, sans exception : aucun compte, aucune connexion, aucune donnée
saisie, jamais au-delà de l'étape qui précède les coordonnées, une bannière de
cookies se refuse, un site qui bloque le robot se laisse. Une page qui a
changé depuis le relevé se signale « benchmark à rafraîchir » ; ce qu'elle
montre de nouveau, « benchmark à compléter ». Ni l'un ni l'autre n'est un
constat.

## Faire vivre le benchmark

- **Il ne se modifie pas pendant un audit.** Les comptes rendus disent ce qui
  manque ou a changé ; le benchmark se reprend ensuite, dans un ticket
  `ws:design` dédié.
- **Un identifiant n'est jamais renuméroté ni réattribué** : des tickets le
  citent. Un motif ajouté prend le numéro suivant de son étape ; un motif
  devenu faux est retiré, et son numéro reste libre à jamais.
- **Un nouveau motif** remplit les quatre conditions ci-dessus, et porte la
  date de son relevé. `python -m unittest scripts.tests.test_design_tickets`
  vérifie la forme.
- **Premier candidat à un relevé complémentaire** : l'accueil d'un back-office
  (rendez-vous restants du jour, file « à traiter »), aujourd'hui connu
  seulement par des extraits — voir [back-office.md](back-office.md).
