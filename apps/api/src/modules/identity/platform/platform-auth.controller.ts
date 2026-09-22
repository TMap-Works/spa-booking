import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { IdentityThrottlerGuard, ThrottleByTarget } from '../identity-throttler.guard';
import { PlatformLoginDto, PlatformSessionDto } from './dto/platform.dto';
import { PlatformService } from './platform.service';

/**
 * L'entrée de la console de l'éditeur — #806, critère 1.
 *
 * ## Pourquoi une seconde route de connexion
 *
 * Parce que l'espace plateforme n'est pas un rôle de plus dans `users`
 * (ADR 0012). `POST /auth/login` résout un établissement par son slug, lit un
 * compte `users` dans cette portée, et rend un jeton porteur d'un `tenantId`.
 * Rien de tout cela n'a de sens pour un opérateur, qui n'appartient à aucun
 * salon — et tordre cette route pour qu'elle serve les deux aurait mis les deux
 * espaces derrière la même porte, donc derrière le même défaut.
 *
 * ## Limitation de débit
 *
 * Cinq tentatives par minute et par **opérateur visé** — deux fois plus strict
 * que la connexion d'un salon, et pour deux raisons. La console compte quelques
 * opérateurs, là où un salon compte des clientes : un humain qui se trompe n'a
 * pas besoin de dix essais. Et ce qu'une réussite ouvre — l'ouverture
 * d'établissements au nom de la plateforme — ne se compare pas à ce qu'ouvre la
 * connexion d'une cliente.
 *
 * Le compteur portait sur l'adresse IP, avec le même angle mort que le
 * contrôleur d'authentification : la console appelle l'API par une action
 * serveur, si bien que le quota valait pour le produit entier plutôt que par
 * opérateur — cinq essais par minute pour toute la console, et le sixième
 * opérateur de la matinée refusé. #1127 le rattache à la **cible**, ici
 * l'adresse e-mail seule : il n'y a pas d'établissement à joindre, un opérateur
 * n'appartenant à aucun salon (ADR 0012). Voir `identity-throttler.guard.ts`.
 *
 * Le **second facteur** rend de toute façon la fenêtre peu intéressante :
 * forcer le mot de passe ne suffit pas à entrer.
 */
@ApiTags('platform')
@Controller({ path: 'platform/auth', version: '1' })
@UseGuards(IdentityThrottlerGuard)
export class PlatformAuthController {
  public constructor(private readonly platform: PlatformService) {}

  /**
   * Ouvre une session de console — mot de passe **et** code TOTP.
   *
   * **200** et non 201 : rien n'est créé, aucune ligne de session n'est écrite.
   * Le jeton rendu est le seul état de cette connexion, et il expire de
   * lui-même.
   *
   * **401** sur tout refus, sans jamais dire lequel : adresse inconnue, mot de
   * passe faux, code faux, compte désactivé.
   */
  @Post('login')
  @ThrottleByTarget({ account: 'email' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ouvrir une session de console plateforme (MFA exigée)' })
  @ApiOkResponse({ type: PlatformSessionDto })
  @ApiUnauthorizedResponse({
    description: 'Identifiants ou code de vérification invalides — la cause n’est jamais dite.',
  })
  public async login(@Body() body: PlatformLoginDto): Promise<PlatformSessionDto> {
    return this.platform.login({
      email: body.email,
      password: body.password,
      totpCode: body.totpCode,
    });
  }
}
