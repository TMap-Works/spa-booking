import { ProgressBar } from '@/components/ui/progress-bar';

/** Deux cartes : ce qu'une cliente a d'ordinaire à venir. */
const SKELETON_CARDS = [1, 2] as const;

/**
 * La liste des rendez-vous, le temps qu'elle arrive (#830).
 *
 * Il s'affiche **sous** le gabarit du compte : l'en-tête, la barre du compte et
 * la région d'annonce restent en place. Le gabarit résout l'établissement avant
 * lui — un slug inconnu répond donc toujours 404 avant qu'un squelette soit
 * envoyé.
 *
 * ## Pourquoi sous `(liste)/` et non sur tout `compte/`
 *
 * Un squelette part avec l'en-tête de réponse, avant la page. Posé sur `compte/`,
 * il enveloppait aussi le report d'un rendez-vous, dont le `notFound()` doit
 * répondre 404 (`rendez-vous/[appointmentId]/report/not-found.tsx`) et ne
 * l'aurait plus pu. Le groupe ne change pas l'URL — la liste reste `/compte` —
 * et donne à la liste un dossier où poser son squelette sans envelopper ses
 * voisins. Il a sa forme à elle : les autres écrans de l'espace ne sont pas des
 * listes, et n'ont que la barre de progression.
 *
 * `aria-busy` et une phrase masquée, comme le squelette du tunnel ; la barre de
 * progression prend le relais de celle du clic (`components/ui/progress-bar.tsx`).
 * La forme et ses mesures sont décrites dans `styles/components/account.css`.
 */
export default function AccountLoading() {
  return (
    <div aria-busy="true" className="spa-account__section spa-account-loading">
      <ProgressBar />
      <p className="spa-visually-hidden">Chargement de votre espace…</p>
      <div className="spa-account__section-heading">
        <span className="spa-skeleton spa-account-loading__title" />
        <span className="spa-skeleton spa-account-loading__hint" />
      </div>
      <div className="spa-appointment-list">
        {SKELETON_CARDS.map((card) => (
          <div className="spa-appointment" key={card}>
            <span className="spa-skeleton spa-account-loading__line" />
            <span className="spa-skeleton spa-account-loading__line spa-account-loading__line--short" />
          </div>
        ))}
      </div>
    </div>
  );
}
