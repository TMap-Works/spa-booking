# Les mots du produit — glossaire FR/EN

Ce répertoire est la **source unique** des textes du front (#845) : un catalogue
par namespace, un répertoire par langue, `en` faisant foi pour le typage
(`i18n/catalog.d.ts`).

Ce fichier-ci ne décrit pas la mécanique, il fixe le **vocabulaire**. Il existe
parce qu'un catalogue complet et sans clé manquante peut rester mal écrit : la
recette de traduction du 2026-09-29 a trouvé le même écran nommé « Schedule »,
« planning », « calendar » et « agenda », des statuts dits « Honoured » d'un côté
et « Completed » de l'autre, et de l'orthographe britannique dans un produit
vendu à un client américain (#1329).

## Deux règles avant le glossaire

**L'anglais du produit est l'anglais américain.** `catalog` et non
`catalogue`, `canceled` / `canceling` et non `cancelled` / `cancelling`,
`recognized`, `honor`, `favor`, `toward`, `register` et non `till`. Une
exception qui n'en est pas une : **`cancellation` garde ses deux `l`** — l'anglais
américain ne simplifie que les formes fléchies du verbe.

**Une chose, un mot, dans toutes les langues.** Le même objet ne peut pas
s'appeler autrement selon l'écran qui le montre. Quand un doute survient, c'est
ce tableau qui tranche, et non l'écran voisin.

## Le glossaire

| Ce dont on parle | Français | English |
|---|---|---|
| La grille jour/semaine du back-office, l'écran et la chose | **planning** | **schedule** |
| La même, vue par un praticien pour lui seul | mon planning | my schedule |
| Le temps qu'une prestation occupe dans cette grille | le planning | the schedule |
| Le carnet de rendez-vous du salon, vu du dehors | le planning du salon | the salon's schedule |
| Le sélecteur de date du tunnel de réservation | calendrier | calendar |
| L'agenda personnel de la cliente, où l'export ICS dépose | **agenda** | calendar |
| La liste des prestations | catalogue | **catalog** |
| Un regroupement de prestations dans ce catalogue | rubrique | **section** |
| Une prestation | prestation | service |
| La personne qui exécute la prestation | praticien | practitioner |
| La personne qui réserve | cliente / client | client |
| Un rendez-vous | rendez-vous | appointment |
| Le créneau proposé à la réservation | créneau | slot |
| Rendez-vous qui a eu lieu (statut `completed`) | honoré | **completed** |
| Rendez-vous où la cliente ne s'est pas présentée (statut `no_show`) | non honoré | **no-show** (jamais « no show ») |
| Rendez-vous annulé (statut `cancelled`) | annulé | canceled |
| Ligne d'origine d'un report — annulée sans auteur | déplacé | rescheduled |
| Déplacer un rendez-vous | reporter / déplacer | reschedule |
| L'espace de travail du salon | back-office | back office |
| L'espace de l'éditeur, au-dessus des salons (ADR 0012) | console | console |
| L'encaissement au comptoir | la caisse | the register |
| La personne qui encaisse | caissier | cashier |
| Le terminal de paiement du salon (ADR 0015) | TPE | card terminal |
| Le reçu remis à la cliente | ticket | receipt |
| L'adresse web d'une page — `/maison-lotus` | adresse de la page | page address |

`slug` n'est pas dans ce tableau : c'est un mot de développeur. À l'écran, on dit
« adresse » ou « adresse de la page », dans les deux langues.

Trois mots français pour trois choses, et c'est délibéré : la grille du salon est
un **planning** — c'est le titre de l'écran et l'entrée du rail —, le sélecteur
de date du tunnel est un **calendrier**, et l'**agenda** est celui de la cliente,
dans son téléphone. L'anglais n'a pas ce luxe : `schedule` pour les deux
premières acceptions de service, `calendar` pour les deux qui concernent un
calendrier au sens propre.

## Registre

- **Une phrase montrée à quelqu'un commence par une capitale et finit par un
  point** — refus de validation compris. « Saisissez une adresse e-mail
  valide. », et non « adresse e-mail invalide ». Ce qui est une phrase et ce qui
  n'en est pas une, c'est la section suivante qui le dit ; le test du glossaire
  tient la règle sur les refus de validation depuis #1357.
- **Aucun terme d'implémentation à l'écran.** Ni « front end », ni « MVP », ni
  « slug », ni « API ». On dit ce que la personne peut en faire, pas comment
  c'est construit.
- **Les acronymes légaux ne se devinent pas.** « SIRET » sur un écran américain
  ne veut rien dire : on écrit « identifiant fiscal » / « tax identifier », et
  l'acronyme réel n'apparaît que là où la donnée est saisie.
- **Les pluriels passent par ICU**, jamais par « (s) ». `{count, plural, =0 {…}
  one {# …} other {# …}}` — et le cas `=0` se nomme, parce que « 0 fiche »
  s'écrit « Aucune fiche ».
- **Un libellé qui reçoit un nom propre ne présume pas de sa forme.** Un nom
  d'affichage abrégé finit par un point (« Yanis B. ») : la phrase qui l'insère ne
  doit pas en ajouter un second. Et le français élide — « la fiche d'Alice » —, ce
  que le message porte par un `select` sur l'argument `elision`
  (`lib/elision.ts`).

## Ce qui est une phrase, et comment la clé le dit

La règle de ponctuation ne peut pas valoir pour tout le catalogue : « Adresse
e-mail », « Rôle », « Écran à venir » ne sont pas des phrases et n'en prennent
ni la capitale de phrase ni le point final. Une règle aveugle rougirait sur des
centaines de libellés justes. Ce qui délimite le sous-ensemble est donc la
**clé**, et non la valeur.

**Un refus de validation est une phrase.** C'est le message qu'un formulaire
affiche quand la saisie est refusée — sous le champ, ou en verdict de
soumission. Deux formes le désignent, et deux seulement :

1. **La feuille vit sous un bloc nommé `errors` ou `fieldErrors`.**
   `form.errors.slugTooLong`, `login.fieldErrors.password`. C'est la forme à
   employer pour tout refus ajouté désormais : le nom du bloc suffit à classer la
   feuille, et le test la tient le jour où elle est écrite, sans rien inscrire
   nulle part. Au singulier, `error` n'est pas un bloc de refus —
   `admin-auth.error.title` coiffe un écran en erreur, pas une saisie fautive.
2. **La clé est inscrite au registre `REFUS_HORS_BLOC`** de
   [`tests/unit/messages-glossary.test.ts`](../tests/unit/messages-glossary.test.ts).
   Ce registre est là pour les refus qui **précèdent** la convention —
   `admin-settings.hours.pair`, `admin-staff.invite.invalid`,
   `admin-catalog.categoryForm.slugTaken`. Les ranger sous `errors` demanderait
   de renommer leurs clés dans les composants qui les lisent, ce qui n'a pas sa
   place dans un ticket de chaînes. La liste est **fermée** : elle n'exempte
   rien, elle étend la règle à des clés que leur nom ne trahissait pas.

**Trois choses n'en sont pas, sous un bloc de refus comme ailleurs :**

- **Un titre** — la feuille se nomme `title`, ou son nom finit par `Title`.
  « Connexion refusée », « Formulaire incomplet », « L'enregistrement a échoué ».
  Un titre nomme l'écran ou le verdict ; il ne prend pas de point. Le `body`
  qu'il coiffe, lui, est bien une phrase.
- **Un libellé de champ, un en-tête de colonne, une entrée de menu, un badge.**
  « Adresse e-mail », « Rôle », « réglé ». Aucun n'est une phrase, et plusieurs
  sont délibérément minuscules parce qu'ils s'insèrent dans une autre.
- **Un fragment destiné à être inséré** — `record.suppression.reasons.*`,
  `tunnel.consent.purposes.*.why`, `weekdaysInSentence.*`. La phrase qui les
  reçoit porte la ponctuation ; eux non.

Ce qui reste licite en tête de phrase : un `{argument}`, un chiffre, un
acronyme, un guillemet ouvrant. Seule une **lettre minuscule** est une faute.
Ce qui clôt : `.`, `!`, `?`, `…`. Un refus écrit en `plural` ou en `select` est
jugé **branche par branche** : chacune est une phrase entière, et l'accolade qui
l'ouvre ne la dispense de rien.

Où en est le catalogue : #1329 avait repris `booking.json`, `signup.json` et
`admin-auth.json`, et #1357 a fini le travail sur `admin-catalog.json`,
`admin-clients.json`, `admin-settings.json` et `admin-staff.json` — puis a posé
le test qui le tient. Le test ne lit que `apps/web/messages` ; hors de ce
répertoire, c'est encore la relecture qui tient la règle.

## Le champ laissé vide : c'est le contrat qui le dit, pas le catalogue

**Décision de #1373.** Quand un champ obligatoire est laissé vide, la phrase
affichée vient de `validationPhrases(locale).required`
([`packages/shared/src/errors/zod-messages.ts`](../../../packages/shared/src/errors/zod-messages.ts)),
et **d'aucun catalogue**. Trois clés portaient la même phrase, mot pour mot, dans
les deux langues — `admin-catalog.form.errors.nameRequired`,
`admin-catalog.categoryForm.errors.nameRequired`,
`admin-clients.contact.errors.required` — et elles n'existent plus.

La raison pour laquelle ces copies existaient était bonne, mais elle ne valait
pas pour ce champ-là. Elle vaut pour les phrases qu'un **schéma du contrat écrit
lui-même** : zod court-circuite ses cartes d'erreurs dès qu'une `issue` porte un
`message`, si bien que les littéraux français de `slugSchema` s'affichaient tels
quels sous un formulaire anglais — constat fait au navigateur en #849, et c'est
pour eux que ces formulaires portent encore leurs propres phrases. « Ce champ est
obligatoire. » n'est pas de celles-là : c'est la phrase **générique** que
`zodErrorMap` rend sur un `too_small` de plancher 1, traduite dans les deux
langues depuis #845. Un `.min(1)` sans message suffit donc à la faire venir, et
c'est déjà ainsi que le reste du produit procède — `RegisterForm`,
`StaffMemberForm` (`tests/unit/validation-i18n.test.tsx`).

Ce qui tient la décision, plutôt qu'une intention : deux tests. Les suites de
rendu lisent `validationPhrases(locale).required` au lieu de recopier la phrase —
elles rougissent le jour où un formulaire repose un message local. Et
[`tests/unit/messages-glossary.test.ts`](../tests/unit/messages-glossary.test.ts)
refuse qu'une feuille de catalogue redise cette phrase, où que ce soit.

**Ce qui reste au catalogue, et pourquoi.** Le plafond de longueur — « Ce champ
fait au plus {max} caractères. » — n'est pas le texte du contrat (« Ne dépassez
pas {max} caractères. ») : ce sont deux formulations différentes d'une même règle,
pas une copie, il n'y a donc pas de divergence à empêcher, et les unifier serait
un changement de texte visible hors des trois champs que #1373 nomme.

**Et la préférence pour « dire quoi faire » ?** Elle ne s'applique pas à ce
refus-ci, et c'est tranché : cette phrase reste un constat. Trois raisons.
D'abord, elle est **générique** — une seule phrase pour tous les champs vides du
produit : elle ne peut pas dire « Saisissez le nom de la prestation. » sans
nommer un champ qu'elle ne connaît pas, et ce que la personne doit faire, la
position du message sous le champ vide le dit déjà (il y est lié par
`aria-describedby`). Ensuite, une phrase par champ serait exactement la
duplication que #1373 retire — trois clés hier, une par champ obligatoire du
produit demain. Enfin, une instruction générique (« Remplissez ce champ. »)
changerait le texte de **tous** les formulaires et de `details.violations` de
toutes les routes de l'API : c'est un changement de contrat de la taille de
#1356, pas l'effet de bord d'une déduplication. La préférence garde tout son sens
là où un refus nomme une faute dont le remède ne se devine pas — « Adresse e-mail
invalide. » plutôt que « Saisissez une adresse e-mail valable. » —, et ce
chantier-là reste ouvert sur la table `VALIDATION_MESSAGES`, comme dit plus bas.

## Un refus que le contrat **nomme** ne se redit pas non plus

**Décision de #1387.** La règle ci-dessus vaut pour les dix tournures génériques
de `validationPhrases(locale)`. Elle vaut aussi, et pour la même raison, pour la
seconde table de
[`zod-messages.ts`](../../../packages/shared/src/errors/zod-messages.ts) : les
**trente-quatre refus que les schémas nomment eux-mêmes** par `messageKey(…)` —
`identifier.slug`, `identifier.phone`, `platform.totpCode`,
`availability.scheduleOverlap`… Une feuille de catalogue qui redit une de
celles-là crée la même paire de sources non reliées, avec un risque supérieur :
ces phrases-là sont plus spécifiques, donc plus tentantes à recopier dans le
catalogue d'un écran.

Et le risque était déjà réalisé. `platform.login.fieldErrors.totpCode` redisait
`platform.totpCode` mot pour mot en français, et en **divergeait** en anglais —
« Six digits, as your authenticator app shows them. » au catalogue contre « Six
digits, as shown by your authenticator app. » au contrat. Aucune garde ne le
voyait : celle de #1376 ne comparait qu'aux phrases de `validationPhrases`. La
clé n'existe plus, `FIELD_ERROR_KEYS.totpCode` est à `null`, et c'est
`zodErrorMap(locale)` qui répond — le `refine` de `platformLoginRequestSchema`
pose déjà la clé de message.

**Ce qui tient la décision.** Un second cas dans
[`messages-glossary.test.ts`](../tests/unit/messages-glossary.test.ts), jumeau du
précédent, qui compare les catalogues aux phrases **fixes** de
`VALIDATION_MESSAGES`. Et un cas de rendu bilingue dans
[`refus-de-saisie-vient-du-contrat.test.tsx`](../tests/unit/refus-de-saisie-vient-du-contrat.test.tsx),
qui lit la phrase au contrat plutôt que de la recopier — sans lui, un écran
pourrait avoir perdu sa clé et n'afficher plus rien.

**La garde est sans exception, et `COPIES_DE_MESSAGES_TOLEREES` est vide.**
Décision de #1388. Il n'y a pas de liste de dispensations à tenir, et il n'y en a
plus : une feuille de catalogue qui redit une phrase fixe de `VALIDATION_MESSAGES`
est un défaut, dans n'importe quel namespace et dans n'importe laquelle des deux
langues. Le remède est toujours le même — poser `messageKey(…)` sur le schéma du
contrat, retirer la clé des deux catalogues, laisser `zodErrorMap(locale)`
répondre, et faire lire la phrase au contrat par la suite de rendu qui la cite —,
jamais d'inscrire une exception.

Cela n'a pas toujours été le cas, et l'historique dit pourquoi la liste existait :
#1387 portait sur l'empreinte `contracts:shared, web/identity`, et son recensement
avait trouvé huit autres feuilles fautives sur cinq écrans qu'il ne pouvait pas
toucher — d'autres tickets du même jalon y travaillaient en parallèle. Les inscrire
nommément, avec leur motif, valait mieux que de ne pas poser la garde : une
neuvième copie écrite le lendemain rougissait, et les huit restantes étaient
écrites noir sur blanc. **#1388 les a écoulées toutes les huit**, et la liste est
partie avec elles. C'est le même arbitrage, et la même fin, que
`booking.tunnel.contactStep.errors.required` : laissée en dispense par #1373 le
temps qu'un ticket vienne reprendre le tunnel public, reprise par #1376 du même
geste que la dispense.

Si un écran paraît avoir besoin d'y réinscrire une clé, c'est un écran qui redit
une phrase que le contrat sait déjà dire : la liste reste vide, et c'est le schéma
qu'on corrige.

**Ce qui n'est pas concerné.** Trois cas, et ils ne sont pas des oublis.

- Les phrases **paramétrées** de la table — six clés sur trente-quatre, qui
  interpolent une borne ou une nature d'identifiant. Un catalogue écrit la même
  chose avec un argument ICU (`{max}`), et les deux textes ne s'égalisent pour
  aucune valeur : la comparaison littérale ne dirait rien. C'est la limite déjà
  posée par #1376 sur `tooShort`, `tooLong` et leurs pareilles.
- Les **reformulations**, qui ne sont pas des copies. `login.fieldErrors.password`
  reste au catalogue et dit « Le mot de passe fait au moins {min} caractères. » là
  où le contrat dit « Saisissez au moins {min} caractères. » : elle **nomme le
  champ**, ce qu'une phrase générique ne peut pas faire. Même chose pour
  `admin-settings.hours.order` et pour `platform.create.fieldErrors.slugReserved`,
  proches sans être identiques. #1388 en a laissé deux de plus là où il retirait
  leurs voisines : `admin-catalog.form.errors.slugTooLong` — « Cette adresse fait
  au plus {max} caractères. » — et `signup.fieldErrors.slug`, qui annonce la borne
  de 63 caractères que le motif du contrat ne dit pas. Un cas de
  `refus-de-saisie-vient-du-contrat.test.tsx` interdit qu'un ticket de
  déduplication les emporte au passage. Troisième voisine laissée en place :
  `admin-staff.schedule.endBeforeStart` — « La fin d'une plage doit suivre son
  début. » — là où `availability.scheduleRangeOrder` dit « … doit être strictement
  postérieure à son début. ». Les deux disent la même règle, aucune ne redit
  l'autre, et la grille garde la formulation courte qui tient sous une ligne de
  saisie.
- Les **indications**, qui ne sont pas des refus. `platform.login.totpHint` — « Les
  six chiffres affichés par votre application d'authentification. » — est le texte
  d'aide posé sous le champ, lu **avant** toute saisie ; le refus, lui, ne paraît
  qu'après. Deux rôles, deux textes, même s'ils se ressemblent.

## Ce que la langue ne change pas

Les **paramètres d'URL** et les **segments de route** restent français
(`?periode=`, `/reservation`, `/calendrier`) : un lien partagé entre deux
collègues doit ouvrir le même écran quelle que soit la langue de chacun.

Ce glossaire vaut aussi pour les textes **hors de ce répertoire** qui partent chez
la cliente ou qu'elle lit : les modèles d'e-mail et de SMS de
`apps/api/src/modules/notifications/notification-default-templates.ts`, le
vocabulaire du PDF du reçu
(`apps/api/src/modules/payments/receipt-pdf/receipt-pdf.vocabulary.ts`) et les
refus de validation du contrat partagé
(`packages/shared/src/errors/zod-messages.ts`). #1356 y a porté l'orthographe
américaine et la règle de ponctuation — capitale en tête, point final —, et a
sorti « slug » des refus de validation. Ce qui reste à faire de ce côté-là est
nommé : les refus du contrat énoncent encore une faute (« Adresse e-mail
invalide. ») là où ce glossaire préfère dire quoi faire (« Saisissez une adresse
e-mail valide. »).

Les **noms de clés** de ces catalogues non plus. Plusieurs reprennent une valeur
d'énumération du contrat partagé — `appointment-status.json` porte `cancelled` et
`no_show` parce que `AppointmentStatus` les nomme ainsi. Ce sont des
identifiants ; seules leurs valeurs sont du texte.
