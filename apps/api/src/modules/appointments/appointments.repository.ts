import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictError, InvalidStateTransitionError, NotFoundError } from '../../common/errors';
import { requireTenantId } from '../../common/tenant/tenant-context';
import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
// La **porte de service** du module `crm`, jamais son repository (api-module §3).
// Elle est importée de valeur — Nest lit le type du paramètre de constructeur
// dans les métadonnées émises par TypeScript, qu'un `import type` effacerait.
import { ClientDirectoryService } from '../crm/client-directory.service';
import { ClientRecordRaceError } from '../crm/crm.errors';
import { OCCUPYING_STATUSES, occupiesSlot } from './appointment-status';
import { isSlotExclusionViolation, isTransientWriteConflict } from './appointments.conflicts';
import { SlotNoLongerAvailableError } from './appointments.errors';
import type {
  AgendaAppointmentRecord,
  AgendaQuery,
  AppointmentDraft,
  AppointmentRecord,
  CancelDraft,
  ClientAppointmentsQuery,
  RescheduleDraft,
  RescheduleOutcome,
} from './appointments.types';

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
 *
 * ## Ce que ce fichier a cessé d'écrire : `users` (#313)
 *
 * `findOrCreateClient` vivait ici faute de porte ailleurs — la table d'un autre
 * domaine écrite par un module qui ne la possède pas, ce qu'api-module §3
 * n'admet pas. Elle est passée dans `crm`, derrière
 * `ClientDirectoryService.resolveWithin`, et ce fichier l'appelle **depuis
 * l'intérieur de sa propre transaction**.
 *
 * Ce n'est pas un déplacement gratuit : c'est ce qui rend vrai « un 409 ne laisse
 * aucune fiche derrière lui ». L'ancienne conduite validait la fiche dans une
 * transaction, puis tentait l'insertion dans une autre ; la perdante d'une course
 * repartait avec un refus et une fiche publique au fichier du salon. Les deux
 * écritures partagent désormais un `COMMIT` — et un `ROLLBACK`.
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
  rescheduledFromId: true,
  // La trace d'annulation (#40). Elle est lue parce qu'elle est écrite ici : un
  // `cancel` qui rendrait une ligne sans son horodatage obligerait l'appelant à
  // recomposer ce qu'il vient de demander, et une relecture d'historique
  // n'aurait aucun moyen de dire *quand* ni *par qui*. Le motif en fait partie —
  // ce que le module en laisse sortir se décide dans `AppointmentView`, pas ici.
  cancelledAt: true,
  cancelledBy: true,
  cancellationReason: true,
} as const;

type AppointmentRow = Prisma.AppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>;

/**
 * Ce que le **report** lit de la ligne d'origine : la frontière ci-dessus, plus
 * la note interne du staff — qu'il recopie sans jamais la rendre (#317).
 *
 * ## Pourquoi une seconde liste plutôt qu'un `APPOINTMENT_SELECT` élargi
 *
 * Les deux voies rendaient le critère « un report conserve `staff_note` ». Celle
 * qui n'a pas été retenue — ajouter `staffNote: true` à `APPOINTMENT_SELECT` et
 * l'exclure ensuite de `AppointmentView` — déplaçait la garantie d'un endroit où
 * elle est **structurelle** vers un endroit où elle devient une discipline :
 * `APPOINTMENT_SELECT` sert les six lectures du module, dont l'historique public
 * de #47 et la réservation d'invité. La note se serait mise à charger sur chacune
 * d'elles, et rien n'aurait plus empêché un futur champ de `AppointmentView`, ou
 * un `toRecord` étendu d'un geste, de la laisser sortir. « Ce qui n'est pas listé
 * ici ne peut pas franchir la frontière par inadvertance » aurait cessé d'être
 * vrai — pour un besoin qui ne concerne qu'une seule méthode.
 *
 * La voie retenue est donc la seconde : la colonne est lue **là où elle est
 * recopiée**, et nulle part ailleurs. Elle alimente le `create` de `move` et rien
 * d'autre — le `select` de ce `create` reste `APPOINTMENT_SELECT`, si bien que la
 * ligne écrite est relue **sans** sa note. Aucune valeur de `staff_note` n'existe
 * donc jamais dans un `AppointmentRecord`, ni a fortiori dans un
 * `AppointmentView` : la note traverse la transaction sans laisser de trace dans
 * ce que le module rend.
 *
 * Le coût est nul : c'est la même requête, avec une colonne de plus. Aucun
 * aller-retour supplémentaire, aucune lecture ajoutée ailleurs.
 *
 * ## Ce que le back-office en fera
 *
 * #50 et la surface de back-office auront besoin de **lire** cette note pour
 * l'afficher au comptoir. Ce sera une sortie distincte — une vue de back-office,
 * gardée par un rôle —, jamais un champ de plus sur `AppointmentView`, qui sert
 * aussi le parcours public. Le contrat partagé le documente déjà : `staffNote`
 * y est « jamais servie au parcours public ».
 */
