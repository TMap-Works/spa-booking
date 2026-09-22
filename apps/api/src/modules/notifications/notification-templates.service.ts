import { Injectable } from '@nestjs/common';
import { LOCALES, type Locale } from '@spa/shared';

import {
  measureSmsTemplate,
  renderNotification,
  smsReferenceVariables,
} from './notification-content';
import { defaultTemplateFor } from './notification-default-templates';
import {
  SMS_MAX_SEGMENTS,
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
  type NotificationTemplatePreview,
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
   * Tous les modèles **effectifs** de l'établissement, filtrables par langue.
   *
   * Un par triplet `(type, canal, langue)` qui en a un : vingt-deux par défaut
   * depuis #854 — cinq messages de rendez-vous sur deux canaux, plus la
   * réinitialisation en e-mail seulement, le tout dans deux langues. Un triplet
   * sans modèle du tout — un type ajouté à l'énumération sans son défaut, et que
   * le salon n'a pas écrit lui-même — n'apparaît pas : la liste répond à « que
   * reçoit ma cliente ? », et la réponse pour ce message est « rien ».
   *
   * `locale` absente rend **les deux langues**, et c'est le défaut délibéré : la
   * question que pose un écran de réglages est « qu'est-ce que mon salon envoie,
   * à qui », et la réponse est incomplète tant qu'une des deux langues manque.
   * Filtrer reste possible pour l'écran qui n'en édite qu'une.
   *
   * L'ordre est celui des énumérations — le même que celui du schéma, donc le
   * même d'un appel à l'autre. Une liste de configuration qui change d'ordre
   * fait bouger les lignes sous la souris.
   */
  public async list(locale?: Locale): Promise<readonly NotificationTemplateView[]> {
    const stored = await this.repository.findAll();
    const views: NotificationTemplateView[] = [];
    const locales = locale === undefined ? LOCALES : [locale];

    for (const type of NOTIFICATION_TYPES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        for (const wanted of locales) {
          const custom = stored.find(
            (row) => row.type === type && row.channel === channel && row.locale === wanted,
          );

          if (custom !== undefined) {
            views.push(view(type, channel, wanted, 'TENANT', custom.source, custom.updatedAt));
            continue;
          }

          const fallback = defaultTemplateFor(type, channel, wanted);

          if (fallback !== null) {
            views.push(view(type, channel, wanted, 'PLATFORM', fallback, null));
          }
        }
      }
    }

    return views;
  }

  /**
   * Le modèle effectif d'un message, dans une langue.
   *
   * @throws {NotificationTemplateNotFoundError} ni personnalisation, ni défaut —
   * dans **cette** langue. Le modèle de l'autre langue n'est jamais servi à sa
   * place (#854, quatrième critère).
   */
  public async get(
    type: NotificationType,
    channel: NotificationChannel,
    locale: Locale,
  ): Promise<NotificationTemplateView> {
    const custom = await this.repository.find(type, channel, locale);

    if (custom !== null) {
      return view(type, channel, locale, 'TENANT', custom.source, custom.updatedAt);
    }

    const fallback = defaultTemplateFor(type, channel, locale);

    if (fallback === null) {
      throw new NotificationTemplateNotFoundError(type, channel, locale);
    }

    return view(type, channel, locale, 'PLATFORM', fallback, null);
  }

  /**
   * Enregistre la personnalisation d'un message dans une langue, après l'avoir
   * validée.
   *
   * La validation précède l'écriture, jamais l'inverse : un modèle refusé ne doit
   * pas avoir touché la base, sans quoi un salon pourrait enregistrer un modèle
   * que le rendu refusera ensuite d'envoyer — et ses clientes n'auraient plus de
   * confirmation.
   *
   * ## La mesure du SMS se fait **dans la langue du modèle**
   *
   * C'est le septième critère d'acceptation de #854 : un modèle anglais est
   * mesuré contre le rendu de référence anglais, dont la date fait six caractères
   * de plus que la française. Le mesurer contre la référence française aurait
   * sous-estimé sa facture, ce qui est exactement ce que cette validation existe
   * pour éviter.
   */
  public async save(
    type: NotificationType,
    channel: NotificationChannel,
    locale: Locale,
    source: NotificationTemplateSource,
  ): Promise<NotificationTemplateView> {
    const normalized = normalize(channel, source);

    assertPlaceholdersAreKnown(normalized);
    assertChannelFieldsArePresent(channel, normalized);
    assertSmsFitsBudget(channel, locale, normalized);

    const saved = await this.repository.save(type, channel, locale, normalized);

    return view(type, channel, locale, 'TENANT', saved.source, saved.updatedAt);
  }

  /**
   * Rend l'établissement au modèle par défaut de la plateforme, pour cette
   * langue.
   *
   * L'autre langue n'est pas touchée : un salon qui efface son anglais garde son
   * français. C'est ce que rend possible la quatrième dimension de l'unique, et
   * ce serait d'ailleurs la seule conduite défendable — effacer les deux sur un
   * geste qui en nomme une serait une perte de contenu non demandée.
   *
   * Idempotent : effacer une personnalisation qui n'existe pas laisse le salon
   * dans l'état demandé. La réponse est le modèle **désormais** effectif, et non
   * un accusé vide — c'est ce qu'un écran a besoin d'afficher juste après le
   * clic.
   *
   * @throws {NotificationTemplateNotFoundError} le message n'a pas de défaut de
   * plateforme dans cette langue : effacer la personnalisation le laisserait sans
   * aucun modèle. L'effacement a **quand même** eu lieu — c'est ce que le salon a
   * demandé —, et le refus porte sur la lecture qui suit, pas sur le geste.
   */
  public async reset(
    type: NotificationType,
    channel: NotificationChannel,
    locale: Locale,
  ): Promise<NotificationTemplateView> {
    await this.repository.remove(type, channel, locale);

    return this.get(type, channel, locale);
  }

  /**
   * L'**aperçu** d'un modèle — #854, cinquième critère.
   *
   * ## Ce qu'il montre, et pourquoi la lecture ne suffisait pas
   *
   * Le message tel qu'il partirait : balises substituées, dates et montants
   * formatés dans la langue demandée, corps du SMS écourté comme il le sera.
   * Lire un modèle rend `{{date}}` ; l'aperçu rend « Wednesday, September 16,
   * 2026 at 2:30 PM ». C'est la seule façon de vérifier le troisième critère —
   * que le formatage suit la langue — sans envoyer un vrai message à une vraie
   * cliente.
   *
   * ## Avec brouillon, ou sans
   *
   * Sans corps, il rend le modèle **effectif** — celui qui partirait maintenant.
   * Avec un corps, il rend ce brouillon-là, **sans rien écrire** : c'est
   * l'aperçu d'avant l'enregistrement, celui qui évite d'apprendre par une
   * cliente qu'une section n'était pas refermée. Le brouillon traverse la même
   * validation que `save`, pour la raison qui rend l'aperçu utile : un aperçu
   * plus permissif que l'écriture montrerait un message que l'écriture refuse.
   *
   * ## Les valeurs sont celles de référence, jamais celles d'un rendez-vous
   *
   * `smsReferenceVariables` sert les deux canaux — le nom est hérité de son
   * premier usage, la mesure du coût d'un SMS, mais les valeurs se lisent comme
   * un rendez-vous plausible, enseigne comprise : c'est ce que cet usage-ci
   * exige. Employer un rendez-vous réel aurait exposé une cliente dans un
   * écran de configuration, pour un gain nul : ce qu'on vérifie est la forme du
   * message, pas le contenu d'une ligne d'agenda.
   */
  public async preview(
    type: NotificationType,
    channel: NotificationChannel,
    locale: Locale,
    draft?: NotificationTemplateSource,
  ): Promise<NotificationTemplatePreview> {
    const effective =
      draft === undefined
        ? await this.get(type, channel, locale)
        : validatedDraft(type, channel, locale, draft);

    return {
      type,
      channel,
      locale,
      origin: effective.origin,
      rendered: renderNotification(effective.source, smsReferenceVariables(locale), channel),
      sms: effective.sms,
    };
  }
}

