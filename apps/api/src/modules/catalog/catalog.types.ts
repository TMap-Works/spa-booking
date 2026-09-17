/**
 * Formes de données du module `catalog` — CDC §2.3 « services, catégories,
 * durée, prix ».
 *
 * ## Ce que #510 a fait de l'accord avec le contrat, et pourquoi pas un import
 *
 * Ces interfaces sont des **vues de domaine** : ce que le service rend, en
 * amont de la frontière HTTP. Ce que le contrat décrit, ce sont les formes qui
 * **franchissent** cette frontière, et c'est là que l'accord se vérifie —
 * `dto/service.dto.ts`, `dto/service-category.dto.ts` et
 * `dto/public-service.dto.ts` portent depuis #510 des assertions de compilation
 * contre `z.input<serviceSchema>`, `z.input<serviceCategorySchema>` et
 * `z.input<publicServiceSchema>`. Un champ ajouté d'un côté et pas de l'autre
 * casse le `tsc`, ce qu'un simple alias de type n'aurait pas fait mieux.
 *
 * Écart assumé, tranché en #554 : remplacer malgré tout ces interfaces par les types inférés du
 * contrat reste souhaitable — une écriture de moins —, et deux choses s'y
 * opposent, dont aucune ne se tranche depuis ce module. La première :
 * `z.infer<...>` ne porte pas `readonly`, là où toutes les vues de ce fichier
 * le sont ; substituer rendrait modifiable en place ce que le service rend, et
 * `PublicServiceView.staff` est précisément un tableau qu'on ne veut pas voir
 * réordonné par son lecteur. La seconde : le contrat nomme `Service` et
 * `ServiceCategory` ce que ce module nomme `ServiceView` et
 * `ServiceCategoryView`, et l'homonymie avec les entités Prisma du même nom est
 * exactement ce que le suffixe `View` existe pour éviter. Reste à faire :
 * décider, côté contrat, s'il publie des types `readonly` — et sous quels noms.
 *
 * ## Aucune de ces formes ne porte de `tenantId`
 *
 * Ni en entrée, ni en sortie. En entrée, parce que le tenant vient du contexte
 * d'authentification et de nulle part ailleurs (tenant-isolation §2) : un champ
 * dans un DTO serait exactement le paramètre que le client contrôle. En sortie,
 * parce que c'est une information interne qui n'apporte rien au consommateur et
 * invite aux essais (§4).
 */

/**
 * Un montant : entier dans la plus petite unité, et le code devise qui lui donne
 * son sens. **Jamais de flottant** (CLAUDE.md).
 *
 * Les deux voyagent dans le même objet, et non en deux champs plats comme en
 * base : deux champs indépendants dans une charge utile peuvent être mis à jour
 * séparément, et il existe alors un instant où le montant est celui de l'ancienne
 * devise. La mise à plat vers `price_amount_minor` / `price_currency` est la
 * responsabilité du repository.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Une catégorie telle que l'API la rend. */
export interface ServiceCategoryView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
}

/** Forme réduite, telle qu'imbriquée dans une prestation. */
export interface ServiceCategorySummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Une prestation telle que l'API la rend.
 *
 * La catégorie est **imbriquée** plutôt que réduite à son identifiant : un écran
 * de catalogue affiche le libellé, et le rendre obligerait sinon le front à une
 * seconde requête ou à un appariement côté client.
 */
export interface ServiceView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: ServiceCategorySummary | null;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  /**
   * Durée réellement bloquée sur l'agenda du praticien, tampons compris.
   *
   * Dérivée et non stockée : une colonne de plus se désynchroniserait de ses
   * trois termes à la première mise à jour partielle. Elle est rendue parce que
   * c'est la valeur dont le calendrier admin a besoin, et que la recalculer côté
   * front exposerait la règle à diverger.
   */
  readonly occupiedMinutes: number;
  readonly price: Money;
  readonly isActive: boolean;
  /**
   * Combien de praticiens pratiquent la prestation, **désactivés compris**.
   *
   * Rendu parce que la liste du back-office doit distinguer une prestation active
   * que personne ne pratique d'une prestation réservable, sans ouvrir chaque
   * fiche. Le compte vient d'une agrégation unique pour tout le lot lu — jamais
   * d'une requête par ligne, qui ferait payer un aller-retour par prestation du
   * catalogue.
   *
   * Les désactivés y sont comptés pour que la liste dise la même chose que la
   * fiche, qui les garde sous « Compte désactivé ». Ce compte ne dit donc rien de
   * la réservabilité : c'est `activeAssignedStaffCount` qui y répond.
   */
  readonly assignedStaffCount: number;
  /**
   * Combien de ces praticiens sont **actifs**, donc réservables (#895).
   *
   * Le même ensemble que `PublicServiceView.staff`, réduit à son cardinal : c'est
   * de ceux-là, et d'eux seuls, que le moteur de disponibilité tire des créneaux.
   * `0` vaut « aucun créneau en ligne », que personne ne soit affecté ou que tous
   * les affectés soient désactivés — deux causes que la liste du back-office doit
   * distinguer, et qu'un compte unique confondait.
   *
   * Toujours inférieur ou égal à `assignedStaffCount`, dont il est un
   * sous-ensemble.
   */
  readonly activeAssignedStaffCount: number;
}