const RESCHEDULE_SOURCE_SELECT = {
  ...APPOINTMENT_SELECT,
  staffNote: true,
} as const;

/**
 * Ce que l'**agenda du back-office** lit d'une ligne — la frontière commune,
 * plus ce qu'un comptoir affiche et que le parcours public ne doit pas voir
 * (#444).
 *
 * Trois ajouts, et chacun a sa raison :
 *
 * - les trois *summaries*, par **jointure sur la même requête**. C'est la
 *   conduite de `VISIT_SELECT` du CRM, et pour le même motif : un agenda affiche
 *   « Camille — Massage 60 min », et résoudre les noms ligne par ligne ferait
 *   N+1 lectures sur un écran qui en montre plusieurs centaines. Le tampon avant
 *   de la prestation voyage avec elle — il ne sort jamais, il sert à retrouver
 *   l'intervalle facturé depuis l'occupé ;
 * - `staffNote`, la note interne du praticien. C'est la « sortie distincte,
 *   gardée par un rôle » qu'annonce l'en-tête de `RESCHEDULE_SOURCE_SELECT`
 *   (#317), et c'est exactement pourquoi elle n'entre pas dans
 *   `APPOINTMENT_SELECT` : celui-là sert six lectures, dont l'historique public
 *   de #47 ;
 * - `createdAt`, obligatoire dans `appointmentSchema` du contrat.
 *
 * ## L'isolation de la jointure ne tient pas à ce `select`
 *
 * Elle tient au schéma. `$allOperations` n'intercepte que l'opération de premier
 * niveau : les relations lues ici ne repassent pas par l'extension. Ce sont les
 * clés étrangères composites `(tenant_id, client_id)`, `(tenant_id, staff_id)` et
 * `(tenant_id, service_id)` de la migration initiale qui interdisent qu'une
 * ligne d'un salon en désigne une d'un autre — donc que le parcours sorte du
 * tenant. La même dépendance explicite que celle du CRM, et
 * `prisma-schema.spec.ts` la tient.
 */
const AGENDA_SELECT = {
  ...APPOINTMENT_SELECT,
  staffNote: true,
  createdAt: true,
  client: { select: { id: true, firstName: true, lastName: true } },
  staff: { select: { id: true, displayName: true } },
  service: {
    select: {
      id: true,
      name: true,
      durationMinutes: true,
      bufferBeforeMinutes: true,
      priceAmountMinor: true,
      priceCurrency: true,
    },
  },
} as const;

type AgendaRow = Prisma.AppointmentGetPayload<{ select: typeof AGENDA_SELECT }>;

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

/** Une ligne d'agenda, *summaries* et note interne comprises (#444). */
function toAgendaRecord(row: AgendaRow): AgendaAppointmentRecord {
  return {
    ...toRecord(row),
    client: row.client,
    staff: row.staff,
    service: {
      id: row.service.id,
      name: row.service.name,
      durationMinutes: row.service.durationMinutes,
      bufferBeforeMinutes: row.service.bufferBeforeMinutes,
      // Le tarif **courant** du catalogue, à ne pas confondre avec le prix figé
      // que `toRecord` vient de poser sur la ligne : les deux voyagent côte à
      // côte, et le second seul est ce que la cliente doit.
      price: { amountMinor: row.service.priceAmountMinor, currency: row.service.priceCurrency },
    },
    staffNote: row.staffNote,
    createdAt: row.createdAt,
  };
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
    rescheduledFromId: row.rescheduledFromId,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
  };
}

