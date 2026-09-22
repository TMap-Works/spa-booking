import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { salonSignupRequestSchema } from '@spa/shared';
import type { Response } from 'express';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import { AppConfigService } from '../../../config/app-config.service';
import { AuthTokensDto } from '../dto/auth.dto';
import { setRefreshCookie } from '../refresh-cookie';
import { SignupService } from './signup.service';

const signupBody = new ZodValidationPipe(salonSignupRequestSchema);

type SignupBody = z.output<typeof salonSignupRequestSchema>;

/**
 * `POST /v1/signup` — un salon s'inscrit seul (ADR 0016).
 *
 * Publique : la personne n'a encore ni compte ni salon. Rend la session de son
 * compte administrateur, exactement comme l'inscription d'une cliente — cookie
 * de rafraîchissement compris —, pour que le paiement de l'essai s'enchaîne
 * sans nouvelle connexion.
 *
 * Trois inscriptions par minute et par IP : un salon s'inscrit une fois, et ce
 * plafond borne la création de salons en masse.
 *
 * ## Pourquoi cette route garde son compteur d'adresse (#1127)
 *
 * Elle partage l'angle mort des routes d'authentification — le front l'appelle
 * par une action serveur, donc l'adresse vue est celle de la tâche ECS et le
 * quota vaut pour le produit entier. Elle n'en tire pas la même conclusion, et
 * c'est délibéré : il n'y a **aucune cible** à compter ici. L'établissement
 * n'existe pas encore, et le compte non plus — les deux sont ce que l'appel
 * crée. Le seul compteur possible serait l'adresse e-mail demandée, qu'un
 * créateur en masse varie à chaque essai, et qui ne bornerait donc rien.
 *
 * Trois créations de salon par minute pour la plateforme est par ailleurs un
 * frein assumé et non un rationnement : un salon s'inscrit une fois dans sa vie,
 * là où un gérant se connecte tous les matins. Voir
 * `../identity-throttler.guard.ts` pour le cas inverse.
 */
@ApiTags('signup')
@Controller({ path: 'signup', version: '1' })
@UseGuards(ThrottlerGuard)
export class SignupController {
  public constructor(
    private readonly signup: SignupService,
    private readonly config: AppConfigService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Inscrire un salon et ouvrir la session de son administrateur' })
  @ApiCreatedResponse({ type: AuthTokensDto })
  @ApiBadRequestResponse({ description: 'Corps invalide — le champ fautif est nommé.' })
  @ApiConflictResponse({ description: 'Cette adresse web est déjà prise ou réservée.' })
  public async create(
    @Body(signupBody) body: SignupBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    const result = await this.signup.signup({
      slug: body.slug,
      name: body.name,
      timezone: body.timezone,
      defaultCurrency: body.defaultCurrency,
      // Facultative dans le corps : le salon qui ne se prononce pas s'ouvre en
      // anglais (#844).
      defaultLocale: body.defaultLocale,
      countryCode: body.countryCode,
      addressLine1: body.addressLine1,
      addressLine2: body.addressLine2 ?? null,
      postalCode: body.postalCode ?? null,
      city: body.city,
      adminEmail: body.adminEmail,
      adminFirstName: body.adminFirstName,
      adminLastName: body.adminLastName,
      password: body.password,
      dataConsent: body.dataConsent,
    });

    setRefreshCookie(response, result.refreshToken, {
      secure: this.config.isDeployed,
      maxAgeSeconds: result.refreshTokenMaxAge,
    });

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: { ...result.user },
    };
  }
}
