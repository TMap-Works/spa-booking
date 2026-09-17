# Espace client — `(account)/[tenantSlug]/compte`

Le troisième produit servi par `apps/web`, à côté du parcours public
`(booking)` et du tableau de bord admin à venir. Il répond au CDC §1.4 — « un
compte client avec historique » — et à l'issue #47.

Il n'a ni le même public ni les mêmes conventions que le tunnel : derrière
authentification, **non indexable**, et centré sur la relecture plutôt que sur la
conversion. Le mêler au tunnel aurait fait porter à la surface qui génère le
revenu — et qui vise un LCP < 2,5 s en 4G — un chrome que les moteurs ne verront
jamais.

## Les écrans

| Chemin | Session | Ce qu'il fait |
|---|---|---|
| `/{slug}/compte/connexion` | non | ouvre une session |
| `/{slug}/compte/inscription` | non | crée le compte et ouvre la session dans la foulée |
| `/{slug}/compte` | oui | les rendez-vous à venir et l'historique, avec report et annulation |
| `/{slug}/compte/coordonnees` | oui | prénom, nom, téléphone |
| `/{slug}/compte/rendez-vous/{id}/report` | oui | choix d'un nouveau créneau |
| `/{slug}/compte/session/refresh` | — | renouvelle la session et renvoie d'où l'on vient |
| `/{slug}/compte/session/fin` | — | ferme une session que l'API a révoquée |

La garde vit **dans chaque page**, par `readAccountData` (`session.ts`), et non
dans le layout : un layout n'est pas rejoué à chaque navigation dans l'App
Router, et une page peut être servie sans que son parent ait été réévalué. Les
deux écrans ouverts s'en passent délibérément, plutôt que d'être exemptés par une
liste tenue ailleurs — une liste d'exemptions finit toujours par contenir une
page de trop.

## La navigation appartient à l'espace, pas à un écran