@Injectable()
export class AppointmentsRepository {
  public constructor(
    @Inject(PRISMA) private readonly prisma: ScopedPrismaClient,
    /**
     * La porte du fichier client (#313) — la seule chose que ce module sache de
     * `crm`, et la seule qu'il lui demande : un identifiant de fiche.
     *
     * Injectée dans le **repository** et non dans le service, parce que le seul
     * moment où la résolution peut avoir lieu est à l'intérieur de la transaction
     * — et que c'est ce fichier qui l'ouvre. La faire descendre depuis le service
     * aurait exigé qu'il manipule une portée Prisma, ce qu'api-module §2 lui
     * interdit précisément.
     */
    private readonly clients: ClientDirectoryService,
  ) {}

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
    return this.writingAgenda(
      () => this.insert(draft),
      () => new SlotNoLongerAvailableError(draft.staffId, draft.startsAt),
    );
  }

  /**
   * Déplace un rendez-vous : **annulation de l'ancien et création du nouveau**,
   * liés par `rescheduled_from_id`, dans une seule transaction (#39,
   * booking-engine §5).
   *
   * ## Pourquoi ce n'est pas un `UPDATE` des dates
   *
   * Deux raisons, et chacune suffirait.
   *
   * L'**historique** : déplacer les bornes de la ligne existante efface l'heure
   * d'origine. La cliente ne peut plus voir d'où son rendez-vous vient, et le
   * salon ne peut plus compter ses reports — un report qui se déguise en
   * rendez-vous initial fausse le reporting du CDC §1.4.
   *
   * La **contrainte d'exclusion** : `appointments_no_overlap` compare la ligne
   * modifiée aux autres, elle-même comprise. Avancer d'une demi-heure un soin
   * qui dure une heure ferait chevaucher la ligne avec l'état qu'elle avait
   * avant, et PostgreSQL refuserait un déplacement parfaitement légitime.
   * Annuler **puis** créer sort la ligne de l'index partiel — `WHERE status IN
   * ('PENDING','CONFIRMED')` — avant que l'insertion ne soit jugée. La garantie
   * n'est pas contournée, elle est demandée dans l'ordre où elle a un sens.
   *
   * ## L'atomicité est ce qui rend l'échec inoffensif
   *
   * Tout est dans la même transaction. Si la contrainte refuse le nouveau
   * créneau — quelqu'un vient de le prendre —, le `ROLLBACK` emporte
   * l'annulation avec l'insertion : **l'ancien rendez-vous est intact**, au
   * statut où il était. C'est le troisième critère de #39, et il n'est tenu par
   * aucun code applicatif : il est tenu par la transaction.
   *
   * ## Le statut est **repris**, pas remis à `PENDING`
   *
   * Reporter déplace un créneau ; cela n'annule pas une confirmation déjà
   * obtenue. Rétrograder un `CONFIRMED` en `PENDING` demanderait à une cliente
   * qui a déjà confirmé de confirmer à nouveau, et exposerait le rendez-vous
   * déplacé à toute purge future des réservations non confirmées. Les deux
   * statuts occupent l'agenda de la même façon : la garantie
   * anti-double-réservation est rigoureusement identique dans un cas comme dans
   * l'autre.
   *
   * @throws {NotFoundError} rendez-vous inconnu, ou appartenant à un autre
   * établissement — jamais 403, qui confirmerait son existence.
   * @throws {InvalidStateTransitionError} rendez-vous terminé, annulé ou
   * no-show : il n'y a plus de créneau à déplacer.
   * @throws {ConflictError} le rendez-vous a changé d'état entre la lecture et
   * l'écriture — deux reports concurrents, dont un seul aboutit.
   * @throws {SlotNoLongerAvailableError} la contrainte d'exclusion a refusé le
   * nouveau créneau.
   */
  public async reschedule(draft: RescheduleDraft): Promise<RescheduleOutcome> {
    return this.writingAgenda(
      () => this.move(draft),
      () => new SlotNoLongerAvailableError(draft.staffId, draft.startsAt),
    );
  }

  /**
   * Annule un rendez-vous et **libère son créneau** (#40, booking-engine §5).
   *
   * ## Ce qui rend le créneau réservable, et ce qui ne le rend pas
   *
   * Rien dans cette méthode. Le créneau redevient réservable parce que la ligne
   * quitte le filtre partiel de `appointments_no_overlap` —
   * `WHERE status IN ('PENDING','CONFIRMED')` — au moment même où le `COMMIT` a
   * lieu. C'est le troisième critère de #40, et il est tenu par l'index, pas par
   * du code : aucune purge, aucune invalidation, aucun « libérer le créneau » à
   * écrire, donc aucun oubli possible. La contrainte n'est pas relâchée d'un
   * cran au passage — une réservation concurrente sur ce créneau reste jugée par
   * elle, exactement comme avant.
   *
   * ## L'écriture conditionnelle sur le statut n'est pas une vérification
   *
   * Même conduite que `move`, et pour la même raison : `updateMany` filtre sur
   * `status IN (…occupants)` et rend un **compte**. Deux annulations concurrentes
   * du même rendez-vous se sérialisent sur le verrou de ligne ; la seconde relit
   * après la validation de la première, ne reconnaît plus la ligne, et met à jour
   * zéro ligne. C'est un test-et-pose atomique rendu par le moteur, jamais un
   * « est-ce encore annulable ? » suivi d'une écriture (booking-engine §1).
   *
   * ## Pourquoi aucune transaction, alors que le report en ouvre une
   *
   * Parce qu'il n'y a **qu'une** écriture. Le report annule puis insère, et son
   * atomicité est ce qui garantit qu'un créneau d'arrivée refusé laisse l'ancien
   * rendez-vous intact. Ici, l'`UPDATE` conditionnel est déjà atomique à lui
   * seul, et il porte l'entièreté de la garantie. La lecture qui le précède ne
   * décide de rien : elle sert à **répondre** — distinguer un identifiant
   * inconnu d'un rendez-vous déjà annulé, ce qu'un compte de lignes ne dit pas.
   * L'envelopper d'une transaction n'aurait rien resserré sous `READ COMMITTED`,
   * et aurait coûté deux allers-retours de plus par annulation.
   *
   * Aucun verrou consultatif non plus : celui de `insert` sérialise les
   * **écritures qui se disputent un créneau**. Une annulation n'en dispute
   * aucun ; elle en rend un.
   *
   * @throws {NotFoundError} rendez-vous inconnu, ou appartenant à un autre
   * établissement — jamais 403, qui confirmerait son existence.
   * @throws {InvalidStateTransitionError} rendez-vous terminé, déjà annulé ou
   * no-show : il n'y a plus rien à annuler.
   * @throws {ConflictError} le rendez-vous a changé d'état entre la lecture et
   * l'écriture — deux annulations concurrentes, dont une seule inscrit son
   * auteur et son motif.
   */
  public async cancel(draft: CancelDraft): Promise<AppointmentRecord> {
    // `findFirst` et non `findUnique`, pour la raison de `findById` : c'est
    // l'extension qui injecte `tenantId` dans le `where`. Le rendez-vous d'un
    // autre établissement est donc introuvable ici, et rend 404 plutôt qu'un 403
    // qui confirmerait son existence (tenant-isolation §4).
    const previous = await this.prisma.appointment.findFirst({
      where: { id: draft.appointmentId },
      select: APPOINTMENT_SELECT,
    });

    if (previous === null) {
      throw new NotFoundError('Rendez-vous introuvable.');
    }

    if (!occupiesSlot(previous.status)) {
      throw new InvalidStateTransitionError(previous.status, 'CANCELLED');
    }

    const cancelled = {
      status: 'CANCELLED',
      cancelledAt: draft.cancelledAt,
      cancelledBy: draft.cancelledBy,
      cancellationReason: draft.reason,
    } as const;

    const released = await this.prisma.appointment.updateMany({
      where: { id: previous.id, status: { in: [...OCCUPYING_STATUSES] } },
      data: cancelled,
    });

    if (released.count !== 1) {
      throw new ConflictError(
        'Ce rendez-vous vient d’être modifié. Rechargez-le avant de l’annuler.',
        { appointmentId: previous.id },
      );
    }

    // Recomposé plutôt que relu : ces quatre champs sont les **seuls** que
    // l'`UPDATE` vient de changer, et une seconde lecture ne ferait qu'ajouter
    // un aller-retour pour retrouver ce qu'on sait déjà.
    return toRecord({ ...previous, ...cancelled });
  }

  /**
   * Une écriture d'agenda, **réessayée sur interblocage** et traduite sur refus
   * de créneau.
   *
   * Facteur commun de `create` et de `reschedule` : les deux insèrent sous la
   * contrainte d'exclusion, les deux prennent le verrou consultatif du
   * praticien, et les deux doivent donc distinguer les deux issues concurrentes
   * de la même façon. Deux copies de cette boucle divergeraient — et celle qui
   * divergerait rendrait un 500 là où le contrat annonce un 409.
   *
   * `taken` est une fabrique et non une instance : construire l'erreur d'avance
   * capturerait une pile d'appel qui ne désigne pas le site du refus.
   *
   * ## Un troisième cas de réessai, depuis #313 : la course sur la fiche cliente
   *
   * `ClientRecordRaceError` dit que deux réservations d'invité concurrentes ont
   * créé la même fiche et que celle-ci a perdu. C'est le même genre d'échec qu'un
   * interblocage — une course d'ordonnancement, jamais un refus métier — et il se
   * traite de la même façon : recommencer, la tentative suivante trouvant la fiche
   * que la gagnante vient d'écrire.
   *
   * Le réessai est **ici** et non dans `crm`, et il ne peut pas être ailleurs :
   * une violation de contrainte abandonne la transaction côté PostgreSQL, si bien
   * que rien ne peut plus être lu ni écrit dedans. Seul celui qui l'a ouverte peut
   * la rejouer.
   */
  private async writingAgenda<T>(
    operation: () => Promise<T>,
    taken: () => SlotNoLongerAvailableError,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error: unknown) {
        // Sans cette traduction, la perdante d'une course reçoit un 500 là où le
        // contrat annonce un 409 — et le front n'a plus rien à proposer au client.
        if (isSlotExclusionViolation(error)) {
          throw taken();
        }
        if (!this.worthRetrying(error) || attempt >= MAX_INSERT_ATTEMPTS) {
          throw error;
        }
        await backOff(attempt);
      }
    }
  }

  /**
   * `true` si l'échec est une course d'ordonnancement que rejouer résout.
   *
   * Deux origines, une seule conduite : PostgreSQL a abattu la transaction
   * (interblocage, échec de sérialisation), ou la fiche cliente a été créée
   * ailleurs entre la lecture et l'écriture. Aucune des deux n'apprend quoi que ce
   * soit sur l'agenda, et les traduire en 409 ferait perdre une réservation sur un
   * créneau peut-être libre.
   */
  private worthRetrying(error: unknown): boolean {
    return isTransientWriteConflict(error) || error instanceof ClientRecordRaceError;
  }

  /**
   * Le report proprement dit — une tentative, sans interprétation de l'échec.
   *
   * Le verrou consultatif porte sur l'agenda **d'arrivée** : c'est là que
   * l'insertion aura lieu, donc là que les candidates doivent s'ordonner. Le
   * départ n'en a pas besoin — une annulation ne peut entrer en conflit avec
   * rien, elle ne fait que libérer.
   *
   * N'en prendre qu'un est délibéré : deux verrous prisonniers dans un ordre
   * dépendant des données — l'ancien praticien, puis le nouveau — reformeraient
   * exactement le cycle d'attente que ce verrou existe pour supprimer (ADR 0006).
   *
   * ## L'écriture conditionnelle sur le statut n'est pas une vérification
   *
   * `updateMany` filtre sur `status IN (…occupants)` et rend un **compte**. Deux
   * reports concurrents du même rendez-vous se sérialisent sur le verrou de
   * ligne : le second relit la ligne après la validation du premier, ne la
   * reconnaît plus, et met à jour zéro ligne. C'est un test-et-pose atomique
   * rendu par le moteur, et non un « est-ce encore reportable ? » suivi d'une
   * écriture — la conduite que booking-engine §1 interdit.
   *
   * La lecture qui précède ne sert donc pas à décider : elle sert à **répondre**
   * — distinguer un identifiant inconnu d'un rendez-vous déjà terminé, ce qu'un
   * compte de lignes ne dit pas.
   */
  private async move(draft: RescheduleDraft): Promise<RescheduleOutcome> {
    const tenantId = requireTenantId('Appointment', 'reschedule');
    const agenda = `appointments:tenant_id=${tenantId}:staff_id=${draft.staffId}`;

    return this.prisma.$transaction(async (tx) => {
      // eslint-disable-next-line tenant/raw-sql-tenant-filter -- Ce SQL ne lit ni n'écrit aucune ligne : il prend un verrou consultatif dont la clé porte le tenant, transmis en paramètre lié (`agenda`). Il n'y a pas de `WHERE` à filtrer.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${agenda}::text, 0::bigint))`;

      // `findFirst` et non `findUnique`, pour la raison de `findById` :
      // l'extension injecte `tenantId` dans le `where`. Un rendez-vous d'un autre
      // établissement est donc introuvable, et rend 404 plutôt qu'un 403 qui
      // confirmerait son existence (tenant-isolation §4).
      const previous = await tx.appointment.findFirst({
        where: { id: draft.previousId },
        // La seule lecture du module qui demande `staff_note` — parce que c'est
        // la seule qui la recopie (#317). Voir `RESCHEDULE_SOURCE_SELECT`.
        select: RESCHEDULE_SOURCE_SELECT,
      });

      if (previous === null) {
        throw new NotFoundError('Rendez-vous introuvable.');
      }

      if (!occupiesSlot(previous.status)) {
        // Terminé, déjà annulé, ou no-show : il n'y a plus de créneau à
        // déplacer, et en créer un nouveau à cette occasion serait une
        // réservation déguisée.
        throw new InvalidStateTransitionError(previous.status, 'CANCELLED');
      }

      const released = await tx.appointment.updateMany({
        where: { id: previous.id, status: { in: [...OCCUPYING_STATUSES] } },
        data: {
          status: 'CANCELLED',
          // Ni auteur, ni motif — et c'est délibéré depuis que #40 a posé les
          // deux colonnes. Un report n'est pas un abandon : ce qui le dit est le
          // `rescheduled_from_id` que porte le successeur. Lui inscrire un
          // auteur d'annulation le ferait compter comme une annulation dans le
          // reporting du CDC §1.4, alors que la cliente vient précisément de
          // garder son rendez-vous.
          cancelledAt: new Date(),
        },
      });

      if (released.count !== 1) {
        throw new ConflictError('Ce rendez-vous vient d’être modifié. Rechargez-le avant de le reporter.', {
          appointmentId: previous.id,
        });
      }

      const row = await tx.appointment.create({
        data: withScopedTenant<Prisma.AppointmentUncheckedCreateInput>({
          // Recopiés de la ligne relue **dans la transaction**, jamais de la
          // demande : reporter ne change ni la cliente, ni la prestation, ni le
          // prix figé à la réservation d'origine.
          clientId: previous.clientId,
          serviceId: previous.serviceId,
          priceAmountMinor: previous.priceAmountMinor,
          priceCurrency: previous.priceCurrency,
          clientNote: previous.clientNote,
          // La note interne du praticien suit le rendez-vous, elle n'appartient
          // pas au créneau (#317). Sans cette ligne, « cliente sourde de
          // l'oreille droite » ou « prévoir une cabine sans musique » restait sur
          // la ligne annulée, et le salon perdait au report ce qu'un praticien
          // avait pris la peine d'écrire. Recopiée à l'aveugle : elle est écrite
          // ici, jamais relue — le `select` ci-dessous ne la demande pas.
          staffNote: previous.staffNote,
          status: previous.status,
          staffId: draft.staffId,
          startsAt: draft.startsAt,
          endsAt: draft.endsAt,
          rescheduledFromId: previous.id,
        }),
        // `APPOINTMENT_SELECT`, et non `RESCHEDULE_SOURCE_SELECT` : la note vient
        // d'être écrite, elle n'a aucune raison d'être relue. C'est ce qui rend
        // impossible sa présence dans le `AppointmentRecord` rendu.
        select: APPOINTMENT_SELECT,
      });

      return { previous: toRecord(previous), created: toRecord(row) };
    });
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
   * ## La fiche cliente est résolue **dans cette transaction**, après le verrou
   *
   * C'est le second critère de #313 : « un 409 ne laisse aucune fiche derrière
   * lui ». `ClientDirectoryService.resolveWithin` reçoit la portée `tx` et écrit
   * dedans ; si la contrainte d'exclusion refuse l'insertion qui suit, le
   * `ROLLBACK` emporte la fiche avec elle. Rien de tout cela n'est du code : c'est
   * la transaction, exactement comme pour le report (`move`).
   *
   * L'ordre — verrou, puis fiche, puis rendez-vous — n'est pas indifférent. Le
   * verrou d'abord, parce qu'il est ce qui sérialise les candidates à ce créneau
   * et supprime le cycle d'attente (ADR 0006) ; une résolution posée avant lui
   * ferait attendre sur l'index unique de `users` une transaction qui ne tient pas
   * encore l'agenda, c'est-à-dire recréerait un ordre d'acquisition dépendant des
   * données. La fiche ensuite, parce que `appointments.client_id` est `NOT NULL` :
   * il faut la ligne avant de pouvoir la désigner.
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

      // L'écriture dans `users` appartient à `crm` (#313) : ce module la demande,
      // il ne la fait plus. La portée passée est celle de cette transaction — la
      // fiche et le rendez-vous sont donc validés, ou abandonnés, ensemble.
      const clientId = await this.clients.resolveWithin(tx, draft.client);

      const row = await tx.appointment.create({
        data: withScopedTenant<Prisma.AppointmentUncheckedCreateInput>({
          clientId,
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
   * L'historique d'une cliente dans l'établissement courant — la moitié
   * demandée, bornée (#47).
   *
   * ## Où passe la frontière entre « à venir » et « passé »
   *
   * | Moitié | Prédicat | Ordre |
   * |---|---|---|
   * | `upcoming` | l'intervalle n'est pas terminé **et** le statut occupe encore le créneau | du plus proche au plus lointain |
   * | `past` | tout le reste | du plus récent au plus ancien |
   *
   * Ce n'est pas un filtre de statut, et les confondre produirait un écran faux :
   * un rendez-vous annulé pour demain n'a plus rien à honorer, il n'a donc rien à
   * faire dans « à venir » — mais il n'est pas perdu pour autant, il descend dans
   * l'historique avec sa mention d'annulation. Les deux moitiés sont
   * **complémentaires et disjointes** : toute ligne de la cliente tombe dans
   * exactement une des deux, si bien qu'aucun rendez-vous ne peut disparaître de
   * son espace client.
   *
   * `endsAt` est la borne **occupée** — celle qui est en base. L'écart avec la
   * fin facturée est le tampon d'après-soin, quelques minutes : un rendez-vous
   * qui vient de se terminer reste « à venir » le temps de ce tampon. Corriger
   * cela demanderait de connaître les tampons de la prestation dans le `where`,
   * donc une jointure sur le catalogue à chaque lecture d'historique, pour une
   * différence que personne ne voit.
   *
   * ## Ce que cette méthode ne prend pas en paramètre
   *
   * Le tenant. Comme toutes les lectures de ce fichier, elle passe par le client
   * **scopé** : l'extension ajoute `tenantId` au `where`, et
   * `@@index([tenantId, clientId, startsAt])` sert exactement le couple obtenu.
   * Une cliente d'un autre établissement — même identifiant, autre portée — ne
   * ramène donc rien, sans qu'aucune comparaison n'ait à être écrite ici.
   */
  public async listForClient(query: ClientAppointmentsQuery): Promise<AppointmentRecord[]> {
    const upcoming = query.scope === 'upcoming';

    const rows = await this.prisma.appointment.findMany({
      where: {
        clientId: query.clientId,
        ...(upcoming
          ? { endsAt: { gt: query.now }, status: { in: [...OCCUPYING_STATUSES] } }
          : {
              // Le complément exact du prédicat ci-dessus, écrit comme tel :
              // « terminé » **ou** « ne tient plus le créneau ». Un simple
              // `endsAt: { lte: now }` laisserait les annulations futures hors
              // des deux moitiés, donc invisibles.
              OR: [
                { endsAt: { lte: query.now } },
                { status: { notIn: [...OCCUPYING_STATUSES] } },
              ],
            }),
      },
      select: APPOINTMENT_SELECT,
      // `id` départage à égalité d'instant : sans lui, PostgreSQL ne garantit
      // aucun ordre entre deux rendez-vous de même début, et la liste changerait
      // d'un rafraîchissement à l'autre.
      orderBy: upcoming
        ? [{ startsAt: 'asc' }, { id: 'asc' }]
        : [{ startsAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });

    return rows.map(toRecord);
  }

  /**
   * L'agenda de l'établissement courant sur une fenêtre d'instants (#444).
   *
   * ## Le prédicat est une **intersection**, pas un « commence dans la plage »
   *
   * `startsAt < window.to && endsAt > window.from` — bornes `[)`, le même
   * prédicat que la contrainte d'exclusion. Ce n'est pas un raffinement : la base
   * stocke l'intervalle **occupé**, tampons compris, et la réponse rend
   * l'intervalle facturé. Un soin de 00:05 occupe donc l'agenda depuis 23:55 la
   * veille, et un filtre sur le seul début de ligne l'aurait fait disparaître de
   * la journée où le comptoir l'attend. Une réservation à cheval sur deux jours
   * apparaît, pour la même raison, dans les deux.
   *
   * ## Les filtres sont posés tels quels, et aucun n'est un `if` de sécurité
   *
   * `staffId`, `clientId`, `serviceId` et `statuses` ne restreignent qu'à
   * l'intérieur de ce qui est **déjà** borné au tenant par l'extension. Un
   * identifiant d'un autre établissement ne rend donc pas une erreur : il ne
   * correspond à aucune ligne, et la réponse est vide. C'est le comportement
   * voulu — un 403 ou un 404 sur un filtre confirmerait l'existence de la
   * ressource visée (tenant-isolation §4), et ferait de cette route une sonde
   * d'annuaire.
   *
   * `undefined` plutôt qu'une clé posée à `null` : sur `staffId`, Prisma lirait
   * un `null` comme « les lignes dont le praticien est nul », qui n'existent pas
   * — la colonne est `NOT NULL`. La différence entre « pas de filtre » et « aucun
   * résultat » se joue là.
   *
   * ## L'ordre est total, et il l'est délibérément
   *
   * `(startsAt, id)`. Sans le second critère, PostgreSQL ne garantit aucun ordre
   * entre deux rendez-vous qui commencent au même instant — deux praticiens à
   * 10:00, le cas le plus banal d'un salon —, et la grille du calendrier
   * réordonnerait ses colonnes d'un rafraîchissement à l'autre.
   *
   * ## Ce que cette méthode ne prend pas en paramètre
   *
   * Le tenant, comme toutes les lectures de ce fichier :
   * `@@index([tenantId, startsAt])` sert exactement le couple que l'extension
   * produit.
   */
  public async listAgenda(query: AgendaQuery): Promise<AgendaAppointmentRecord[]> {
    const rows = await this.prisma.appointment.findMany({
      where: {
        startsAt: { lt: query.to },
        endsAt: { gt: query.from },
        ...(query.staffId === null ? {} : { staffId: query.staffId }),
        ...(query.clientId === null ? {} : { clientId: query.clientId }),
        ...(query.serviceId === null ? {} : { serviceId: query.serviceId }),
        ...(query.statuses === null ? {} : { status: { in: [...query.statuses] } }),
      },
      select: AGENDA_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map(toAgendaRecord);
  }

  /**
   * Le fuseau de l'établissement courant — `null` s'il n'existe pas.
   *
   * `Tenant` est scopé par l'extension **sur son `id`** : cette lecture ne peut
   * rendre que l'établissement de la requête, et il n'y a aucun paramètre par
   * lequel en désigner un autre.
   *
   * ## Pourquoi cette lecture est ici et non derrière un appel de service
   *
   * Parce qu'aucun module n'ouvre la porte. `IdentityModule` n'exporte pas
   * `TenantSettingsService`, `AvailabilityModule` n'exporte pas son repository —
   * seul `TenantClockService` en sort, et il **convertit** un fuseau, il ne le
   * lit pas. Le rendre public relève du module qui le possède, pas de celui-ci.
   *
   * Ce qui reste est une **lecture** d'une table que ce module ne possède pas,
   * exactement comme `AvailabilityRepository.currentTimeZone` en fait une :
   * elle ne crée ni ne modifie rien, et ne porte sur qu'une seule colonne. Le
   * jour où `identity` exposera « le fuseau de l'établissement courant », cette
   * lecture deviendra cet appel, et rien d'autre ne bougera.
   */
  public async currentTimeZone(): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({ select: { timezone: true } });

    return tenant?.timezone ?? null;
  }
}