/**
 * Un brouillon soumis à l'aperçu, passé au même crible que `save`.
 *
 * Il est marqué `TENANT` : c'est bien le salon qui l'écrit, même s'il ne
 * l'enregistre pas encore. Annoncer `PLATFORM` aurait laissé croire à l'écran
 * qu'il regarde le défaut.
 */
function validatedDraft(
  type: NotificationType,
  channel: NotificationChannel,
  locale: Locale,
  draft: NotificationTemplateSource,
): NotificationTemplateView {
  const normalized = normalize(channel, draft);

  assertPlaceholdersAreKnown(normalized);
  assertChannelFieldsArePresent(channel, normalized);
  assertSmsFitsBudget(channel, locale, normalized);

  return view(type, channel, locale, 'TENANT', normalized, null);
}

/** Un modèle effectif, sa provenance, et ce qu'il coûtera s'il part en SMS. */
function view(
  type: NotificationType,
  channel: NotificationChannel,
  locale: Locale,
  origin: NotificationTemplateView['origin'],
  source: NotificationTemplateSource,
  updatedAt: Date | null,
): NotificationTemplateView {
  return {
    type,
    channel,
    locale,
    origin,
    source,
    updatedAt,
    sms: smsCost(channel, locale, source),
  };
}

/**
 * Le coût mesuré du modèle, sur le canal où il en a un, dans sa langue.
 *
 * `null` sur l'e-mail : un e-mail long ne coûte rien de plus, et rendre un
 * chiffre là où il n'y a pas de facture inviterait à l'optimiser.
 */
function smsCost(
  channel: NotificationChannel,
  locale: Locale,
  source: NotificationTemplateSource,
): SmsCost | null {
  return channel === 'SMS' ? measureSmsTemplate(source.text, locale) : null;
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
  locale: Locale,
  source: NotificationTemplateSource,
): void {
  if (channel !== 'SMS') {
    return;
  }

  const cost = measureSmsTemplate(source.text, locale);

  if (cost.segments > SMS_MAX_SEGMENTS) {
    throw new NotificationTemplateTooLongError({
      encoding: cost.encoding,
      segments: cost.segments,
      maxSegments: SMS_MAX_SEGMENTS,
    });
  }
}
