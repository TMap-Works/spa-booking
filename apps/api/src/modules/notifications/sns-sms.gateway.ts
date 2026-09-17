import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

import type { SnsSettings } from './notifications.config';

/**
 * La passerelle SMS — la frontière du module avec SNS (#799).
 *
 * Même forme et mêmes raisons que `ses-email.gateway.ts` : une interface d'une
 * méthode, un double de test honnête, aucune composition de message ici.
 *
 * ## Ce qu'elle pose sur chaque envoi, et pourquoi ce n'est pas décoratif
 *
 * Deux attributs de message, et l'un des deux est un critère d'acceptation :
 *
 * - **`AWS.SNS.SMS.SMSType = Transactional`**. Deux effets, dont le second est
 *   le moins connu (notifications §5) : la priorité de routage est supérieure —
 *   un opérateur remet un message transactionnel avant un promotionnel — et
 *   certains opérateurs **refusent** un message promotionnel hors plage horaire
 *   ou vers un numéro inscrit sur une liste d'opposition commerciale. Un rappel
 *   de rendez-vous classé `Promotional` serait donc perdu *sans erreur côté
 *   AWS*. Le CDC §1.4 borne le MVP à trois messages transactionnels ; aucun
 *   envoi de ce produit n'est promotionnel ;
 * - **`AWS.SNS.SMS.SenderID`**, le nom sous lequel le message s'affiche. Le
 *   module Terraform pose le même par défaut au niveau du **compte** ; le
 *   répéter par message n'est pas une redondance inutile, c'est ce qui rend
 *   l'envoi correct depuis un environnement dont le compte n'a pas encore reçu
 *   son réglage — `manage_sms_account_preferences` n'est vrai que dans un seul
 *   environnement, par construction.
 *
 * ## Elle ne normalise aucun numéro
 *
 * Elle reçoit un E.164 déjà validé. La normalisation vit dans le contrat
 * partagé (`normalizeToE164`), et le refus dans l'expéditeur, qui sait le
 * traduire en échec permanent. Une passerelle qui compléterait un indicatif
 * enverrait le rappel à quelqu'un d'autre.
 */

/** Ce qu'il faut pour émettre : un numéro E.164, un corps. */
export interface SmsToSend {
  /** Déjà normalisé — `+261341234567`. La passerelle ne vérifie pas, elle envoie. */
  readonly to: string;
  readonly text: string;
}

export interface SmsGateway {
  /** Émet, et rend le `MessageId` de SNS. Lève si l'appel a échoué. */
  send(sms: SmsToSend): Promise<string>;
}

/** Type de message SNS — jamais `Promotional`, voir l'en-tête. */
const TRANSACTIONAL = 'Transactional';

/**
 * L'émission réelle — servie dès qu'un sender ID est configuré.
 *
 * Le client est construit une fois, à la première expédition, et ne lit aucun
 * identifiant d'accès : en déployé, le SDK prend le rôle de tâche ECS, auquel le
 * module Terraform attache `sms_publisher_policy_arn`. Cette politique accorde
 * `sns:Publish` et **refuse** `sns:SetSMSAttributes` : une application capable
 * de relever son propre plafond de dépense rendrait le plafond décoratif.
 */
export class SnsSmsGateway implements SmsGateway {
  private readonly client: SNSClient;

  private readonly senderId: string;

  public constructor(settings: SnsSettings) {
    this.senderId = settings.senderId;
    // Composé plutôt que déclaré d'un bloc — même raison que dans la passerelle
    // e-mail : sous `exactOptionalPropertyTypes`, un `region: undefined`
    // explicite empêcherait le SDK de la déduire de son environnement.
    this.client = new SNSClient(settings.region === null ? {} : { region: settings.region });
  }

  public async send(sms: SmsToSend): Promise<string> {
    const response = await this.client.send(
      new PublishCommand({
        // `PhoneNumber` et non `TopicArn` : un SMS est une publication **à un
        // numéro**. C'est aussi pourquoi la politique IAM du module Terraform
        // porte `Resource = "*"` — il n'y a aucun ARN de topic à comparer.
        PhoneNumber: sms.to,
        Message: sms.text,
        MessageAttributes: {
          'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: TRANSACTIONAL },
          'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: this.senderId },
        },
      }),
    );

    // Même raisonnement que pour SES : une réponse sans accusé inscrirait `SENT`
    // avec une référence vide, c'est-à-dire un envoi qu'on ne saurait plus
    // retrouver — et que l'index d'idempotence interdirait pourtant de rejouer.
    if (response.MessageId === undefined || response.MessageId === '') {
      throw new Error("SNS a accepté l'envoi sans rendre de MessageId.");
    }

    return response.MessageId;
  }
}
