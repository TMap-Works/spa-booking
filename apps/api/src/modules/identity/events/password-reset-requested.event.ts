/**
 * L'événement de domaine `password-reset.requested` — quatrième critère
 * d'acceptation de #809, « le message part par la chaîne de notifications ».
 *
 * ## Pourquoi un événement et pas un appel direct
 *
 * Parce que le sens de la dépendance est déjà fixé, et qu'il ne peut pas
 * s'inverser : `notifications` importe `IdentityModule` — il en tire les gardes
 * de ses routes — si bien qu'un `identity` qui appellerait `NotificationsService`
 * formerait un cycle que Nest refuse au démarrage.
 *
 * Ce n'est pas un contournement technique, c'est le bon sens de dépendance
 * (api-module §3) : `identity` annonce qu'un accès est en cours de récupération,
 * et c'est à `notifications` de décider qu'un tel fait mérite un e-mail. Le
 * module qui authentifie n'a pas à savoir qu'une chaîne SES existe, exactement
 * comme `appointments` ne sait rien des confirmations qu'il déclenche.
 *
 * Et la conséquence est celle que le premier critère demande : la route **répond
 * toujours 202**, sans attendre l'envoi. Un abonné qui échoue est journalisé et
 * jamais propagé (`IdentityEvents.subscribe`), si bien qu'une panne de SES ne
 * transforme pas une demande légitime en erreur affichée à quelqu'un qui n'a
 * plus accès à son compte.
 *
 * ## Ce que la charge utile porte — et pourquoi elle porte un secret
 *
 * `AppointmentCreatedEvent` ne transporte que des identifiants, et sa doctrine
 * est écrite : « un abonné qui a besoin de la joindre relit sa fiche ». Cet
 * événement-ci déroge sur **un** champ, `token`, et la dérogation n'est pas un
 * relâchement : elle est la conséquence directe du deuxième critère
 * d'acceptation.
 *
 * Le jeton est **stocké haché**. Il n'existe en clair qu'à l'instant de son
 * émission, et rien — ni la base, ni une seconde lecture, ni une dérivation — ne
 * permet de le reconstituer ensuite. La règle « le message désigne, le
 * destinataire relit » ne peut donc pas s'y appliquer : ce qu'il faudrait relire
 * n'existe nulle part, par construction et à dessein.
 *
 * Trois propriétés bornent ce que ce champ coûte, et c'est ce qui rend la
 * dérogation acceptable :
 *
 * 1. **ce n'est pas une donnée personnelle.** C'est un aléa signé — il ne dit ni
 *    qui, ni où, ni quoi. La règle de notifications §7 protège les coordonnées
 *    et le contenu des messages ; elle n'a rien à dire d'un nombre aléatoire ;
 * 2. **il se périme seul, en trente minutes, et meurt au premier usage.** Un
 *    rejeu tardif de la chaîne d'envoi ne produit pas un accès : il produit un
 *    lien mort, c'est-à-dire exactement ce qu'un lien de réinitialisation doit
 *    devenir ;
 * 3. **il n'est journalisé nulle part.** `IdentityEvents` ne journalise que le
 *    nom de l'événement, l'établissement et le compte ; le publieur de file et
 *    la route interne de `notifications` journalisent la clé de déduplication,
 *    le type et le canal. Aucun de ces chemins ne sérialise la charge utile.
 *
 * Le reste est la discipline habituelle : ni adresse e-mail, ni nom, ni numéro.
 * L'abonné relit la coordonnée sur le compte au moment d'envoyer, comme pour les
 * trois autres messages.
 *
 * `tenantId` y est pour la raison qui vaut pour tous les événements de ce
 * dépôt : un abonné s'exécute hors de la portée de tenant de la requête qui l'a
 * produit, et sans lui il n'aurait aucun établissement à rouvrir — ou pire, en
 * devinerait un.
 */

/** Le nom sous lequel l'événement est publié. */
export const PASSWORD_RESET_REQUESTED = 'password-reset.requested' as const;

/**
 * Quelqu'un a demandé à récupérer l'accès d'un compte, et le jeton vient d'être
 * armé en base.
 *
 * Émis **après** l'écriture de l'empreinte, jamais avant : annoncer un jeton que
 * la base n'a pas encore accepté enverrait un lien qui ne pourrait rien ouvrir —
 * la symétrie exacte du « publié après validation de la transaction » des
 * événements de rendez-vous.
 *
 * Il n'est pas émis du tout quand rien n'est à envoyer : adresse inconnue,
 * compte désactivé, ou demande trop rapprochée de la précédente. C'est ce qui
 * fait que la réponse 202 uniforme ne coûte aucun message.
 */
export interface PasswordResetRequestedEvent {
  readonly name: typeof PASSWORD_RESET_REQUESTED;
  /** L'établissement — sans lui, aucun abonné asynchrone ne sait où regarder. */
  readonly tenantId: string;
  /** Le compte dont l'accès se récupère. L'adresse se relit dessus. */
  readonly userId: string;
  /**
   * Le jeton en clair, à mettre dans le lien — voir l'en-tête pour ce que ce
   * champ déroge et pourquoi.
   */
  readonly token: string;
  /** Instant d'émission, ISO 8601 UTC. */
  readonly occurredAt: string;
}
