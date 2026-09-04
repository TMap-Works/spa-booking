/**
 * Forme canonique d'une adresse e-mail — minuscules, sans espaces de bord.
 *
 * Écrite **une fois**, et hors des services : la règle doit être identique à
 * l'écriture (inscription client, invitation d'un membre du personnel) et à la
 * lecture (`/auth/login`), faute de quoi elle ne sert à rien. L'unique du schéma
 * — `@@unique([tenantId, email])` — porte sur les octets : une ligne écrite
 * `Alice@Lilas.test` serait prise et pourtant introuvable par une connexion qui,
 * elle, normalise. Deux copies de cette fonction dans deux services, c'est
 * exactement la divergence qui produit ce compte inconnectable.
 *
 * Un module autonome plutôt qu'un membre statique partagé : `UsersService` n'a
 * aucune raison de dépendre d'`AuthService` pour la normalisation d'une chaîne.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
