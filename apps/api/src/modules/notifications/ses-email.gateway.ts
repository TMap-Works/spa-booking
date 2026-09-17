import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import type { SesSettings } from './notifications.config';

/**
 * La passerelle e-mail — la frontière du module avec SES (#799).
 *
 * ## Pourquoi une interface plutôt qu'un `SESv2Client` injecté
 *
 * Même raison que `reporting/export/report-export.storage.ts` : une seule
 * opération intéresse l'expéditeur, et un `SESv2Client` en offre soixante.
 * Réduire la surface est ce qui rend le double de test honnête — un faux qui
 * implémente une méthode reproduit *tout* ce que le vrai sait faire, alors qu'un
 * faux client SES reproduirait ce qu'on a pensé à reproduire. C'est ce que
 * notifications §8 exige en une phrase : « en test, SES et SNS sont bouchonnés —
 * aucun test n'envoie de vrai message ».
 *
 * ## Elle ne compose pas le message et ne choisit pas le destinataire
 *
 * Elle reçoit un corps déjà rendu et une adresse déjà relue. Une passerelle qui
 * saurait ce qu'est une confirmation de réservation aurait à changer à chaque
 * message ajouté ; celle-ci sert les trois du CDC §1.4 sans les connaître.
 *
 * ## Elle ne nomme aucun jeu de configuration, délibérément
 *
 * SES publie ses rebonds et ses plaintes par le jeu de configuration, et on
 * pourrait croire qu'il faut le nommer à chaque envoi sous peine de rompre la
 * chaîne de #73. Ce n'est pas le cas : `infra/terraform/modules/notifications`
 * rattache le jeu à l'**identité de domaine**, précisément pour que le routage
 * des événements soit « indépendant de la discipline de l'appelant »
 * (`identity.tf`). Le nommer ici ajouterait une variable d'environnement de plus
 * à tenir synchronisée avec Terraform, pour un comportement déjà acquis — et
 * c'est la valeur oubliée d'un côté qui ferait disparaître les rebonds.
 */

/** Ce qu'il faut pour écrire : une adresse, un objet, deux corps. */
export interface EmailToSend {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  /** Version texte brut — jamais omise, les filtres anti-spam la réclament. */
  readonly text: string;
}

export interface EmailGateway {
  /** Envoie, et rend le `MessageId` de SES. Lève si l'appel a échoué. */
  send(email: EmailToSend): Promise<string>;
}

/**
 * L'encodage annoncé à SES pour chaque partie du message.
 *
 * Explicite et non laissé au défaut : SES suppose `UTF-8` en SESv2, mais un
 * défaut supposé est un défaut qui change. Un « Rendez-vous confirmé » dont les
 * accents partiraient en `ISO-8859-1` arriverait illisible, et c'est le genre de
 * panne qu'on ne voit qu'en boîte de réception.
 */
const CHARSET = 'UTF-8';

/**
 * L'envoi réel — celui qui est servi dès qu'une adresse d'expéditeur est
 * configurée.
 *
 * ## Le client est construit une fois, à la première expédition
 *
 * Un `SESv2Client` tient une chaîne de résolution d'identifiants et un pool de
 * connexions : en fabriquer un par message ferait payer une résolution de rôle
 * de tâche à chaque e-mail, et ouvrirait autant de sockets. Il n'est pas
 * construit à l'amorçage pour autant — c'est la fabrique de l'expéditeur qui
 * décide quand, et elle attend le premier envoi (`notifications.config.ts`).
 *
 * ## Les identifiants ne sont jamais dans le code
 *
 * Aucune clé d'accès n'est lue, ni passée, ni journalisée : en déployé, le SDK
 * prend le **rôle de tâche ECS**, celui auquel le module Terraform attache sa
 * politique d'envoi. Même arbitrage que partout ailleurs dans le dépôt.
 */
export class SesEmailGateway implements EmailGateway {
  private readonly client: SESv2Client;

  private readonly fromEmail: string;

  public constructor(settings: SesSettings) {
    this.fromEmail = settings.fromEmail;
    // Composé plutôt que déclaré d'un bloc : sous `exactOptionalPropertyTypes`,
    // un `region: undefined` explicite n'est pas la même chose qu'une région
    // absente, et le SDK cesserait alors de la déduire de son environnement.
    this.client = new SESv2Client(settings.region === null ? {} : { region: settings.region });
  }

  public async send(email: EmailToSend): Promise<string> {
    const response = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.fromEmail,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: CHARSET },
            Body: {
              // Les deux, toujours. Un e-mail qui n'a que du HTML est pénalisé
              // par les filtres anti-spam, et le rappel J-1 perd son intérêt
              // s'il finit en indésirables (notifications §6).
              Text: { Data: email.text, Charset: CHARSET },
              Html: { Data: email.html, Charset: CHARSET },
            },
          },
        },
      }),
    );

    // SES rend toujours un `MessageId` sur un appel réussi ; le type du SDK le
    // déclare facultatif parce que la forme est partagée avec d'autres
    // opérations. Une réponse sans accusé est une anomalie du fournisseur, et
    // la traiter comme un succès inscrirait `SENT` avec une référence vide —
    // c'est-à-dire un envoi qu'on ne saurait plus retrouver chez AWS.
    if (response.MessageId === undefined || response.MessageId === '') {
      throw new Error("SES a accepté l'envoi sans rendre de MessageId.");
    }

    return response.MessageId;
  }
}
