import { Prisma } from '@prisma/client';

import { requireTenantId } from '../../common/tenant/tenant-context';
import { TenantContextError } from '../../common/tenant/tenant-context.errors';

/**
 * Extension Prisma de scoping automatique — tenant-isolation §3.
 *
 * Elle s'interpose entre le repository et le moteur, et réécrit les arguments
 * de **toute** opération portant sur un modèle métier : le `where` reçoit le
 * tenant courant, le `data` d'une création aussi. Un repository n'a donc plus
 * rien à répéter, et surtout plus rien à oublier.
 *
 * Trois principes tiennent ce fichier, et chacun est un refus explicite :
 *
 * 1. **Défaut fermé.** Sans contexte de tenant, l'opération est refusée
 *    (`MissingTenantContextError`). Elle ne retombe jamais sur « pas de
 *    filtre », c'est-à-dire sur « toutes les données de tous les salons ».
 * 2. **Défaut fermé sur les modèles, aussi.** Un modèle qui n'est ni scopé ni
 *    déclaré globalement légitime est refusé. Une table ajoutée demain sans
 *    `tenant_id` échoue à la première requête au lieu de devenir silencieusement
 *    lisible par tout le monde.
 * 3. **Défaut fermé sur les opérations.** Une opération que ce fichier ne sait
 *    pas classer est refusée. Prisma en ajoute au fil des versions
 *    (`createManyAndReturn`, `updateManyAndReturn`) ; une nouvelle venue doit
 *    faire rougir une suite, pas passer sans filtre.
 *
 * ## Ce que l'extension ne couvre pas
 *
 * Deux angles morts, tous deux structurels au pipeline de Prisma. Les connaître
 * fait partie de la garantie : une protection dont on croit à tort qu'elle
 * couvre tout est pire qu'une protection dont on connaît les bords.
 *
 * **1. Le SQL brut.** `$queryRaw`, `$executeRaw` et leurs variantes ne passent
 * pas par le pipeline des opérations de modèle : elles ne sont pas filtrées.
 * Tout SQL brut porte donc son propre `AND tenant_id = $n`, sans exception.
 * C'est le prix de la contrainte d'exclusion et des verrous consultatifs, que
 * Prisma n'exprime pas.
 *
 * **2. Les opérations imbriquées.** `$allOperations` n'intercepte que l'opération
 * de **premier niveau**. Ni les écritures imbriquées (`data: { staff: { create:
 * … } }`), ni les lectures de relation (`include`, `select`) ne repassent par
 * cette fonction. Ce qui les tient n'est donc pas l'extension, mais le schéma
 * de #19, et il les tient de deux façons distinctes :
 *
 * - en **écriture**, une création imbriquée ne reçoit aucun `tenantId` injecté ;
 *   comme la colonne est `NOT NULL` et sans valeur par défaut, Prisma la
 *   refuse. L'échec est bruyant, jamais silencieux — défaut fermé, là aussi ;
 * - en **lecture**, une relation se parcourt par clé étrangère depuis une ligne
 *   déjà bornée au tenant courant par l'opération de premier niveau. Les clés
 *   étrangères composites `(tenant_id, id)` posées en SQL à la fin de la
 *   migration interdisent qu'une ligne d'un salon en référence une autre : le
 *   parcours ne peut donc pas sortir du tenant.
 *
 * Ce second point est une **dépendance explicite** de ce fichier envers ces clés
 * composites. Une migration qui les retirerait ouvrirait une fuite que rien ici
 * ne rattraperait — c'est pourquoi le schéma les documente comme non
 * négociables, et pourquoi `prisma-schema.spec.ts` les vérifie.
 */

/** Nom du champ discriminant, tel que le schéma le déclare. */
const TENANT_FIELD = 'tenantId';

/**
 * La racine de l'isolation. `Tenant` ne porte pas de `tenant_id` — elle *est* le
 * tenant — mais la laisser passer sans filtre rendrait `prisma.tenant.findMany()`
 * capable d'énumérer tous les établissements de la plateforme. Elle est donc
 * scopée elle aussi, sur son `id`.
 */
export const TENANT_ROOT_MODEL = 'Tenant';

/**
 * Modèles délibérément hors tenant : tables de référence globales (pays,
 * devises), tables techniques. Vide aujourd'hui, et toute addition se documente
 * en ADR (tenant-isolation §1) — la liste est ici, en clair, pour que l'ajout se
 * voie en revue.
 */
