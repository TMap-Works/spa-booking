import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';

import { AppConfigService } from '../../config/app-config.service';

/**
 * Hachage et vérification des mots de passe — bcrypt, coût lu dans la
 * configuration (`BCRYPT_COST`, 12 par défaut).
 *
 * bcrypt plutôt qu'argon2id : l'issue autorise les deux (« argon2id ou bcrypt à
 * coût suffisant »), et bcrypt est ici en JavaScript pur (`bcryptjs`). Ce détail
 * n'est pas cosmétique — `argon2` est un module natif, qui exige une chaîne de
 * compilation dans l'image Docker et se recompile à chaque changement d'ABI Node.
 * Pour un MVP déployé sur ECS Fargate, la dépendance native coûte plus qu'elle ne
 * rapporte face à bcrypt coût 12.
 *
 * Le sel est **par mot de passe** et vit dans l'empreinte elle-même : c'est
 * bcrypt qui le tire et le préfixe, il n'y a donc ni colonne ni secret de sel à
 * gérer. Deux comptes partageant le même mot de passe ont des empreintes
 * différentes.
 */
@Injectable()
export class PasswordHasher {
  public constructor(private readonly config: AppConfigService) {}

  public async hash(plaintext: string): Promise<string> {
    return hash(plaintext, this.config.bcryptCost);
  }

  /**
   * Vérifie un mot de passe contre une empreinte — ou contre **rien**.
   *
   * `passwordHash` est nullable dans le schéma : un client saisi au comptoir par
   * le staff existe sans jamais avoir choisi de mot de passe. Sans le cas `null`
   * traité ici, `bcrypt.compare` recevrait `undefined` et lèverait, ce qui
   * distinguerait ce compte des autres par un 500 — un oracle qui désigne
   * précisément les comptes sans mot de passe.
   *
   * Le hachage factice n'est pas une précaution de style : sans lui, un compte
   * sans mot de passe répondrait immédiatement là où un compte normal paie ~250 ms
   * de bcrypt, et la différence de temps se mesure depuis l'extérieur.
   */
  public async verify(plaintext: string, passwordHash: string | null): Promise<boolean> {
    if (passwordHash === null) {
      await this.burnComparableTime(plaintext);
      return false;
    }
    return compare(plaintext, passwordHash);
  }

  /**
   * Consomme le temps d'un hachage réel, sans rien vérifier.
   *
   * Appelé quand aucune empreinte n'est disponible — compte inexistant, compte
   * sans mot de passe — pour que la connexion échoue au **même rythme** dans tous
   * les cas. Sans cela, la durée de la réponse dit si l'adresse existe dans cet
   * établissement, et l'énumération que le message d'erreur unique interdit se
   * refait au chronomètre.
   */
  public async burnComparableTime(plaintext: string): Promise<void> {
    await hash(plaintext, this.config.bcryptCost);
  }
}
