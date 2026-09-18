import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BillingRedirect, TenantBilling } from '@spa/shared';

import { AuthWith } from '../../identity/auth.decorator';
import type { AuthenticatedUser } from '../../identity/identity.types';
import { CurrentUser } from '../../identity/jwt-auth.guard';
import { AllowUnpaidTenant } from '../../identity/tenant-billing.guard';
import { BillingService } from './billing.service';

/**
 * L'abonnement du salon — ADR 0016.
 *
 * Réservé à l'administrateur (`settings:write`, la permission des réglages du
 * salon), et **ouvert même quand l'abonnement est inactif** : c'est la seule
 * porte par laquelle un salon fermé peut se rouvrir.
 */
@ApiTags('billing')
@Controller({ path: 'billing', version: '1' })
@AuthWith('settings:write')
@AllowUnpaidTenant()
export class BillingController {
  public constructor(private readonly billing: BillingService) {}

  /** L'état de l'abonnement, relu chez Stripe quand il y a de quoi. */
  @Get('subscription')
  @ApiOperation({ summary: 'Lire l’abonnement du salon' })
  @ApiOkResponse({ description: 'Statut, fin d’essai, prochaine échéance.' })
  public async subscription(@CurrentUser() user: AuthenticatedUser): Promise<TenantBilling> {
    return this.billing.current(user.tenantId);
  }

  /** Ouvre la page de paiement Stripe : l'essai gratuit, carte enregistrée. */
  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ouvrir le paiement de l’abonnement (Stripe Checkout)' })
  @ApiCreatedResponse({ description: 'L’adresse de la page de paiement hébergée par Stripe.' })
  @ApiConflictResponse({ description: 'Salon géré par la plateforme, ou abonnement déjà en cours.' })
  public async checkout(@CurrentUser() user: AuthenticatedUser): Promise<BillingRedirect> {
    return this.billing.startCheckout(user.tenantId);
  }

  /** Le portail client de Stripe : carte, factures, résiliation. */
  @Post('portal')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ouvrir le portail de gestion de l’abonnement' })
  @ApiCreatedResponse({ description: 'L’adresse du portail hébergé par Stripe.' })
  @ApiConflictResponse({ description: 'Aucun moyen de paiement enregistré.' })
  public async portal(): Promise<BillingRedirect> {
    return this.billing.openPortal();
  }
}
