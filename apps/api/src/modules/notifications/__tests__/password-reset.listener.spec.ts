import { createHash } from 'node:crypto';

import { getTenantId } from '../../../common/tenant/tenant-context';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { IdentityEvents } from '../../identity/events/identity-events';
import {
  PASSWORD_RESET_REQUESTED,
  type PasswordResetRequestedEvent,
} from '../../identity/events/password-reset-requested.event';
import { PasswordResetListener } from '../password-reset.listener';
import type { NotificationMessage } from '../notifications.types';
import { recordingLogger } from './notifications.doubles';

/**
 * Le lien de réinitialisation, déclenché par l'événement de domaine — #809,
 * quatrième critère d'acceptation.
 *
 * ## Pourquoi le vrai bus, et un publieur qui ne fait que noter
 *
 * Ce qui est en jeu ici est un **branchement**, exactement comme pour la
 * confirmation de réservation : l'écouteur est-il posé sur le bon événement, la
 * portée de tenant est-elle ouverte, l'enveloppe porte-t-elle ce qu'il faut, et
 * l'échec reste-t-il confiné ? Doubler `IdentityEvents` aurait testé le double —
 * et notamment son enveloppe d'abonné, qui est précisément ce dont dépend la
 * garantie « un abonné qui lève ne fait pas ressortir la demande en erreur ».
 *
 * Le publieur, lui, est doublé au plus près de son contrat : une méthode qui
 * note ce qu'on lui remet. Monter `InProcessNotificationPublisher` aurait
 * entraîné le rendu et l'expéditeur, c'est-à-dire éprouvé la chaîne entière là
 * où `notification-renderer.spec.ts` s'en charge déjà — et ce qu'on veut lire
 * ici est **l'enveloppe**, pas le courrier.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'jeton.de.reinitialisation';

function event(overrides: Partial<PasswordResetRequestedEvent> = {}): PasswordResetRequestedEvent {
  return {
    name: PASSWORD_RESET_REQUESTED,
    tenantId: TENANT,
    userId: USER,
    token: TOKEN,
    occurredAt: '2026-09-18T09:00:00.000Z',
    ...overrides,
  };
}

function build(publish?: (message: NotificationMessage) => Promise<void>) {
  const logger = recordingLogger();
  const events = new IdentityEvents(logger.logger);
  const tenants = new TenantContextService();
  const published: NotificationMessage[] = [];
  /** La portée de tenant telle qu'elle est **au moment de publier**. */
  const scopes: (string | undefined)[] = [];

  const publisher = {
    publish: async (message: NotificationMessage): Promise<void> => {
      published.push(message);
      scopes.push(getTenantId());
      if (publish !== undefined) {
        await publish(message);
      }
    },
  };

  const listener = new PasswordResetListener(events, publisher, tenants, logger.logger);
  listener.onModuleInit();

  return { listener, events, published, scopes, logger };
}

describe('notifications — le lien de réinitialisation naît de l’événement de domaine', () => {
  it('s’abonne à `password-reset.requested` et publie sans qu’on l’appelle', async () => {
    // Rien n'appelle l'écouteur ici : le bus le fait. C'est le branchement que
    // ce cas éprouve, et c'est ce qu'un écouteur oublié dans les `providers` du
    // module ferait échouer — il compile, et ne reçoit rien en vrai.
    const { events, published } = build();

    events.passwordResetRequested({ tenantId: TENANT, userId: USER, token: TOKEN });
    // L'abonné est `async` : le bus ne l'attend pas, et `emit` rend la main
    // avant qu'il ait publié. Un tour de boucle d'événements suffit.
    await Promise.resolve();
    await Promise.resolve();

    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe('PASSWORD_RESET');
  });

  it('compose une enveloppe e-mail, sans rendez-vous, avec le jeton', async () => {
    const { listener, published } = build();

    await listener.handle(event());

    const message = published[0];
    // Canal figé par le quatrième critère : « modèle `password_reset`, canal
    // e-mail ». Aucune lecture des canaux joignables n'a lieu — un SMS ne
    // prouverait pas la possession de l'adresse, qui est ce que la procédure
    // vérifie.
    expect(message?.channel).toBe('EMAIL');
    // Ce message n'annonce aucun rendez-vous : c'est le seul des quatre dans ce
    // cas, et `null` est ce que la colonne signifie depuis l'origine.
    expect(message?.appointmentId).toBeNull();
    // Immédiat : le rappel J-1 reste le seul message planifié du MVP.
    expect(message?.scheduledFor).toBeNull();
    expect(message?.recipientUserId).toBe(USER);
    expect(message?.passwordResetToken).toBe(TOKEN);
  });

  it('déduplique sur l’empreinte du jeton, jamais sur le compte', async () => {
    // La propriété qui compte, et elle n'est pas intuitive : deux demandes
    // successives sont deux **faits distincts**, la seconde invalidant le jeton
    // de la première. Une clé par compte les aurait confondues — la seconde se
    // serait heurtée à l'index d'idempotence, et la personne n'aurait jamais
    // reçu le seul lien encore valable.
    const { listener, published } = build();

    await listener.handle(event());
    await listener.handle(event({ token: 'un.autre.jeton' }));

    const [premier, second] = published;
    expect(premier?.dedupeKey).not.toBe(second?.dedupeKey);
    // Et la clé porte l'**empreinte**, pas le secret : elle est écrite en base,
    // relue au back-office et journalisée par la route interne comme par le
    // publieur de file.
    expect(premier?.dedupeKey).toBe(
      `password-reset:${createHash('sha256').update(TOKEN).digest('hex')}:EMAIL`,
    );
    expect(premier?.dedupeKey).not.toContain(TOKEN);
  });

  it('ouvre la portée de tenant de l’événement avant de publier', async () => {
    // L'émission a lieu dans la requête HTTP qui a demandé la réinitialisation,
    // donc dans une portée déjà ouverte — mais s'y fier serait un pari sur
    // l'implémentation du bus. Le jour où l'événement viendra d'une file, il n'y
    // aura plus aucun `AsyncLocalStorage` dont hériter.
    const { listener, scopes } = build();

    await listener.handle(event());

    expect(scopes).toEqual([TENANT]);
  });

  it('n’échoue jamais, et journalise sans jamais écrire le jeton', async () => {
    // Le pendant du « toujours 202 » : le jeton est déjà armé en base quand
    // l'écouteur travaille, et la personne a déjà reçu sa réponse. Un échec de
    // publication ne peut donc remonter nulle part — il laisse une trace.
    const { listener, logger } = build(() => Promise.reject(new Error('file injoignable')));

    await expect(listener.handle(event())).resolves.toBeUndefined();

    const journal = JSON.stringify(logger.entries);
    expect(journal).toContain('file injoignable');
    // Ni le jeton, ni aucune coordonnée (notifications §7, CDC §5.1).
    expect(journal).not.toContain(TOKEN);
  });

  it('se retire du bus à l’arrêt du module', async () => {
    // Sans cela, chaque application montée par une suite laisserait son écouteur
    // sur un émetteur qui vit aussi longtemps que son instance.
    const { listener, events, published } = build();

    listener.onModuleDestroy();
    events.passwordResetRequested({ tenantId: TENANT, userId: USER, token: TOKEN });
    await Promise.resolve();

    expect(published).toHaveLength(0);
  });
});