const GLOBAL_MODELS: ReadonlySet<string> = new Set<string>();

/**
 * Modèles scopés, **déduits du schéma** et non énumérés à la main : tout modèle
 * portant un champ scalaire `tenantId`. Une huitième entité ajoutée demain est
 * couverte sans que personne ait pensé à l'inscrire ici — et si elle oublie son
 * `tenant_id`, le principe 2 la refuse.
 */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) =>
      model.fields.some((field) => field.kind === 'scalar' && field.name === TENANT_FIELD),
    )
    .map((model) => model.name),
);

/** Forme des arguments qui nous intéresse — le reste passe tel quel. */
export interface TenantScopedOperationArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Familles d'opérations, par ce qu'elles font des arguments — et non par leur
 * nom. `delete` et `findMany` se traitent pareil : elles filtrent.
 */
type OperationShape = 'filter' | 'create' | 'update' | 'upsert';

const OPERATION_SHAPES: ReadonlyMap<string, OperationShape> = new Map<string, OperationShape>([
  ['findUnique', 'filter'],
  ['findUniqueOrThrow', 'filter'],
  ['findFirst', 'filter'],
  ['findFirstOrThrow', 'filter'],
  ['findMany', 'filter'],
  ['count', 'filter'],
  ['aggregate', 'filter'],
  ['groupBy', 'filter'],
  ['delete', 'filter'],
  ['deleteMany', 'filter'],
  ['create', 'create'],
  ['createMany', 'create'],
  ['createManyAndReturn', 'create'],
  ['update', 'update'],
  ['updateMany', 'update'],
  ['updateManyAndReturn', 'update'],
  ['upsert', 'upsert'],
]);

/**
 * Un modèle échappe au scoping sans être déclaré global — voir principe 2.
 */
export class UnscopedModelNotAllowedError extends TenantContextError {
  public constructor(model: string) {
    super(
      `Le modèle « ${model} » ne porte pas de \`tenantId\` et n'est pas déclaré ` +
        'globalement légitime : aucune requête ne peut lui être adressée par le client ' +
        'scopé. Ajouter `tenant_id` au modèle, ou l’inscrire dans `GLOBAL_MODELS` avec un ADR.',
    );
  }
}

/** Une opération que ce fichier ne sait pas classer — voir principe 3. */
export class UnsupportedTenantScopedOperationError extends TenantContextError {
  public constructor(model: string, operation: string) {
    super(
      `L'opération « ${model}.${operation} » n'est pas classée par l'extension de ` +
        'scoping : impossible de garantir son filtrage par tenant. La classer dans ' +
        '`OPERATION_SHAPES`, ou passer par `prismaUnscoped` en assumant le filtre à la main.',
    );
  }
}

/**
 * Écriture qui prétend rattacher une ligne à un tenant, ou l'en changer.
 *
 * Le tenant d'une ligne est posé une fois, par le contexte, à la création. Un
 * `update` qui le réécrit ferait sortir la ligne de son établissement — c'est
 * une fuite écrite, plus difficile à détecter qu'une fuite lue.
 */
export class TenantReassignmentError extends TenantContextError {
  public constructor(model: string, operation: string) {
    super(
      `« ${model}.${operation} » tente d'écrire le tenant d'une ligne. Le tenant est ` +
        'posé par le contexte à la création et ne se modifie pas : une ligne ne change ' +
        "pas d'établissement.",
    );
  }
}

/**
 * Création d'un établissement par le client scopé.
 *
 * Créer un `Tenant` est par définition une opération sans tenant courant :
 * l'établissement n'existe pas encore. Elle passe par `prismaUnscoped`, comme
 * tout ce qui est légitimement inter-tenant.
 */
export class UnscopedClientRequiredError extends TenantContextError {
  public constructor(operation: string) {
    super(
      `« ${TENANT_ROOT_MODEL}.${operation} » n'a pas de tenant courant à appliquer : ` +
        'la création d’un établissement passe par le client `prismaUnscoped`.',
    );
  }
}

