import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { CustomerHasUpcomingAppointmentsError } from './crm.errors';
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
    /**
     * `undefined` — personne n'a posé la question ; `true`/`false` — quelqu'un
     * l'a posée et voici la réponse. Les deux se distinguent, et c'est ce qui
     * donne sa valeur à l'instant enregistré (#81).
     */
    marketingConsent?: boolean;
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
      // Le défaut est le refus, jamais l'acceptation : le consentement est un
      // acte positif (RGPD art. 4.11). Sa date n'est posée que si quelqu'un
      // s'est prononcé — « jamais demandé » et « refusé le 6 septembre » ne
      // sont pas le même fait, et seul le second se démontre (art. 7.1).
      marketingConsent: input.marketingConsent ?? false,
      marketingConsentAt: input.marketingConsent === undefined ? null : this.now(),
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

    const normalized = {
      ...normalizePatch(changes),
      ...this.consentChange(current, changes.marketingConsent),
    };

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

  /**
   * Anonymise une fiche — le droit à l'oubli du CDC §5.1, deuxième critère
   * de #81.
   *
   * ## Anonymiser plutôt que supprimer, et ce que ça préserve
   *
   * La ligne reste, vidée de ce qui identifie. C'est ce que le critère demande
   * — « sans casser l'intégrité comptable des ventes passées » — et ce que le
   * schéma impose de toute façon : `appointments.client_id` référence `users`
   * en `Restrict`, et les encaissements comme les tickets de comptoir
   * s'accrochent à ces rendez-vous. Ce qui reste après le geste est une suite
   * de montants et de dates rattachés à un identifiant opaque ; ce qui part est
   * la personne.
   *
   * ## Le refus, et pourquoi il n'est pas définitif
   *
   * Une fiche qui a des rendez-vous **à venir** n'est pas anonymisable : le
   * salon ne peut ni préparer, ni confirmer, ni décommander une visite dont la
   * cliente n'a plus de nom. Le RGPD prévoit exactement ce cas — l'effacement
   * ne s'impose pas tant que le traitement reste nécessaire à l'exécution du
   * contrat (art. 17.1.b). La voie reste ouverte : honorer ou annuler, puis
   * redemander.
   *
   * ## Idempotence
   *
   * Une seconde demande sur une fiche déjà anonymisée la rend **telle quelle**,
   * sans lui attribuer un second pseudonyme ni décaler sa date. C'est
   * l'écriture conditionnelle du dépôt (`anonymized_at IS NULL`) qui le tient :
   * deux demandes concurrentes obtiennent la même réponse, la seconde sans rien
   * réécrire.
   *
   * ## Aucune décision n'est prise hors de la transaction
   *
   * Ce service ne relit pas la fiche avant d'appeler le dépôt, et ne compte pas
   * lui-même les rendez-vous : les quatre issues — anonymisée, déjà anonymisée,
   * rendez-vous à venir, introuvable — se tranchent **dedans**, la ligne étant
   * verrouillée. Une lecture faite ici aurait été périmée avant d'avoir servi,
   * et c'est exactement la vérification applicative que booking-engine §1
   * interdit. Ce qui reste ici est la traduction de l'issue en erreur de
   * domaine, qui est bien le travail d'un service (api-module §5).
   *
   * ## Le pseudonyme est calculé ici, pas dans le dépôt
   *
   * Parce que c'est une décision sur ce qu'on garde d'une personne, et non sur
   * la façon de l'écrire. Il est **dérivé de l'identifiant de la fiche** : c'est
   * ce qui le rend unique par construction, sans rien devoir tirer au sort ni
   * relire — `@@unique([tenantId, email])` refuserait un second « anonyme ».
   * Le calculer avant de savoir si la fiche existe ne coûte rien : c'est une
   * concaténation, et une fiche absente n'en reçoit rien.
   */
  public async anonymize(id: string): Promise<Customer> {
    const result = await this.repository.anonymize(
      id,
      {
        firstName: ANONYMIZED_FIRST_NAME,
        lastName: ANONYMIZED_LAST_NAME,
        email: anonymizedEmail(id),
        anonymizedAt: this.now(),
      },
      this.now(),
    );

    switch (result.outcome) {
      case 'not-found':
        // Inconnue, du salon voisin, ou compte du personnel : le même 404 dans
        // les trois cas, délibérément (tenant-isolation §4).
        throw new NotFoundError('Fiche cliente introuvable.');
      case 'upcoming-appointments':
        throw new CustomerHasUpcomingAppointmentsError(result.upcomingAppointments);
      default:
        return result.customer;
    }
  }

  /**
   * Le consentement à écrire, **avec sa date**, ou rien du tout.
   *
   * Trois cas, et le troisième est celui qui mérite d'être argumenté :
   *
   * - le champ est absent → rien n'est écrit, pas même la date ;
   * - la valeur **change** → elle est écrite, et l'instant avec elle. C'est cet
   *   instant qui rend le consentement démontrable (RGPD art. 7.1) ;
   * - la valeur est renvoyée **identique** → rien n'est écrit. La date répond à
   *   « depuis quand est-ce l'état », et un `PATCH` qui corrige un numéro de
   *   téléphone en recopiant le consentement au passage ne doit pas la décaler.
   *   Sans ce départage, l'écran qui renvoie le formulaire entier réécrirait la
   *   preuve à chaque enregistrement, et elle finirait par dater du dernier
   *   changement d'adresse.
   */
  private consentChange(current: Customer, requested: boolean | undefined): CustomerPatch {
    if (requested === undefined || requested === current.marketingConsent) {
      return {};
    }
    return { marketingConsent: requested, marketingConsentAt: this.now() };
  }

  /**
   * L'instant courant, lu en un seul endroit.
   *
   * Regroupé ici pour que les dates du consentement et de l'anonymisation aient
   * la même source, et pour qu'une suite puisse la remplacer sans avoir à
   * geler l'horloge du processus entier.
   */
  private now(): Date {
    return new Date();
  }
}

/**
 * Le prénom et le nom d'une fiche anonymisée.
 *
 * Lisibles plutôt qu'illisibles : le back-office continuera de croiser ces
 * lignes dans un historique ou un état comptable, et « Client anonymisé » y dit
 * ce qui s'est passé là où une suite de caractères aléatoires aurait fait
 * craindre une corruption de données.
 */
const ANONYMIZED_FIRST_NAME = 'Client';
const ANONYMIZED_LAST_NAME = 'anonymisé';

/**
 * Le domaine du pseudonyme — `.invalid` est **réservé** par la RFC 2606 et ne
 * peut être délégué à personne.
 *
 * Ce n'est pas de la coquetterie : la colonne `email` est `NOT NULL`, il faut
 * donc y écrire quelque chose, et ce quelque chose ne doit jamais désigner une
 * boîte réelle. Un domaine d'exemple ordinaire pourrait un jour être enregistré
 * et recevoir ce qu'un traitement mal réglé lui enverrait.
 */
const ANONYMIZED_EMAIL_DOMAIN = 'anonymise.invalid';

/**
 * L'adresse de remplacement d'une fiche anonymisée, **dérivée de son
 * identifiant**.
 *
 * `@@unique([tenantId, email])` interdit deux fiches sous la même adresse dans
 * un établissement : un « anonyme@… » constant aurait fait échouer la deuxième
 * anonymisation du salon. L'identifiant est déjà unique et déjà dans la ligne,
 * il n'y a donc rien à tirer au sort ni à relire pour s'en assurer.
 */
export function anonymizedEmail(id: string): string {
  return `anonymise-${id}@${ANONYMIZED_EMAIL_DOMAIN}`;
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
