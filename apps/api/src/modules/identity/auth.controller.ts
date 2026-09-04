import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { AppConfigService } from '../../config/app-config.service';
import { Auth } from './auth.decorator';
import { AuthService } from './auth.service';
import {
  AcceptInvitationDto,
  AuthTokensDto,
  LoginDto,
  RegisterDto,
  UserProfileDto,
} from './dto/auth.dto';
import type { AuthenticationResult } from './identity.types';
import { CurrentUser } from './jwt-auth.guard';
import type { AuthenticatedUser } from './identity.types';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';

/**
 * Points d'entrée d'authentification. Traduit HTTP ↔ service, et **rien
 * d'autre** : aucune règle métier ici (api-module §2).
 *
 * ## Limitation de débit
 *
 * `ThrottlerGuard` couvre tout le contrôleur, et les quotas sont resserrés là où
 * ils comptent. Sans elle, un formulaire de connexion est un oracle qu'on
 * interroge à la vitesse du réseau : bcrypt coût 12 rend le forçage *hors ligne*
 * coûteux, il ne fait rien contre le forçage *en ligne*, où c'est notre propre
 * serveur qui paie le hachage.
 *
 * Le compteur est par adresse IP — ce que `@nestjs/throttler` sait faire sans
 * état partagé. Ce n'est pas une protection complète : un attaquant distribué la
 * contourne. Elle arrête ce qu'elle doit arrêter à ce stade — le forçage depuis
 * une seule origine — et le durcissement par compte, avec compteur en Redis,
 * demandera le stockage partagé que le MVP n'a pas encore câblé.
 */
@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
@UseGuards(ThrottlerGuard)
export class AuthController {
  public constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Inscription client.
   *
   * Plus serré que la connexion : cinq comptes par minute et par IP suffisent
   * largement à un usage réel, et bornent la création de comptes en masse.
   */
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Inscrire un client et ouvrir sa session' })
  @ApiOkResponse({ type: AuthTokensDto })
  public async register(
    @Body() body: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    const result = await this.auth.register({
      tenantSlug: body.tenantSlug,
      email: body.email,
      password: body.password,
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
    });

    return this.respondWithSession(response, result);
  }

  /**
   * Connexion — clients, staff et administrateurs.
   *
   * Dix tentatives par minute et par IP : au-delà, ce n'est plus quelqu'un qui se
   * trompe de mot de passe.
   */
  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ouvrir une session' })
  @ApiOkResponse({ type: AuthTokensDto })
  public async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    const result = await this.auth.login({
      tenantSlug: body.tenantSlug,
      email: body.email,
      password: body.password,
    });

    return this.respondWithSession(response, result);
  }

  /**
   * Première connexion d'un membre du personnel invité — #55.
   *
   * Publique, et elle ne peut pas être autrement : la personne invitée n'a pas
   * encore de mot de passe, donc pas de jeton d'accès. Ce qui l'autorise est
   * l'invitation elle-même — un jeton signé, à usage unique, qui ne vaut que pour
   * poser le **premier** mot de passe du compte qu'il désigne.
   *
   * Cinq tentatives par minute et par IP, comme l'inscription : le jeton porte
   * 256 bits de signature, il ne se devine pas, et cette limite borne surtout le
   * coût du bcrypt qu'un corps valide nous ferait payer.
   *
   * **200** et non 201 : rien n'est créé — le compte existait déjà, il est
   * activé. La réponse est celle d'une connexion, cookie de rafraîchissement
   * compris, pour que la personne n'ait pas à ressaisir le mot de passe qu'elle
   * vient de choisir.
   *
   * **401** sur tout refus, sans jamais dire lequel : jeton contrefait, expiré,
   * compte inconnu, désactivé, ou déjà activé.
   */
  @Post('invitations/accept')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activer un compte invité et ouvrir sa session' })
  @ApiOkResponse({ type: AuthTokensDto })
  public async acceptInvitation(
    @Body() body: AcceptInvitationDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    const result = await this.auth.acceptInvitation({
      token: body.token,
      password: body.password,
    });

    return this.respondWithSession(response, result);
  }

  /**
   * Rotation du jeton de rafraîchissement.
   *
   * Le jeton est lu dans le cookie et **jamais** dans le corps : un jeton qu'on
   * pourrait poster est un jeton que JavaScript peut lire, ce qui annulerait
   * `httpOnly`. Le corps de cette route est vide, et le `ValidationPipe` global
   * rejetterait tout champ qu'on y glisserait.
   */
  @Post('refresh')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renouveler le jeton d’accès depuis le cookie de session' })
  @ApiOkResponse({ type: AuthTokensDto })
  public async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthTokensDto> {
    // Le cookie absent n'a pas de branche à lui : il entre dans le service comme
    // une chaîne vide, y échoue à la vérification cryptographique, et produit
    // donc exactement la réponse d'un jeton invalide.
    const result = await this.auth.refresh(readRefreshCookie(request) ?? '');
    return this.respondWithSession(response, result);
  }

  /**
   * Déconnexion — révoque la session **en base** et efface le cookie.
   *
   * Répond toujours 204, y compris sans cookie ou avec un jeton illisible : le
   * résultat voulu est déjà atteint, et un échec n'apprendrait au client que ce
   * qu'il ne doit pas savoir.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Fermer la session et révoquer son jeton de rafraîchissement' })
  public async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(request));
    clearRefreshCookie(response, { secure: this.config.isDeployed });
  }

  /**
   * Le compte porté par le jeton d'accès.
   *
   * `userId` vient de `@CurrentUser()`, donc d'un jeton vérifié — jamais d'un
   * paramètre d'URL. Une route `/users/:id` qui accepterait l'identifiant en
   * chemin serait la première fuite à écrire.
   */
  @Get('me')
  // `@Auth()` sans argument : toute identité vérifiée, quel que soit son rôle.
  // Lire son propre compte n'est pas un privilège, et la restreindre priverait
  // la clientèle de la seule route qui lui rend son profil.
  @Auth()
  @ApiOperation({ summary: 'Lire le compte authentifié' })
  @ApiOkResponse({ type: UserProfileDto })
  public async me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfileDto> {
    return this.auth.profileOf(user.userId);
  }

  /**
   * Pose le cookie de rafraîchissement et ne rend que ce qui peut l'être.
   *
   * Écrit en un seul endroit : c'est ce qui garantit que le jeton de
   * rafraîchissement ne part jamais dans un corps de réponse par distraction.
   */
  private respondWithSession(response: Response, result: AuthenticationResult): AuthTokensDto {
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