« Modifier mes coordonnées | Se déconnecter » était rendue par `page.tsx` : elle
n'existait donc que sur **un écran sur trois**, et fermer sa session depuis ses
coordonnées demandait de revenir d'abord à la liste. L'audit `d20260916-1` relève
l'écart au titre de `ds:coherence` — *la même action se trouve au même endroit
d'un écran à l'autre d'un même espace* — et le CDC §2.4 ne connaît qu'un `User`
pour les trois écrans (#747).

La barre est donc posée par le gabarit (`components/account-nav.tsx`), et trois
choses en découlent :

| Décision | Pourquoi |
|---|---|
| peinte **seulement s'il y a une session** | connexion et inscription partagent ce gabarit ; « Se déconnecter » y offrirait de fermer une session qui n'est pas ouverte. Ce n'est pas une garde — un menu masqué n'interdit pas de taper l'URL, et la seule frontière qui compte est celle de l'API |
| **hors de `<main>`**, entre l'en-tête et le contenu | `<main>` porte le contenu de l'écran, pas sa navigation : rendue dedans, la barre récupérait le geste « aller au contenu principal » d'un lecteur d'écran. Dehors et avant lui, l'ordre du document énonce d'abord où aller, ensuite ce qu'on lit (WCAG 1.3.2) — et c'est ce qu'un lien d'évitement vers `#contenu` sauterait, le jour où le front en posera un |
| **Client Component**, pour `usePathname()` seul | le layout n'est pas rejoué à chaque navigation : un repère calculé côté serveur resterait figé sur le premier écran ouvert. Même arbitrage que le rail du back-office. Aucun jeton ne franchit la frontière — le gabarit ne passe qu'un slug |

Le lien reste présent sur l'écran qu'il désigne, `aria-current="page"` en plus :
le retirer là rendrait la barre différente d'un écran à l'autre, c'est-à-dire
l'écart qu'on corrige. Les classes CSS sont celles qui existaient déjà, et
`.spa-account` partage la gouttière de `.spa-account__main` — la barre change de
propriétaire, pas d'apparence.

Le pied de page complète la barre et n'en fait pas partie : « Prendre un nouveau
rendez-vous » et « Mes rendez-vous » sortent de l'espace ou y reviennent, là où
la barre range ce qui s'y fait.

## Les deux moitiés se nomment par ce qu'elles rangent

L'accueil partage la liste en **« Rendez-vous à venir »** et **« Historique »**,
et chacune porte son critère en légende. La coupure est celle que sert l'API
(`scope`, `appointments.repository.ts` · `listForClient`) : « à venir » est
l'intervalle non terminé **dont le statut occupe encore le créneau**,
l'historique en est le complément exact. Un rendez-vous annulé pour la semaine
prochaine tombe donc dans la seconde moitié tout en étant daté du futur — c'est
ce qui garantit qu'aucune ligne ne disparaît de l'espace client, et c'est
précisément pourquoi cette moitié ne peut pas s'intituler « Rendez-vous passés » :
elle annoncerait un critère de créneau là où elle range par statut (#744,
CDC §2.4).

## Un rendez-vous pas encore confirmé se dit d'un seul mot

Le produit en avait trois pour le même fait : le tunnel annonçait « Votre
rendez-vous est enregistré », son bouton disait « Confirmer la réservation », et
cet espace affichait « En attente de confirmation » sur ce rendez-vous-là, sans
dire ce qu'on attendait ni de qui (#743).

Le mot est désormais **« À confirmer par le salon »**, et il n'existe qu'une
fois : `components/appointment-status.ts` l'exporte
(`PENDING_CONFIRMATION_LABEL`), l'écran terminal du tunnel l'importe. Il nomme
l'acteur, ce qui lève la contradiction sans mentir — le rendez-vous naît bien
`PENDING` côté API, et reprendre le « Réservation confirmée » du wireframe
(Étape 6) aurait contredit la pastille au lieu de l'accorder.

Deux conséquences dans la même ligne :

- **la légende de « Rendez-vous à venir »** dit ce que l'attente attend, et que
  le créneau est déjà retenu — `pending` fait partie des
  `BLOCKING_APPOINTMENT_STATUSES`. Aucun délai chiffré : l'API n'en expose
  aucun ;
- **la pastille dépend de la moitié**, comme les gestes. Un rendez-vous resté
  `pending` dont l'heure est passée descend dans l'historique : il s'y lit
  « Non confirmé », parce qu'il n'y a plus de confirmation à attendre.

## Un état vide porte toujours une sortie

`docs/design/appointments/states.md` § « Règles générales » : *« Vide : toujours
accompagné d'une explication **et d'au moins une action** pour sortir de
l'impasse. Un cul-de-sac muet fait abandonner. »*

C'est sur un compte neuf que la règle se joue — les deux moitiés sont vides en
même temps, et à 360 px le lien de pied de page se trouve **sous** les deux
blocs. L'action est donc un paramètre **obligatoire** d'`AppointmentList` : une
moitié ne peut pas réintroduire le cul-de-sac par omission (#745).

| Moitié vide | Sortie | Rôle |
|---|---|---|
| Rendez-vous à venir | « Prendre rendez-vous » → `/{slug}/reservation` | accent — c'est elle qui commande l'écran |
| Historique | « Découvrir les prestations » → `/{slug}` | neutre — on n'archive rien sans avoir choisi un soin |

Deux sorties distinctes plutôt que deux exemplaires du même bouton : empilés,
deux boutons primaires ne hiérarchisent plus rien. Les liens portent les
primitives `.spa-button` du design system dans `.spa-empty-state`, qui est déjà
une colonne centrée — aucune classe nouvelle, donc aucun style à maintenir en
double (même motif que l'état vide du planning, #788).

L'écran de report a le sien à part : quand la fenêtre du calendrier est déjà au
maximum, « Voir plus de jours » n'a plus rien à élargir, et c'est
« Renoncer au report » — juste sous le bloc — qui reste la sortie.

## Un geste abouti s'annonce, dans une région posée d'avance

`docs/design/appointments/states.md` § « Règles générales » exige déjà qu'un état
vide ou d'erreur soit « annoncé via une région `aria-live` » ; WCAG 2.2 AA,
critère **4.1.3 Messages d'état**, étend la même exigence au succès. Or le report
et l'annulation ramenaient l'un et l'autre à la liste **sans un mot** : la carte
quittait « Rendez-vous à venir » et réapparaissait sous « Historique », souvent
hors de vue à 360 px (#746).

La région est montée par le **layout**, pas par la page, et cela pour deux
raisons qui sont les deux moitiés du ticket :

| Ce que le layout donne | Pourquoi la page ne pouvait pas |
|---|---|
| la région existe avant tout geste, et reste vide | une région `aria-live` insérée **avec** son message n'est annoncée par aucun lecteur d'écran de façon fiable |
| son état traverse la navigation du report vers la liste | l'App Router conserve le layout d'un écran à l'autre du segment ; un état porté par la page de report serait démonté avec elle |

Les deux gestes n'y écrivent donc qu'un message et le chemin où il doit se lire —
`components/account-announcement.tsx`. Le report annonce avant de naviguer, mais
rien ne s'affiche tant que la liste n'est pas là. Une fois lue, l'annonce
s'efface au premier détour : elle ne se rallume pas au retour sur la liste.

Rien ne transite par l'adresse. Un `?annonce=…` aurait rejoué le succès à chaque
F5, et se serait tu sur une seconde annulation faute de changer de valeur — là où
chaque phrase nomme l'heure du rendez-vous concerné, ce qui la distingue de la
précédente et dit **où la ligne est passée**.

Le bandeau visible est `components/ui/notification.tsx`, celui par lequel le
tunnel confirme sa réservation : même composant, mêmes tons — `success` pour un
report obtenu, `info` pour une annulation, qui réussit sans être une bonne
nouvelle.

## La session ne touche jamais le navigateur

C'est le cinquième critère de #47, et il est tenu par construction plutôt que par
discipline.

```
navigateur ──cookies httpOnly──▶ Next (serveur) ──Bearer / Cookie──▶ API
```

| Jeton | Où il vit côté front | Durée |
|---|---|---|
| accès | cookie `spa_account_access`, `httpOnly` | celle du jeton (`expiresIn`, moins 30 s) |
| rafraîchissement | cookie `spa_account_refresh`, `httpOnly` | celle qu'annonce le `Set-Cookie` de l'API |

Trois conséquences, et ce sont elles qui font la garantie :

- **aucun jeton n'entre dans le bundle.** `lib/api-client.ts` est *server-only*
  (il lit `API_URL`, non préfixée `NEXT_PUBLIC_`), les Client Components passent
  par les actions serveur d'`actions.ts`, et **aucune action ne rend un jeton** —
  elles rendent un profil, une liste, un message ;
- **rien dans `localStorage`.** Il n'y a pas d'endroit où l'écrire : `session.ts`
  est le seul module qui voit les jetons, et il ne connaît que `cookies()` ;
- **le cookie d'accès expire quand le jeton expire.** Le navigateur calcule
  l'échéance à partir de l'instant de réception : « le cookie a disparu » et
  « le jeton a expiré » sont donc le même état, sans dérive d'horloge à
  corriger.

Le cookie que pose l'API vit sur **son** domaine et sur `/api/v1/auth` : il
n'atteindrait jamais le navigateur, qui ne parle qu'à Next. Il est donc relu dans
la réponse (`readApiSessionCookie`) et réémis par le front sur son propre
domaine, avec le même régime — `httpOnly`, `sameSite: 'lax'`, `secure` hors
développement, et un `path` borné à l'espace client **de cet établissement**.

Ce dernier point n'est pas cosmétique : les jetons de l'API sont bornés à un
établissement, et un `path: '/'` ferait qu'une connexion chez un salon écraserait
la session ouverte chez un autre.

## Le renouvellement passe par une route, pas par un middleware

Poser un cookie demande une réponse, et un Server Component n'en écrit pas. Une
page qui découvre son jeton expiré redirige donc vers `session/refresh`, qui pose
la session neuve et la renvoie où elle allait. Un `middleware.ts` ferait le même
travail pour **toutes** les routes du front, tunnel de réservation compris, qui
n'a pas de session.

Ce chemin ne peut pas boucler : au retour, le cookie d'accès existe forcément —
sinon le renouvellement a échoué, et l'on est parti à la connexion sans repasser
par la page. Le `next` de la route est revalidé à l'arrivée, et borné à l'espace
client de l'établissement : sans quoi `?next=https://exemple.test` ferait de
cette route une redirection ouverte.

## Ce que cet espace ne fait pas

- **il ne change pas l'adresse e-mail.** Elle est l'identifiant de connexion et
  la clé de `@@unique([tenantId, email])` : la changer demande de vérifier la
  nouvelle adresse, sans quoi une faute de frappe rend le compte inatteignable.
  Le contrat l'exclut (`updateProfileRequestSchema`), le DTO de l'API la refuse,
  et le champ est en lecture seule avec la raison écrite à côté ;
- **il ne refait pas le tunnel de réservation.** Reporter ne change ni la
  prestation, ni le praticien, ni le prix — l'API le refuse explicitement. Le
  seul choix est le créneau ;
- **il ne double pas le cycle de vie.** La moitié servie (`scope`) et
  `isStillActionable` décident ensemble s'il faut *afficher* les boutons ; c'est
  l'API qui tranche, en 422, ce qui est réellement annulable. Les deux conditions
  sont nécessaires : un rendez-vous d'hier que le salon n'a pas marqué « honoré »
  reste `confirmed` et descend pourtant dans l'historique — l'annuler y
  **aboutirait**, et ferait passer pour annulée une visite qui a eu lieu.
