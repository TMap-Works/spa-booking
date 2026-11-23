/**
 * Pré-remplit le formulaire d'inscription ou de connexion avec ce que la
 * personne vient de dire au chat.
 *
 * Il pose des valeurs, rien d'autre : pas de mot de passe (aucun champ de ce
 * genre n'est visé), pas de validation (le bouton reste à la personne), et
 * seulement les champs de la liste ci-dessous, repérés par leur identifiant —
 * un champ inconnu, ou absent de l'écran, est simplement ignoré.
 */

export type ChampFormulaire = 'prenom' | 'nom' | 'email' | 'telephone';

/** Les identifiants des champs de `register-form` et `login-form`, dans l'ordre d'essai. */
const CHAMPS: Readonly<Record<ChampFormulaire, readonly string[]>> = {
  prenom: ['register-first-name'],
  nom: ['register-last-name'],
  email: ['register-email', 'login-email'],
  telephone: ['register-phone'],
};

/** Les écrans où il agit : jamais ailleurs, même si un champ de même identifiant existait. */
export function isAuthPath(pathname: string, tenantSlug: string): boolean {
  return pathname === `/${tenantSlug}/compte/inscription` || pathname === `/${tenantSlug}/compte/connexion`;
}

export interface Remplissage {
  /** Les champs posés. */
  readonly remplis: ChampFormulaire[];
  /** Les champs demandés mais absents de l'écran. */
  readonly absents: ChampFormulaire[];
}

export function remplirFormulaire(
  valeurs: { readonly [champ in ChampFormulaire]?: string | undefined },
  root: ParentNode = document,
): Remplissage {
  const remplis: ChampFormulaire[] = [];
  const absents: ChampFormulaire[] = [];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  for (const champ of Object.keys(CHAMPS) as ChampFormulaire[]) {
    const valeur = valeurs[champ];
    if (valeur === undefined) continue;
    const input = CHAMPS[champ]
      .map((id) => root.querySelector<HTMLInputElement>(`input#${id}`))
      .find((element): element is HTMLInputElement => element !== null);
    if (input === undefined || input === null || setter === undefined) {
      absents.push(champ);
      continue;
    }
    // Le setter natif, puis l'événement : c'est ce que React et react-hook-form écoutent.
    setter.call(input, valeur);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    remplis.push(champ);
  }
  return { remplis, absents };
}
