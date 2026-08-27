import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { requireTenantId } from '../../common/tenant/tenant-context';
import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import { isSlotExclusionViolation, isTransientWriteConflict } from './appointments.conflicts';
import { SlotNoLongerAvailableError } from './appointments.errors';
import type { AppointmentDraft, AppointmentRecord, GuestContact } from './appointments.types';

/**
 * Accès Prisma du module `appointments` — le seul endroit qui connaisse le
 * schéma (api-module §2).
 *
 * Il porte, pour #31, une seule responsabilité qui ne se délègue pas : **écrire
 * sans jamais vérifier d'abord**, et traduire le refus de la base.
 *
 * ```ts
 * // ❌ structurellement faux : deux requêtes simultanées passent toutes deux
 * if (await this.isFree(slot)) { return this.create(slot); }
 *
 * // ✅ la base tranche, le code traduit
 * try { return await this.prisma.appointment.create(…); }
 * catch (error) { if (isSlotExclusionViolation(error)) throw new SlotNoLongerAvailableError(…); }
 * ```
 *
 * Le moteur de disponibilité (#34) lira bien les rendez-vous existants — pour
 * *proposer* des créneaux, ce qui est une question d'affichage. Ce qui est
 * interdit est d'en faire la **garantie** : entre la lecture et l'écriture, une
 * autre transaction peut insérer, et aucune relecture ne rattrape cela
 * (ADR 0002, booking-engine §1).
 *
 * S'y ajoute une seconde responsabilité, découverte en exerçant la première :
 * **réessayer les interblocages**. Écrire sans vérifier expose à un mode de
 * défaillance que la vérification préalable masquait — plusieurs insertions
 * concurrentes s'attendent en cycle, et PostgreSQL en abat une. Voir `create`.
 */

/**
 * Ce que le repository rend d'une ligne — jamais l'entité Prisma nue.
 *
 * Ni `tenantId` (il n'apporte rien à l'appelant, tenant-isolation §4), ni
 * `timeRange` (colonne générée, illisible par Prisma), ni les notes internes du
 * staff, ni les horodatages techniques : ce qui n'est pas listé ici ne peut pas
 * franchir la frontière du module par inadvertance.
 */
const APPOINTMENT_SELECT = {
  id: true,
  clientId: true,
  staffId: true,
  serviceId: true,
  startsAt: true,
  endsAt: true,
  status: true,
  priceAmountMinor: true,
  priceCurrency: true,
  clientNote: true,
} as const;

type AppointmentRow = Prisma.AppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>;

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Même conversion, et pour la même raison, que dans `catalog.repository.ts` : le
 * type généré exige `tenantId` — la colonne est `NOT NULL` — alors que le
 * repository ne doit justement pas le fournir. C'est l'extension qui le pose
 * depuis le contexte de requête, et qui **écrase** ce qui s'y trouverait.
 *
 * Ce qui rend la conversion sûre n'est pas une promesse : l'extension refuse
 * toute opération sans contexte de tenant, et la colonne n'a pas de valeur par
 * défaut. Si l'extension venait à être contournée, l'insertion échouerait en
 * base — bruyamment, jamais en silence.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/**
 * Nombre total de tentatives d'insertion, réessais compris.
 *
 * Trois, et le chiffre se raisonne plutôt qu'il ne se règle. Un interblocage se
 * produit tant que la ligne gagnante n'est **pas encore validée** : les
 * perdantes attendent, un cycle se forme, PostgreSQL en abat une. Dès que la
 * gagnante est validée, toute insertion en conflit échoue **immédiatement** en
 * `23P01`, sans attendre personne — il n'y a donc plus de cycle possible. Une
 * seconde tentative suffit en pratique ; la troisième existe pour le cas où la
 * gagnante mettrait plus longtemps que la victime à rendre la main.
 *
 * Épuiser les trois n'est pas traduit en 409 : ce serait annoncer « ce créneau
 * est pris » sur un créneau peut-être libre. L'erreur remonte telle quelle, en
 * 500 — c'est-à-dire pour ce qu'elle est alors, un incident de contention qui
 * mérite d'être vu dans les journaux plutôt que maquillé en refus métier.
 */
