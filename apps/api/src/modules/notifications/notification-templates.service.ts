import { Injectable } from '@nestjs/common';

import { defaultTemplateFor } from './notification-default-templates';
import {
  SMS_MAX_SEGMENTS,
  measureSmsTemplate,
  unbalancedSections,
  unknownPlaceholders,
  type SmsCost,
} from './notification-template';
import { NotificationTemplatesRepository } from './notification-templates.repository';
import {
  NotificationTemplateInvalidError,
  NotificationTemplateNotFoundError,
  NotificationTemplateTooLongError,
} from './notifications.errors';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationTemplateSource,
  type NotificationTemplateView,
  type NotificationType,
} from './notifications.types';

/**
 * Les modèles de messages d'un établissement — #69.
 *
 * ## Ce que ce service tient, et que ni le contrôleur ni le dépôt ne peuvent
 * tenir
 *
 * Deux règles, et ce sont les deux critères d'acceptation qui ne se lisent pas
 * dans un schéma :
 *
 * 1. **la résolution du modèle effectif** — la personnalisation du salon si elle
 *    existe, le modèle de la plateforme sinon. C'est elle qui donne son sens à
 *    « un modèle par défaut au niveau plateforme », et elle est ici plutôt que
 *    dans le dépôt parce que le défaut n'est pas en base ;
 * 2. **la validation d'un modèle soumis** — variables connues, sections
 *    refermées, coût du SMS borné. Un contrôleur ne peut pas la porter : elle
 *    dépend de la grammaire du moteur, pas de la forme de la requête.
 *
 * ## La validation ne relit pas ce qui est déjà en base
 *
 * Elle s'applique à l'écriture, une fois, et pas à la lecture. Un modèle
 * enregistré avant un resserrement des règles resterait donc lisible et
 * envoyable. C'est délibéré : refuser à la lecture aurait rendu un salon
 * incapable de voir — donc de corriger — le modèle qui le bloque, et privé ses
 * clientes de leurs confirmations en attendant.
 */
@Injectable()
export class NotificationTemplatesService {
  public constructor(private readonly repository: NotificationTemplatesRepository) {}

  /**
   * Tous les modèles **effectifs** de l'établissement.
   *
   * Un par couple `(type, canal)` qui en a un : quatre par défaut — confirmation
   * et rappel, e-mail et SMS —, davantage si le salon a personnalisé un message
   * que la plateforme ne fournit pas encore. Un couple sans modèle du tout
   * (`CANCELLATION` tant que #72 n'est pas livré, et que le salon n'a rien écrit)
   * n'apparaît pas : la liste répond à « que reçoit ma cliente ? », et la réponse
   * pour ce message est « rien ».
   *
   * L'ordre est celui des énumérations — le même que celui du schéma, donc le
   * même d'un appel à l'autre. Une liste de configuration qui change d'ordre
   * fait bouger les lignes sous la souris.
   */
  public async list(): Promise<readonly NotificationTemplateView[]> {
    const stored = await this.repository.findAll();
    const views: NotificationTemplateView[] = [];

    for (const type of NOTIFICATION_TYPES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        const custom = stored.find((row) => row.type === type && row.channel === channel);

        if (custom !== undefined) {
          views.push(view(type, channel, 'TENANT', custom.source, custom.updatedAt));
          continue;
        }

        const fallback = defaultTemplateFor(type, channel);

        if (fallback !== null) {
          views.push(view(type, channel, 'PLATFORM', fallback, null));
        }
      }
    }

    return views;
  }

  /**
   * Le modèle effectif d'un message.
   *
   * @throws {NotificationTemplateNotFoundError} ni personnalisation, ni défaut.
   */
  public async get(
    type: NotificationType,
    channel: NotificationChannel,
  ): Promise<NotificationTemplateView> {
    const custom = await this.repository.find(type, channel);

    if (custom !== null) {
      return view(type, channel, 'TENANT', custom.source, custom.updatedAt);
    }

    const fallback = defaultTemplateFor(type, channel);

    if (fallback === null) {
      throw new NotificationTemplateNotFoundError(type, channel);
    }

    return view(type, channel, 'PLATFORM', fallback, null);
  }

  /**
   * Enregistre la personnalisation d'un message, après l'avoir validée.
   *
   * La validation précède l'écriture, jamais l'inverse : un modèle refusé ne doit
   * pas avoir touché la base, sans quoi un salon pourrait enregistrer un modèle
   * que le rendu refusera ensuite d'envoyer — et ses clientes n'auraient plus de
   * confirmation.
   */
  public async save(
    type: NotificationType,
    channel: NotificationChannel,
    source: NotificationTemplateSource,
  ): Promise<NotificationTemplateView> {
    const normalized = normalize(channel, source);

    assertPlaceholdersAreKnown(normalized);
    assertChannelFieldsArePresent(channel, normalized);
    assertSmsFitsBudget(channel, normalized);

    const saved = await this.repository.save(type, channel, normalized);

    return view(type, channel, 'TENANT', saved.source, saved.updatedAt);
  }

  /**
   * Rend l'établissement au modèle par défaut de la plateforme.
   *
   * Idempotent : effacer une personnalisation qui n'existe pas laisse le salon
   * dans l'état demandé. La réponse est le modèle **désormais** effectif, et non
   * un accusé vide — c'est ce qu'un écran a besoin d'afficher juste après le
   * clic.
   *
   * @throws {NotificationTemplateNotFoundError} le message n'a pas de défaut de
   * plateforme : effacer la personnalisation le laisserait sans aucun modèle.
   * L'effacement a **quand même** eu lieu — c'est ce que le salon a demandé —, et
   * le refus porte sur la lecture qui suit, pas sur le geste.
   */
  public async reset(
    type: NotificationType,
    channel: NotificationChannel,
  ): Promise<NotificationTemplateView> {
    await this.repository.remove(type, channel);

    return this.get(type, channel);
  }
}

