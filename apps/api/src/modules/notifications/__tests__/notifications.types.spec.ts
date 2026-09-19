import {
  NotificationChannel as PrismaNotificationChannel,
  NotificationStatus as PrismaNotificationStatus,
  NotificationType as PrismaNotificationType,
} from '@prisma/client';

import {
  appointmentDedupeKey,
  LIVE_NOTIFICATION_STATUSES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
} from '../notifications.types';

/**
 * Le **témoin** du vocabulaire des notifications : les listes que le service
 * manipule disent-elles la même chose que les colonnes ?
 *
 * `notifications.types.ts` déclare ces libellés à la main plutôt que de les
 * importer du client généré, pour la raison qui vaut dans `payments.types.ts` et
 * `identity/roles.ts` : ce fichier est lu par des couches auxquelles api-module
 * §2 interdit de connaître Prisma, et une machine sans `prisma generate` verrait
 * sinon échouer des suites qui ne parlent pas du schéma.
 *
 * Le prix de ce choix est la dérive possible, et c'est cette suite qui la
 * rattrape. L'import de `@prisma/client` est ici et **seulement ici** dans ce
 * module, le dépôt mis à part.
 */
describe('notifications — vocabulaire et colonnes', () => {
  it('énumère les messages du périmètre, dans l’ordre du schéma', () => {
    // Les **trois premiers** sont ceux du CDC §1.4 : ce qu'un rendez-vous
    // déclenche, et rien de plus. Ils restent en tête, et c'est ce que l'ordre
    // de cette liste tient.
    //
    // `PASSWORD_RESET` est le quatrième, entré par la porte que l'en-tête de
    // `packages/shared/src/constants/notification.ts` prescrit — une issue,
    // #809 — et non par une ligne. Il n'annonce aucun rendez-vous : il porte le
    // lien de récupération d'un accès perdu, que le CDC §2.3 exige au titre de
    // l'authentification. Il passe par cette chaîne parce qu'il n'y en a qu'une,
    // et que la seule autre issue serait un appel direct à SES depuis le chemin
    // de requête HTTP (notifications §1).
    //
    // `APPOINTMENT_CONFIRMED` est le cinquième, instruit de la même façon — une
    // issue, #800 — et il est, lui, du CDC §1.4 : la seconde moitié de la
    // « confirmation automatique ». Tout rendez-vous naît à confirmer par le
    // salon ; `BOOKING_CONFIRMATION` le dit à la réservation, celui-ci part
    // quand le salon a confirmé. En queue parce qu'`ADD VALUE` ajoute à la fin.
    //
    // Un **sixième** type serait à instruire de la même façon : c'est toujours
    // une issue, et jamais une ligne (CLAUDE.md, contrainte 1).
    expect(NOTIFICATION_TYPES).toEqual([
      'BOOKING_CONFIRMATION',
      'REMINDER_24H',
      'CANCELLATION',
      'PASSWORD_RESET',
      'APPOINTMENT_CONFIRMED',
    ]);
  });

  it('reprend `enum NotificationType` du schéma, dans l’ordre de déclaration', () => {
    expect([...NOTIFICATION_TYPES]).toEqual(Object.values(PrismaNotificationType));
  });

  it('reprend `enum NotificationChannel` du schéma, dans l’ordre de déclaration', () => {
    expect([...NOTIFICATION_CHANNELS]).toEqual(Object.values(PrismaNotificationChannel));
  });

  it('reprend `enum NotificationStatus` du schéma, dans l’ordre de déclaration', () => {
    expect([...NOTIFICATION_STATUSES]).toEqual(Object.values(PrismaNotificationStatus));
  });
});

describe('notifications — les statuts qui occupent la place', () => {
  it('compte `PENDING` et `SENT`, jamais `FAILED`', () => {
    // Le reflet applicatif du `WHERE` de `notifications_live_once`. `FAILED` y
    // figurerait que le premier throttling SES condamnerait le rappel : SQS
    // rejouerait dans le vide jusqu'à la DLQ (notifications §4).
    expect(LIVE_NOTIFICATION_STATUSES).toEqual(['PENDING', 'SENT']);
    expect(LIVE_NOTIFICATION_STATUSES).not.toContain('FAILED');
  });

  it('ne cite que des statuts que le schéma connaît', () => {
    for (const status of LIVE_NOTIFICATION_STATUSES) {
      expect(NOTIFICATION_STATUSES).toContain(status);
    }
  });
});

describe('notifications — la clé de déduplication', () => {
  it('est déterministe : deux publications du même rappel composent la même clé', () => {
    // C'est ce qui les fait entrer en conflit sur `(tenant_id, dedupe_key)` au
    // lieu de s'ignorer.
    expect(appointmentDedupeKey('rdv-1', 'REMINDER_24H', 'SMS')).toBe(
      appointmentDedupeKey('rdv-1', 'REMINDER_24H', 'SMS'),
    );
  });

  it('distingue le rendez-vous, le type et le canal', () => {
    const base = appointmentDedupeKey('rdv-1', 'REMINDER_24H', 'SMS');

    expect(appointmentDedupeKey('rdv-2', 'REMINDER_24H', 'SMS')).not.toBe(base);
    expect(appointmentDedupeKey('rdv-1', 'CANCELLATION', 'SMS')).not.toBe(base);
    expect(appointmentDedupeKey('rdv-1', 'REMINDER_24H', 'EMAIL')).not.toBe(base);
  });

  it('tient dans la colonne, même sur un UUID', () => {
    // `dedupe_key` est un VARCHAR(255) : une clé plus longue serait tronquée par
    // PostgreSQL, donc deux messages distincts pourraient devenir un doublon.
    const longest = appointmentDedupeKey(
      '00000000-0000-4000-8000-000000000000',
      'BOOKING_CONFIRMATION',
      'EMAIL',
    );

    expect(longest.length).toBeLessThanOrEqual(255);
  });
});