const MAX_INSERT_ATTEMPTS = 3;

/**
 * Code Prisma d'une violation de contrainte d'unicité — ici
 * `@@unique([tenantId, email])` sur `users`, la seule que
 * `findOrCreateClient` puisse rencontrer.
 */
const UNIQUE_EMAIL_VIOLATION = 'P2002';

/**
 * Répit avant un réessai — quelques dizaines de millisecondes, avec une part
 * aléatoire.
 *
 * La part aléatoire n'est pas cosmétique : sans elle, les N victimes d'un même
 * interblocage repartent **au même instant** et reforment le cycle qu'elles
 * viennent de subir.
 */
async function backOff(attempt: number): Promise<void> {
  const base = 20 * attempt;
  await new Promise((resolve) => setTimeout(resolve, base + Math.random() * base));
}

/** Une ligne, sous la forme que le module manipule. */
function toRecord(row: AppointmentRow): AppointmentRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    staffId: row.staffId,
    serviceId: row.serviceId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    price: { amountMinor: row.priceAmountMinor, currency: row.priceCurrency },
    clientNote: row.clientNote,
  };
}

@Injectable()
export class AppointmentsRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Pose un rendez-vous dans l'établissement courant, ou refuse le créneau.
   *
   * Le statut initial est `PENDING` — le défaut de la colonne : le rendez-vous
   * occupe l'agenda dès sa création, avant même la confirmation ou le paiement.
   * C'est ce qui empêche qu'un second client s'y glisse pendant la saisie.
   *
   * ## Deux issues concurrentes, et une seule est un refus
   *
   * Sous charge réelle, PostgreSQL rend **deux** erreurs distinctes, et les
   * confondre coûte cher dans les deux sens :
   *
   * - `23P01`, le refus de `appointments_no_overlap` : le créneau est pris, la
   *   réponse est définitive → `SlotNoLongerAvailableError`, donc 409 ;
   * - `40P01`, un interblocage : plusieurs insertions aux intervalles décalés
   *   mais chevauchants se sont attendues en cycle, et la victime n'a **rien
   *   appris** de l'agenda. Son créneau peut être libre. La bonne réponse n'est
   *   pas de lui dire non, c'est de recommencer.
   *
   * @throws {SlotNoLongerAvailableError} si ce praticien a déjà, dans cet
   * établissement, un rendez-vous `PENDING` ou `CONFIRMED` qui chevauche cet
   * intervalle.
   */
  public async create(draft: AppointmentDraft): Promise<AppointmentRecord> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.insert(draft);
      } catch (error: unknown) {
        // Sans cette traduction, la perdante d'une course reçoit un 500 là où le
        // contrat annonce un 409 — et le front n'a plus rien à proposer au client.
        if (isSlotExclusionViolation(error)) {
          throw new SlotNoLongerAvailableError(draft.staffId, draft.startsAt);
        }
        if (!isTransientWriteConflict(error) || attempt >= MAX_INSERT_ATTEMPTS) {
          throw error;
        }
        await backOff(attempt);
      }
    }
  }

  /**
   * L'insertion, **sérialisée par praticien** — une tentative, sans
   * interprétation de l'échec.
   *
   * ## Pourquoi un verrou consultatif alors que la contrainte suffit
   *
   * Il ne sert pas à décider si le créneau est libre : c'est la contrainte qui
   * en décide, et elle seule. Il sert à décider **dans quel ordre** les
   * candidates le demandent.
   *
   * Sans lui, N insertions concurrentes aux intervalles chevauchants posent
   * chacune leur entrée d'index puis attendent les autres : le graphe d'attente
   * est un cycle, PostgreSQL abat une victime par `deadlock_timeout` (une
   * seconde), et il faut N−1 secondes pour qu'une gagnante émerge. Mesuré sur ce
   * schéma : huit réservations décalées d'une minute mettent **sept secondes**,
   * et les sept perdantes reçoivent `40P01` — un 500 — au lieu du 409 qu'annonce
   * le contrat. Réessayer ne suffit pas : les victimes reviennent dans un cycle
   * encore actif et se font abattre à nouveau.
   *
   * Le verrou supprime le cycle à la racine : une seule insertion à la fois pour
   * un praticien donné, les autres attendent leur tour et reçoivent, chacune,
   * un refus **immédiat et propre** sur une ligne déjà validée. La même
   * concurrence retombe alors à quelques millisecondes.
   *
   * Sérialiser les écritures d'un praticien ne coûte rien : elles le sont déjà
   * par nature — un praticien ne fait qu'un soin à la fois. Le verrou est
   * `_xact_`, donc relâché par la validation ou l'annulation de la transaction,
   * jamais à la main : aucun chemin d'erreur ne peut le laisser pris.
   *
   * Ce verrou **n'est pas** celui de #38. Celui-là vivra dans Redis, durera le
   * temps d'une saisie de paiement et sert le confort d'interface ; celui-ci
   * dure une insertion et sert l'ordonnancement. Aucun des deux ne remplace la
   * contrainte (booking-engine §2).
   *
   * Décision, mesures et conséquences : ADR 0006.
   */
  private async insert(draft: AppointmentDraft): Promise<AppointmentRecord> {
    // La clé nomme les colonnes qu'elle sérialise. `staff_id` suffirait — un
    // praticien n'appartient qu'à un établissement — mais une clé de verrou qui
    // ne dit pas sa portée est une collision qui attend son heure.
    //
    // Le modèle et l'opération sont passés à `requireTenantId` pour la même
    // raison que l'extension les passe : c'est ce verrou qui lit le tenant en
    // premier, donc lui qui échouera d'abord si le contexte manque, et un
    // message qui ne nomme pas l'opération fautive envoie chercher ailleurs.
    const tenantId = requireTenantId('Appointment', 'create');
    const agenda = `appointments:tenant_id=${tenantId}:staff_id=${draft.staffId}`;

    return this.prisma.$transaction(async (tx) => {
      // eslint-disable-next-line tenant/raw-sql-tenant-filter -- Ce SQL ne lit ni n'écrit aucune ligne : il prend un verrou consultatif dont la clé porte le tenant, transmis en paramètre lié (`agenda`). Il n'y a pas de `WHERE` à filtrer.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${agenda}::text, 0::bigint))`;

      const row = await tx.appointment.create({
        data: withScopedTenant<Prisma.AppointmentUncheckedCreateInput>({
          clientId: draft.clientId,
          staffId: draft.staffId,
          serviceId: draft.serviceId,
          startsAt: draft.startsAt,
          endsAt: draft.endsAt,
          priceAmountMinor: draft.price.amountMinor,
          priceCurrency: draft.price.currency,
          clientNote: draft.clientNote,
        }),
        select: APPOINTMENT_SELECT,
      });
      return toRecord(row);
    });
  }

  /**
   * Un rendez-vous de l'établissement courant, par identifiant.
   *
   * `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
   * `where`, et `findUnique` exige que le `where` désigne *exactement* une clé
   * unique — ce que `{ id, tenantId }` ne fait pas sous cette forme. Rend `null`
   * pour l'identifiant d'un autre établissement, ce qui donne le 404 attendu
   * plutôt qu'un 403 qui confirmerait l'existence de la ligne.
   */
  public async findById(id: string): Promise<AppointmentRecord | null> {
    const row = await this.prisma.appointment.findFirst({
      where: { id },
      select: APPOINTMENT_SELECT,
    });
    return row === null ? null : toRecord(row);
  }

  /**
   * La fiche cliente de ces coordonnées dans l'établissement courant — trouvée,
   * ou créée sans compte.
   *
   * C'est ce qui rend vrai le quatrième critère de #37 : « un client peut
   * réserver sans compte, avec seulement ses coordonnées ». La ligne écrite n'a
   * **pas de `passwordHash`** — la colonne est nullable exactement pour cela — et
   * n'ouvre donc aucune identité : rien à quoi se connecter, aucune session,
   * aucun jeton. C'est une fiche de carnet d'adresses, pas un compte.
   *
   * ## Pourquoi l'adresse e-mail est la clé, et non un choix
   *
   * `@@unique([tenantId, email])` l'impose : deux fiches ne peuvent pas partager
   * une adresse dans un même salon. Chercher avant d'écrire n'est donc pas une
   * optimisation, c'est la seule conduite possible — et c'est aussi ce que le
   * salon attend, une cliente qui revient devant garder un seul historique.
   *
   * ## Ce que cette méthode ne fait **pas** : mettre à jour
   *
   * Une fiche trouvée est rendue telle quelle. Le prénom, le nom et le téléphone
   * envoyés par un visiteur non authentifié n'écrasent jamais ceux d'une fiche
   * existante : sans cela, un appel public suffirait à réécrire le nom et le
   * numéro de n'importe quelle cliente — ou d'un compte staff — dont on connaît
   * l'adresse. La correction d'une fiche relève du back-office, sous garde.
   *
   * ## Pourquoi ce module écrit dans `users`
   *
   * Il ne le devrait pas : les fiches clientes appartiennent à `crm` (CDC §2.3),
   * qui n'existe pas encore, et `identity` n'expose pas de porte pour cela —
   * `IdentityModule` n'exporte ni son repository ni `UsersService`, délibérément.
   * Ouvrir cette porte toucherait `identity.module.ts`, hors de l'empreinte de ce
   * ticket. La résolution vit donc ici, isolée dans une seule méthode et derrière
   * une seule signature, pour que `crm` la reprenne d'un déplacement plutôt que
   * d'une réécriture. Voir l'issue de suivi ouverte par #37.
   */
  public async findOrCreateClient(contact: GuestContact): Promise<string> {
    const existing = await this.findClientIdByEmail(contact.email);
    if (existing !== null) {
      return existing;
    }

    try {
      const created = await this.prisma.user.create({
        data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
          email: contact.email,
          role: 'CLIENT',
          // Aucun mot de passe : la fiche existe pour être jointe, pas pour se
          // connecter. `AuthService` refuse déjà une identité sans empreinte.
          passwordHash: null,
          firstName: contact.firstName,
          lastName: contact.lastName,
          phone: contact.phone,
        }),
        select: { id: true },
      });
      return created.id;
    } catch (error: unknown) {
      // Deux réservations d'invité concurrentes sur la même adresse : la
      // perdante relit la fiche que la gagnante vient d'écrire. Refuser ici
      // rendrait un 500 sur un cas parfaitement normal — deux onglets, ou un
      // double clic que le front n'a pas su désarmer.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_EMAIL_VIOLATION
      ) {
        const raced = await this.findClientIdByEmail(contact.email);
        if (raced !== null) {
          return raced;
        }
      }
      throw error;
    }
  }

  /**
   * L'identifiant de la fiche portant cette adresse dans l'établissement
   * courant, ou `null`.
   *
   * `findFirst` et non `findUnique`, pour la même raison que `findById` :
   * l'extension injecte `tenantId` dans le `where`, et `findUnique` exige que le
   * `where` désigne *exactement* une clé unique. Le filtre de tenant reste donc
   * posé par l'extension, jamais recopié ici.
   */
  private async findClientIdByEmail(email: string): Promise<string | null> {
    const row = await this.prisma.user.findFirst({ where: { email }, select: { id: true } });
    return row?.id ?? null;
  }
}