/** Un modèle effectif, sa provenance, et ce qu'il coûtera s'il part en SMS. */
function view(
  type: NotificationType,
  channel: NotificationChannel,
  origin: NotificationTemplateView['origin'],
  source: NotificationTemplateSource,
  updatedAt: Date | null,
): NotificationTemplateView {
  return { type, channel, origin, source, updatedAt, sms: smsCost(channel, source) };
}

/**
 * Le coût mesuré du modèle, sur le canal où il en a un.
 *
 * `null` sur l'e-mail : un e-mail long ne coûte rien de plus, et rendre un
 * chiffre là où il n'y a pas de facture inviterait à l'optimiser.
 */
function smsCost(channel: NotificationChannel, source: NotificationTemplateSource): SmsCost | null {
  return channel === 'SMS' ? measureSmsTemplate(source.text) : null;
}

/**
 * Met le modèle dans la forme que le canal admet.
 *
 * Sur le canal SMS, l'objet et le corps HTML sont **forcés à vide** plutôt que
 * refusés. Le refus aurait été plus bavard sans être plus sûr : un expéditeur SNS
 * ne lit que `text`, et ce qui n'est pas stocké ne peut pas être envoyé par
 * erreur le jour où une passerelle mal branchée lirait `html`. C'est la même
 * conduite que `renderNotification`, à l'autre bout de la chaîne.
 */
function normalize(
  channel: NotificationChannel,
  source: NotificationTemplateSource,
): NotificationTemplateSource {
  return channel === 'SMS'
    ? { subject: '', html: '', text: source.text }
    : { subject: source.subject, html: source.html, text: source.text };
}

/**
 * Refuse un modèle qui nomme une variable inconnue ou laisse une section ouverte.
 *
 * Les trois corps sont examinés **ensemble** et l'erreur les nomme d'un coup :
 * un salon qui a fait la même faute de frappe dans le HTML et dans le texte doit
 * la lire une fois, et corriger les deux dans la même passe.
 *
 * L'appariement des sections, lui, se vérifie **corps par corps**, et c'est une
 * différence de fond : un `{{#adresse}}` laissé ouvert dans le HTML n'est pas
 * refermé par un `{{/adresse}}` égaré dans le texte. Concaténer d'abord aurait
 * fait s'annuler deux fautes distinctes, et les deux balises seraient parties
 * telles quelles — l'une dans l'e-mail HTML, l'autre dans sa version texte.
 */
function assertPlaceholdersAreKnown(source: NotificationTemplateSource): void {
  const bodies = [source.subject, source.html, source.text];

  const unknown = unknownPlaceholders(bodies.join('\n'));
  const unbalanced = [...new Set(bodies.flatMap((body) => unbalancedSections(body)))].sort();

  if (unknown.length === 0 && unbalanced.length === 0) {
    return;
  }

  throw new NotificationTemplateInvalidError({
    ...(unknown.length === 0 ? {} : { unknownVariables: unknown }),
    ...(unbalanced.length === 0 ? {} : { unbalancedSections: unbalanced }),
  });
}

/**
 * Refuse un modèle d'e-mail sans objet.
 *
 * ## Pourquoi ici et non dans le DTO
 *
 * Parce que la contrainte **dépend du canal**, et qu'un décorateur de
 * `class-validator` ne connaît que le corps de la requête : le canal est dans le
 * chemin. Rendre `subject` obligatoire dans le DTO aurait refusé tous les
 * modèles de SMS, qui n'en ont pas ; le laisser facultatif sans ce contrôle
 * laisse passer `PUT …/booking_confirmation/email {"text":"…"}` — et chaque
 * confirmation part alors avec un en-tête `Subject` vide, ce que les filtres
 * anti-spam n'aiment pas et qu'aucune cliente ne sait relire dans sa boîte.
 *
 * ## Pourquoi `html` n'est **pas** exigé
 *
 * Un e-mail en texte seul est licite, et même plutôt bien vu des filtres. Ce que
 * le quatrième critère d'acceptation impose est l'inverse — que le texte
 * accompagne toujours le HTML —, et c'est `body_text` non nullable, plus le
 * `@MinLength(1)` du DTO, qui le tiennent.
 */
function assertChannelFieldsArePresent(
  channel: NotificationChannel,
  source: NotificationTemplateSource,
): void {
  if (channel !== 'EMAIL' || source.subject.trim().length > 0) {
    return;
  }

  throw new NotificationTemplateInvalidError({ missingFields: ['subject'] });
}

/**
 * Refuse un modèle de SMS qui coûterait plus que le plafond de segments.
 *
 * La mesure porte sur un **rendu de référence** et non sur la chaîne brute :
 * `{{date}}` fait huit caractères et en rendra trente-quatre. C'est le cinquième
 * critère d'acceptation de #69, et le seul qui se paie en argent — un accent hors
 * GSM-7 fait passer le message en UCS-2, donc de 160 caractères à 70, donc double
 * la facture (notifications §5).
 */
function assertSmsFitsBudget(
  channel: NotificationChannel,
  source: NotificationTemplateSource,
): void {
  if (channel !== 'SMS') {
    return;
  }

  const cost = measureSmsTemplate(source.text);

  if (cost.segments > SMS_MAX_SEGMENTS) {
    throw new NotificationTemplateTooLongError({
      encoding: cost.encoding,
      segments: cost.segments,
      maxSegments: SMS_MAX_SEGMENTS,
    });
  }
}
