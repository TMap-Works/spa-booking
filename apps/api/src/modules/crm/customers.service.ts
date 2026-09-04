import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
// Import **de valeur** et non `import type` : Nest lit le type du paramètre de
// constructeur dans les métadonnées émises par TypeScript, et un `import type`
// s'efface à la compilation — l'injection échouerait alors au démarrage.
import { CrmRepository, type CustomerPatch } from './crm.repository';
// `identity/email` est un module de vocabulaire, sans dépendance Nest : c'est la
// **même** canonisation que `/auth/login` et que l'invitation du personnel. La
// recopier ici créerait une seconde définition de « la même adresse », et c'est
// exactement ce que `@@unique([tenantId, email])` ne pardonne pas. Ce n'est pas
// un import de repository voisin — ce qu'api-module §3 interdit —, c'est le
// même geste que l'import d'`identity/auth.decorator` par `catalog`.
import { normalizeEmail } from '../identity/email';
import type { Customer, CustomerPage } from './crm.types';

/**
 * Le fichier client de l'établissement — CDC §2.3, « profils clients,
 * coordonnées, notes ».
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`, et c'est voulu : le
 * client Prisma injecté dans le dépôt est **scopé** par le contexte de requête,
 * que `JwtAuthGuard` a renseigné depuis une revendication signée. Une lecture
 * visant la fiche d'un autre établissement ne la trouve donc pas — elle rend
 * `null`, que ce service traduit en `NotFoundError`, donc en 404.
 *
 * Un service qui aurait comparé les tenants lui-même aurait eu un `if` à écrire,
 * et ce `if` aurait eu à choisir entre 403 et 404. Le 403 est précisément la
 * fuite qu'on refuse (tenant-isolation §4) : il confirmerait que la fiche existe
 * ailleurs. Ne pas avoir l'information est la meilleure garantie de ne pas la
 * divulguer.
 *
 * ## Aucune donnée personnelle ne sort d'ici par un autre canal que la réponse
 *
 * C'est le cinquième critère de #56, et il se tient par une règle simple :
 * **ce service ne journalise rien**. Pas de logger injecté, pas d'appel à
 * `console`, aucun nom ni adresse ni numéro dans le message d'une erreur de
 * domaine — `CustomerEmailTakenError` ne porte même pas l'adresse en cause. Ce
 * qui n'est pas écrit ne peut pas fuiter, et c'est plus sûr que de compter sur
 * la rédaction en aval, qui existe pourtant (`common/logging/redaction.ts`) et
 * couvre `name`, `email`, `phone` et `note` par nom de champ.
 */
@Injectable()
export class CustomersService {
  public constructor(private readonly repository: CrmRepository) {}

  /**
   * Le fichier client, filtré et paginé.
   *
   * Le terme est normalisé **ici** et non dans le dépôt : élaguer une saisie est
   * une décision sur ce qu'on cherche, pas sur la façon de le lire. Une chaîne
   * réduite à des espaces vaut « pas de recherche », et non « cherche la chaîne
   * vide » — ce dernier prédicat serait vrai de toutes les lignes et coûterait
   * un balayage complet pour rendre exactement ce que rend l'absence de terme.
   */
  public async search(query: {
    q?: string;
    includeInactive: boolean;
    page: number;
    pageSize: number;
  }): Promise<CustomerPage> {
    const term = query.q === undefined ? null : query.q.trim();

    const result = await this.repository.search({
      term: term === null || term.length === 0 ? null : term,
      includeInactive: query.includeInactive,
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: result.items,
      page: query.page,
      pageSize: query.pageSize,
      totalItems: result.totalItems,
      // `0` sur un ensemble vide et non `1` : « page 1 sur 0 » décrit
      // correctement une liste sans résultat, là où « page 1 sur 1 » laisse
      // croire à une page qui existe. Même convention que `paginationMeta` du
      // contrat partagé.
      totalPages: Math.ceil(result.totalItems / query.pageSize),
    };
  }

  /**
   * Une fiche cliente de l'établissement courant.
   *
   * Le 404 couvre indistinctement trois situations — « n'existe nulle part »,
   * « existe dans un autre établissement » et « est un compte du personnel ».
   * La différence entre les deux premières est précisément l'information à ne
   * pas donner ; la troisième relève de `GET /users/:id`, pas du fichier client.
   */
  public async byId(id: string): Promise<Customer> {
    const customer = await this.repository.findById(id);
    if (customer === null) {
      throw new NotFoundError('Fiche cliente introuvable.');
    }
    return customer;
  }

  /**
   * Crée une fiche cliente au comptoir.
   *
   * La normalisation de l'adresse est **la même fonction** que celle de
   * `/auth/login` et de l'invitation du personnel (`identity/email`) : une fiche
   * créée sous `Alice@Lilas.test` occuperait sinon une ligne que la connexion,
   * qui normalise, ne retrouverait jamais — et l'unicité
   * `@@unique([tenantId, email])`, qui porte sur les octets, laisserait
   * cohabiter deux fiches pour la même personne.
   *
   * Il n'y a **pas** de lecture préalable pour vérifier l'unicité, contrairement
   * à `inviteStaffMember`. Elle n'apporterait rien ici : le dépôt traduit déjà
   * la violation d'unicité en 409, deux saisies concurrentes la passeraient
   * toutes les deux, et une requête de moins par création vaut mieux qu'une
   * courtoisie que la base rend de toute façon.
   */
  public async create(input: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
    internalNote: string | null;
  }): Promise<Customer> {
    return this.repository.create({
      email: normalizeEmail(input.email),
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      // `emptyToNull` et non `.trim()` : une saisie réduite à des espaces vaut
      // « pas de numéro » et « aucune note », jamais la chaîne vide. Deux
      // représentations d'une même absence finiraient par se comparer mal — et
      // la colonne, elle, est nullable précisément pour dire cette absence-là.
      phone: emptyToNull(input.phone),
      internalNote: emptyToNull(input.internalNote),
    });
  }