/** `tenantId` pour un modèle métier, `id` pour la racine, rien pour un global. */
function scopeFieldFor(model: string): string | undefined {
  if (TENANT_SCOPED_MODELS.has(model)) {
    return TENANT_FIELD;
  }
  if (model === TENANT_ROOT_MODEL) {
    return 'id';
  }
  return undefined;
}

/**
 * Pose le tenant sur une ligne à créer, en **écrasant** ce qui s'y trouvait.
 *
 * L'écrasement est le point : c'est lui qui neutralise un `tenantId` qui aurait
 * traversé la validation. La valeur soumise n'est pas rejetée, elle n'a
 * simplement aucun effet — et ne peut donc pas servir de sonde.
 */
function withTenant(
  row: Record<string, unknown> | undefined,
  tenantId: string,
  model: string,
  operation: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...row };
  // `data: { tenant: { connect: … } }` désignerait le tenant par la relation.
  // Prisma refuserait la coexistence avec le scalaire, avec un message obscur ;
  // le refuser ici nomme la cause.
  if ('tenant' in next) {
    throw new TenantReassignmentError(model, operation);
  }
  next[TENANT_FIELD] = tenantId;
  return next;
}

/** Refuse une charge utile de mise à jour qui touche au tenant. */
function assertTenantImmutable(
  payload: Record<string, unknown> | Record<string, unknown>[] | undefined,
  model: string,
  operation: string,
): void {
  const rows = Array.isArray(payload) ? payload : [payload];
  for (const row of rows) {
    if (row !== undefined && (TENANT_FIELD in row || 'tenant' in row)) {
      throw new TenantReassignmentError(model, operation);
    }
  }
}

/**
 * Réécrit les arguments d'une opération pour la borner au tenant donné.
 *
 * Fonction **pure**, exportée pour elle-même : c'est le cœur testable de
 * l'extension, exerçable sans base ni client Prisma.
 */
export function applyTenantScope(
  model: string,
  operation: string,
  args: TenantScopedOperationArgs | undefined,
  tenantId: string,
): TenantScopedOperationArgs {
  const field = scopeFieldFor(model);
  if (field === undefined) {
    throw new UnscopedModelNotAllowedError(model);
  }

  const shape = OPERATION_SHAPES.get(operation);
  if (shape === undefined) {
    throw new UnsupportedTenantScopedOperationError(model, operation);
  }

  const source: TenantScopedOperationArgs = { ...args };
  // `where` est posé en dernier : il écrase un `tenantId` que l'appelant aurait
  // fourni, plutôt que de s'y ajouter.
  const scopedWhere: Record<string, unknown> = { ...source.where, [field]: tenantId };

  switch (shape) {
    case 'filter':
      return { ...source, where: scopedWhere };

    case 'create':
      if (model === TENANT_ROOT_MODEL) {
        throw new UnscopedClientRequiredError(operation);
      }
      return {
        ...source,
        data: Array.isArray(source.data)
          ? source.data.map((row) => withTenant(row, tenantId, model, operation))
          : withTenant(source.data, tenantId, model, operation),
      };

    case 'update':
      assertTenantImmutable(source.data, model, operation);
      return { ...source, where: scopedWhere };

    case 'upsert':
      if (model === TENANT_ROOT_MODEL) {
        throw new UnscopedClientRequiredError(operation);
      }
      assertTenantImmutable(source.update, model, operation);
      return {
        ...source,
        where: scopedWhere,
        create: withTenant(source.create, tenantId, model, operation),
      };
  }
}

/** Ce que Prisma passe à `$allOperations`, retypé sans `any`. */
export interface AllOperationsParams {
  model: string;
  operation: string;
  args: TenantScopedOperationArgs;
  query: (args: TenantScopedOperationArgs) => Promise<unknown>;
}

/**
 * Le corps de l'extension, exporté pour être exercé directement en test — sans
 * client Prisma, sans base, sans connexion.
 */
export async function scopeOperation({
  model,
  operation,
  args,
  query,
}: AllOperationsParams): Promise<unknown> {
  if (GLOBAL_MODELS.has(model)) {
    return query(args);
  }
  const tenantId = requireTenantId(model, operation);
  return query(applyTenantScope(model, operation, args, tenantId));
}

/** L'extension telle que `$extends` la consomme. */
export const tenantScopeExtension = Prisma.defineExtension({
  name: 'tenant-scope',
  query: {
    $allModels: {
      $allOperations: scopeOperation,
    },
  },
});
