import { Module } from '@nestjs/common';

import { NotificationDispatchService } from './notification-dispatch.service';
import { NOTIFICATION_SENDER, UnconfiguredNotificationSender } from './notification-sender';
import { NotificationsRepository } from './notifications.repository';

/**
 * Module `notifications` — confirmations, rappels J-1, avis d'annulation
 * (CDC §2.3, §1.4).
 *
 * #68 en pose le socle et rien d'autre : la table, l'ordre d'écriture et
 * l'idempotence des envois. Le contenu des messages, les modèles par
 * établissement, les passerelles SES et SNS et la Lambda d'envoi viennent avec
 * leurs propres tickets.
 *
 * ## Il n'importe aucun module métier
 *
 * Ni `appointments`, ni `crm`, ni `identity`. C'est délibéré, et c'est la forme
 * qu'api-module §3 prescrit : `appointments` émet un événement de domaine, et
 * c'est `notifications` qui s'y abonnera — jamais l'inverse, et jamais par un
 * import de repository. Toutes ses dépendances (client Prisma scopé, contexte de
 * tenant, journal structuré) viennent de modules `@Global()`.
 *
 * ## Il n'est pas encore inscrit dans `app.module.ts`
 *
 * Faute de route à servir : #68 n'ouvre aucun contrôleur, et un module sans
 * surface HTTP n'a rien à apporter au graphe de l'application. C'est la conduite
 * qu'ont eue `availability` (#41) et `appointments` (#31) avant d'avoir leur
 * premier endpoint — le module existe, il est testé, il rejoint le graphe le
 * jour où quelque chose l'appelle.
 *
 * ## Il n'exige aucune variable d'environnement pour démarrer
 *
 * Aucune configuration AWS n'est lue ici. `NOTIFICATION_SENDER` est branché par
 * défaut sur `UnconfiguredNotificationSender`, qui refuse tout envoi en 503 —
 * le même régime que `payments` sans clés Stripe. Le refus laisse la ligne en
 * `FAILED`, donc reprenable dès qu'un expéditeur réel prend sa place ; c'est ce
 * qu'un faux succès aurait rendu impossible.
 */
@Module({
  providers: [
    NotificationsRepository,
    NotificationDispatchService,
    // Le port d'expédition. Un ticket ultérieur remplacera ce fournisseur par
    // les passerelles SES et SNS ; rien d'autre du module n'aura à changer, et
    // c'est tout l'intérêt d'avoir nommé la frontière.
    { provide: NOTIFICATION_SENDER, useClass: UnconfiguredNotificationSender },
  ],
  exports: [NotificationDispatchService],
})
export class NotificationsModule {}