/**
 * Une **fiche praticien** de l'établissement, telle que le back-office la liste.
 *
 * `id` est celui de la fiche — de la table `staff` —, et non celui du compte qui
 * la porte. C'est la distinction que #421 vient corriger : `GET /v1/users` rend
 * des comptes, dont l'identifiant n'est pas celui qu'attend
 * `POST /services/:serviceId/staff`. Cet identifiant-ci l'est.
 *
 * `isActive` y figure parce qu'un praticien désactivé reste une fiche de
 * l'établissement : c'est à l'écran de décider s'il le propose, pas à l'API de
 * le lui cacher — et un praticien déjà affecté qu'on masquerait ferait croire à
 * une affectation perdue.
 *
 * Pas de `userId` : il révélerait le compte derrière la fiche.
 *
 * `bio`, en revanche, y figure depuis #771. Ces routes-ci **sont** la fiche —
 * c'est par elles que le back-office ouvre ce qui est publié sous le nom de la
 * praticienne pour le corriger —, et le taire condamnait l'écran à réécrire de
 * mémoire un texte qu'il ne voyait nulle part. Il reste absent de
 * `ServiceStaffMemberView`, où la fiche n'est qu'une ligne d'une liste de cases
 * à cocher.
 *
 * Le champ est **facultatif et jamais `null`** : c'est la forme exacte de
 * `staffMemberSchema` de `@spa/shared` (`bio: longTextSchema.optional()`), que
 * `dto/staff.dto.ts` vérifie à la compilation et que le front parse déjà. Une
 * fiche sans présentation rend donc une charge utile **sans la clé**, plutôt
 * qu'un `null` que le contrat refuserait.
 */
export interface StaffMemberView {
  readonly id: string;
  readonly displayName: string;
  readonly bio?: string;
  readonly isActive: boolean;
}

/**
 * Un praticien affecté à une prestation, tel que le back-office le liste.
 *
 * Déclarée à part de `StaffMemberView` depuis #771, où les deux ont cessé de se
 * confondre : la fiche rend désormais sa présentation, cette liste-ci non. Le
 * contrat partagé pose exactement la même frontière —
 * `serviceStaffMemberSchema` y est `staffMemberSummarySchema.extend({ isActive })`,
 * soit `staffMemberSchema` **sans** `bio` —, et un alias ferait tomber en panne
 * de compilation l'assertion de `dto/service-staff.dto.ts` au premier champ
 * ajouté à la fiche.
 *
 * Ce que l'écart coûte est ce qu'il achète : une liste d'affectations d'un
 * catalogue entier ne transporte pas deux mille caractères de vitrine par ligne,
 * pour les afficher nulle part.
 *
 * `isActive` compte ici pour une raison propre : une affectation survit à la
 * désactivation du praticien, et la masquer ferait croire à une affectation
 * perdue — pour se heurter au conflit d'unicité de `service_staff` en tentant de
 * la recréer.
 */
export interface ServiceStaffMemberView {
  readonly id: string;
  readonly displayName: string;
  readonly isActive: boolean;
}

/** Forme réduite d'un praticien, telle que la page publique la reçoit. */
export interface StaffMemberSummaryView {
  readonly id: string;
  readonly displayName: string;
}

/**
 * Une prestation telle que la page de réservation **publique** la reçoit.
 *
 * Trois champs de `ServiceView` en sont délibérément absents : les deux tampons,
 * que le contrat décrit comme « invisibles du client » — ce sont des temps de
 * cabine, donc la cadence interne du salon —, `occupiedMinutes` qui les
 * redonnerait par soustraction, et `isActive` qui vaudrait toujours `true`
 * puisque le catalogue public ne contient que des prestations actives.
 */
export interface PublicServiceView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: ServiceCategorySummary | null;
  readonly durationMinutes: number;
  readonly price: Money;
  /** Les praticiens **actifs** qui pratiquent la prestation, par nom. */
  readonly staff: readonly StaffMemberSummaryView[];
}
