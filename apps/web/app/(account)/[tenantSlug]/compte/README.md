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
| `/{slug}/compte` | oui | les rendez-vous à venir et passés, avec report et annulation |
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