  /**
   * Met à jour les coordonnées et la note interne d'une fiche.
   *
   * ## Ce qu'elle ne touche pas
   *
   * Ni `email`, ni `isActive`, ni `role`. Le premier est l'identifiant de
   * connexion et la clé de l'unique métier : le changer demande une vérification
   * de la nouvelle adresse que le périmètre MVP ne prévoit pas (même arbitrage
   * qu'au #47 et qu'au #55). Le deuxième a sa propre route. Le troisième n'a
   * rien à faire dans un fichier client — promouvoir une cliente en praticienne
   * est un geste d'administration des droits, réservé à `ADMIN` par
   * `PATCH /users/:id/role`.
   *
   * ## Pourquoi la relecture précède l'écriture
   *
   * `update` rend `false` aussi bien pour « cette fiche n'existe pas ici » que
   * pour « aucune ligne n'a changé ». Distinguer les deux demande de lire
   * d'abord — sans quoi un `PATCH` qui réécrit la valeur déjà en place
   * répondrait 404 sur une fiche parfaitement existante.
   *
   * La réponse est **recomposée** plutôt que relue : les champs écrits sont
   * exactement ceux que `changes` porte, et une seconde lecture ne ferait
   * qu'ajouter un aller-retour pour retrouver ce qu'on vient d'envoyer.
   */
  public async update(id: string, changes: CustomerPatch): Promise<Customer> {
    const current = await this.repository.findById(id);
    if (current === null) {
      throw new NotFoundError('Fiche cliente introuvable.');
    }

    const normalized = normalizePatch(changes);

    const updated = await this.repository.update(id, normalized);
    if (!updated) {
      // La ligne a disparu entre la lecture et l'écriture. Même réponse que si
      // elle n'avait jamais été là : c'est ce qu'elle est maintenant.
      throw new NotFoundError('Fiche cliente introuvable.');
    }

    return { ...current, ...normalized };
  }

  /**
   * Désactive — ou réactive — une fiche cliente.
   *
   * **Ce n'est pas une suppression, et il n'y a pas de `DELETE` sur cette
   * ressource** : `appointments.client_id` référence `users` en `Restrict`, si
   * bien qu'une fiche ayant honoré une seule visite ne se supprime pas, et le
   * reporting du CDC §1.4 doit continuer à compter ces visites. Un verbe
   * `DELETE` qui n'efface rien mentirait au client autant qu'au relecteur.
   *
   * L'opération est idempotente : la réponse porte l'état **demandé**, y compris
   * quand rien n'a été écrit parce que la fiche y était déjà.
   */
  public async setActive(id: string, isActive: boolean): Promise<Customer> {
    const current = await this.repository.findById(id);
    if (current === null) {
      throw new NotFoundError('Fiche cliente introuvable.');
    }

    if (current.isActive !== isActive) {
      const updated = await this.repository.setActive(id, isActive);
      if (!updated) {
        throw new NotFoundError('Fiche cliente introuvable.');
      }
    }

    return { ...current, isActive };
  }
}

/**
 * Élague les chaînes du correctif sans toucher aux champs absents.
 *
 * `exactOptionalPropertyTypes` distingue « absent » de « présent et indéfini »,
 * et l'écriture doit faire la même distinction : un `firstName: undefined`
 * recopié dans un `data` Prisma effacerait le prénom, là où l'appelant demandait
 * seulement de ne pas y toucher.
 *
 * `null` traverse intact sur `phone` et `internalNote` : c'est la valeur par
 * laquelle on efface. Une note réduite à des espaces devient `null` plutôt
 * qu'une chaîne vide — les deux se lisent « aucune note », et deux
 * représentations d'une même absence finissent par se comparer mal.
 */
function normalizePatch(changes: CustomerPatch): CustomerPatch {
  return {
    ...(changes.firstName === undefined ? {} : { firstName: changes.firstName.trim() }),
    ...(changes.lastName === undefined ? {} : { lastName: changes.lastName.trim() }),
    ...(changes.phone === undefined ? {} : { phone: emptyToNull(changes.phone) }),
    ...(changes.internalNote === undefined
      ? {}
      : { internalNote: emptyToNull(changes.internalNote) }),
  };
}

/** Une chaîne élaguée, ou `null` si elle ne portait rien. */
function emptyToNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
