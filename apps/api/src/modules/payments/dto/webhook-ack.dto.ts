import { ApiProperty } from '@nestjs/swagger';

/**
 * L'accusé de réception d'un webhook — tout ce que Stripe lit de notre réponse.
 *
 * Un DTO de sortie explicite, comme partout ailleurs (api-module §4), et
 * délibérément **vide de sens** : il ne dit ni si l'événement a été appliqué, ni
 * s'il était un rejeu, ni ce qu'il a changé. Deux raisons, et la seconde est la
 * vraie :
 *
 * 1. Stripe ne lit que le statut HTTP. Tout champ ajouté ici ne serait lu par
 *    personne.
 * 2. Le traitement n'a **pas encore eu lieu** quand cette réponse part : il est
 *    en file. Annoncer un résultat serait annoncer ce qu'on ne sait pas encore,
 *    et donnerait à qui sonde la route un oracle sur l'état de nos
 *    encaissements.
 *
 * Ce qui s'est réellement passé se lit dans le journal structuré, sous
 * `StripeWebhookService`, avec l'identifiant d'événement pour clé.
 */
export class WebhookAckDto {
  @ApiProperty({
    description: 'Toujours vrai : la livraison a été reçue et sa signature vérifiée.',
    example: true,
  })
  public readonly received!: boolean;

  public constructor(received: boolean) {
    this.received = received;
  }
}
