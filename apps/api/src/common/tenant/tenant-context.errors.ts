/**
 * Erreurs du contexte de tenant.
 *
 * Aucune n'est une `DomainError` — et ce n'est pas un oubli. Une erreur de
 * domaine décrit une requête cliente refusée pour une raison que le client peut
 * comprendre et corriger ; celles-ci décrivent un **défaut de programmation
 * serveur** : une requête aux données lancée hors de tout contexte, un contexte
 * résolu deux fois, un `tenantId` qu'on tente de réécrire. Le client n'a rien à
 * en apprendre.
 *
 * `DomainExceptionFilter` les traite donc comme n'importe quelle exception
 * imprévue : 500, corps générique `{ code: "INTERNAL_ERROR" }`, trace complète
 * dans le journal. C'est exactement le comportement voulu — l'incident doit
 * être bruyant côté exploitation et muet côté client.
 */

/** Racine des erreurs d'isolation, pour un `catch` unique en test comme en prod. */
export abstract class TenantContextError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Retire le constructeur de la pile : elle doit pointer le site d'appel.
    Error.captureStackTrace?.(this, new.target);
  }
}

/**
 * Une opération de données a été demandée sans tenant courant.
 *
 * C'est **le** cas qui justifie tout le ticket : sans cette erreur, l'extension
 * Prisma retomberait sur « pas de filtre », donc sur « toutes les données de
 * tous les salons » (tenant-isolation §3). Le mode ouvert par défaut est ce qui
 * produit les fuites ; ici le défaut est fermé.
 */
export class MissingTenantContextError extends TenantContextError {
  public readonly model: string | undefined;
  public readonly operation: string | undefined;

  public constructor(model?: string, operation?: string) {
    const target = model === undefined ? '' : ` « ${model}${operation === undefined ? '' : `.${operation}`} »`;
    super(
      `Aucun tenant dans le contexte de la requête : l'opération${target} est refusée. ` +
        'Une lecture ou une écriture sans tenant retournerait les données de tous les ' +
        'établissements — utiliser le client `prismaUnscoped` si le traitement est ' +
        'réellement inter-tenant.',
    );
    this.model = model;
    this.operation = operation;
  }
}

/**
 * `setRequestTenantId` appelée hors de toute portée de requête.
 *
 * Le symptôme trahit un middleware non branché, ou une résolution tentée depuis
 * un contexte détaché (`setTimeout`, worker, consommateur de file) où le store
 * `AsyncLocalStorage` n'existe pas. Écrire dans le vide passerait inaperçu
 * jusqu'à la première requête servie sans tenant.
 */
export class TenantScopeNotOpenError extends TenantContextError {
  public constructor() {
    super(
      "Aucune portée de tenant ouverte : `setRequestTenantId` n'a de sens qu'à " +
        "l'intérieur d'une requête, sous le middleware qui ouvre la portée. " +
        'Pour un traitement hors requête, ouvrir explicitement une portée avec `runWithTenant`.',
    );
  }
}

/**
 * Le tenant de la requête a déjà été résolu.
 *
 * Un contexte se résout **une fois** : le second résolveur qui écrirait dessus
 * — une garde d'authentification après un middleware public, par exemple —
 * changerait le tenant en cours de requête, et les écritures déjà faites
 * appartiendraient à un autre établissement que les suivantes.
 */
export class TenantAlreadyResolvedError extends TenantContextError {
  public constructor() {
    super(
      'Le tenant de cette requête est déjà résolu : il ne peut pas être remplacé. ' +
        'Un seul résolveur doit écrire dans le contexte.',
    );
  }
}

/** `tenantId` vide, blanc ou non fourni — jamais silencieusement toléré. */
export class InvalidTenantIdError extends TenantContextError {
  public constructor() {
    // Sans la valeur fautive : elle vient parfois d'une entrée client, et ce
    // message finit dans CloudWatch Logs.
    super('Identifiant de tenant invalide : une chaîne non vide est attendue.');
  }
}
